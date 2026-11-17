import {
  EntitlementController,
  type Entitlement,
} from "../entitlements/controller";
import type {
  CoachInput,
  CoachReply,
  CoachOverview,
  CoachQuota,
} from "../coach/types";
import type { Input, Quota, Reply } from "./types";
import type {
  RealtimeInput,
  RealtimeReply,
  RealtimeQuota,
} from "./realtime-types";
export interface TokenStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public quota?: Quota | RealtimeQuota | CoachQuota,
    public retryAfter?: number,
  ) {
    super(code);
  }
}
export class AnalysisConfigurationError extends Error {}
/** 端末登録は同時に一度だけ。401でも証明とひも付くトークンを勝手に作り直さない。 */
export class AnalysisClient {
  private token: Promise<string> | undefined;
  readonly access: EntitlementController;
  constructor(
    private base: string,
    private store: TokenStore,
    private http: typeof fetch = (url, init) => fetch(url, init),
    allowDevelopment = false,
  ) {
    this.access = new EntitlementController(this, allowDevelopment);
  }
  entitlements = (): Promise<Entitlement> => this.request("/v1/entitlements");
  redeem = (code: string): Promise<Entitlement> =>
    this.request("/v1/invitations/redeem", "POST", { code });
  private async requirePaid() {
    if (!(await this.access.refresh()).paid)
      throw new ApiError(403, "paid_required");
  }
  private async request(
    path: string,
    method = "GET",
    body?: object,
    auth = true,
    headers: Record<string, string> = {},
  ): Promise<any> {
    if (!this.base)
      throw new AnalysisConfigurationError("解析サーバーの接続先が未設定です");
    if (
      !/^https:\/\//.test(this.base) &&
      !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(this.base)
    )
      throw new AnalysisConfigurationError("解析の接続先はHTTPSにしてください");
    const token = auth ? await this.getToken() : null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await this.http(this.base + path, {
        method,
        signal: controller.signal,
        headers: {
          ...headers,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body
          ? {
              body: JSON.stringify(body),
            }
          : {}),
      });
      const data = await response.json();
      if (!response.ok)
        throw new ApiError(
          response.status,
          data.error || "server_error",
          data.quota,
          retryAfterSeconds(response.headers.get("Retry-After")),
        );
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
  private getToken() {
    return (this.token ??= (async () => {
      const old = await this.store.get();
      if (old) return old;
      const data = await this.request("/v1/devices", "POST", undefined, false);
      if (!/^[a-f0-9]{64}$/.test(data.token))
        throw new Error("端末の登録応答を読めません");
      await this.store.set(data.token);
      return data.token as string;
    })().catch((e) => {
      this.token = undefined;
      throw e;
    }));
  }
  coach = async (): Promise<CoachOverview> => {
    const [reply, entitlement] = await Promise.all([
      this.request("/v1/coach"),
      this.access.refresh(),
    ]);
    return { ...reply, paid: entitlement.paid };
  };
  createCoach = (input: CoachInput): Promise<CoachReply> =>
    this.requirePaid().then(() =>
      this.request("/v1/coach", "POST", input, true, {
        Prefer: "respond-async",
      }),
    );
  getCoach = (id: string): Promise<CoachReply> =>
    this.request(`/v1/coach/${encodeURIComponent(id)}`);
  cancelCoach = async (id: string): Promise<CoachReply> => {
    await this.request(`/v1/coach/${encodeURIComponent(id)}`, "DELETE");
    // 中止の応答はstatus/quotaだけの場合がある。成功との競合もGETで確定する。
    return this.getCoach(id);
  };
  quota = (): Promise<Quota> => this.request("/v1/quota");
  // 応答不明の回収は事前照会をせず、サーバーの重複判定を権利検査より先に行う。
  create = (input: Input, recovering = false): Promise<Reply> =>
    (input.mode === "precise" && !recovering
      ? this.requirePaid()
      : Promise.resolve()
    ).then(() =>
      this.request("/v1/jobs", "POST", {
        initial: input.initial,
        moves: input.moves,
        mode: input.mode,
      }),
    );
  get = (id: string, from: number): Promise<Reply> =>
    this.request(`/v1/jobs/${encodeURIComponent(id)}?from=${from}`);
  realtime = async (): Promise<RealtimeReply> => {
    const reply = await this.request("/v1/realtime");
    // 350msの進捗取得ごとに権利GETを重ねず、変更の兆候があるときだけ再確認する。
    if (
      !this.access.snapshot.checked ||
      reply.paid !== this.access.snapshot.entitlement.paid
    )
      await this.access.refresh();
    return { ...reply, paid: this.access.snapshot.entitlement.paid };
  };
  startRealtime = (input: RealtimeInput): Promise<RealtimeReply> =>
    this.requirePaid().then(() =>
      this.request("/v1/realtime", "POST", {
        initial: input.initial,
        moves: input.moves,
      }),
    );
  updateRealtime = (
    id: string,
    input: RealtimeInput,
    sequence: number,
  ): Promise<RealtimeReply> =>
    this.requirePaid().then(() =>
      this.request(`/v1/realtime/${encodeURIComponent(id)}`, "PUT", {
        initial: input.initial,
        moves: input.moves,
        sequence,
      }),
    );
  stopRealtime = (id: string): Promise<RealtimeReply> =>
    this.request(`/v1/realtime/${encodeURIComponent(id)}`, "DELETE");
  cancel = (id: string): Promise<Reply> =>
    this.request(`/v1/jobs/${encodeURIComponent(id)}`, "DELETE");
}
export function errorText(error: unknown) {
  if (error instanceof AnalysisConfigurationError) return error.message;
  if (!(error instanceof ApiError))
    return "通信できません。つながると解析できます";
  return (
    (
      {
        401: "端末の登録を確認できません。データは消さずにお問い合わせください",
        403: "精密解析は、有料プランで使えます",
        404: "サーバーの解析の保存期間が過ぎました。もう一度解析できます",
        413: "棋譜が長すぎます。解析は512手までです",
        429: "今週の解析は使い切りました",
      } as Record<number, string>
    )[error.status] ||
    "解析を終えられませんでした。回数は減っていません。もう一度試せます"
  );
}

export function retryAfterSeconds(value: string | null, now = Date.now()) {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : undefined;
}
