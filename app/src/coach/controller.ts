import { dataPaused } from "../storage/maintenance";
import { ApiError, type AnalysisClient } from "../analysis/client";
import type { CoachStorage } from "./storage";
import {
  defaultProfile,
  type CoachInput,
  type CoachOverview,
  type CoachRecord,
  type CoachReply,
  type Profile,
} from "./types";
export function coachError(error: unknown): string {
  const code =
    error instanceof ApiError
      ? error.code
      : typeof error === "string"
        ? error
        : "offline";
  return (
    (
      {
        offline: "通信できません。つながってから、もう一度送ってください",
        invalid_proof:
          "精密解析の証明を確認できません。精密解析でやり直してください",
        precise_required: "先に、この対局の精密解析が必要です",
        paid_required: "AIコーチは有料プランの機能です",
        monthly_limit: "今月のAIコーチは上限に達しました",
        coach_busy: "別の解説や質問を作っています。終わってからお試しください",
        result_expired:
          "解説の受け取り期限が過ぎました。保存済みの解説は読めます",
        coach_timeout:
          "時間がかかったため、解説を終えられませんでした。回数は減っていません",
        invalid_input:
          "送る内容が長すぎるか、読み取れません。質問や目標を短くしてお試しください",
        unsafe_names: "送る文章を確認してください",
        unauthorized:
          "端末の登録を確認できません。データは消さずにお問い合わせください",
      } as Record<string, string>
    )[code] ??
    "解説を終えられませんでした。回数は減っていません。もう一度試せます"
  );
}
export class CoachController {
  snapshot = {
    records: {} as Record<string, CoachRecord>,
    profile: {
      ...defaultProfile,
      practice: [] as string[],
      style: { ...defaultProfile.style },
    },
    overview: null as CoachOverview | null,
    offline: false,
    ready: false,
  };
  private listeners = new Set<() => void>();
  private working: Promise<void> | null = null;
  private starting = false;
  private profileWrites = Promise.resolve();
  private notify = (_id: string, _failed: boolean) => {};
  constructor(
    private api: Pick<
      AnalysisClient,
      "coach" | "createCoach" | "getCoach" | "cancelCoach"
    >,
    private storage: CoachStorage,
    private now = Date.now,
  ) {}
  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => {
      this.listeners.delete(f);
    };
  };
  private emit() {
    this.snapshot = { ...this.snapshot };
    this.listeners.forEach((f) => f());
  }
  onNotify(fn: typeof this.notify) {
    this.notify = fn;
  }
  async init() {
    const [records, profile, overview] = await Promise.all([
      this.storage.load(),
      this.storage.profile(),
      this.storage.overview(),
    ]);
    this.snapshot = {
      ...this.snapshot,
      records: Object.fromEntries(records.map((r) => [r.gameId, r])),
      profile,
      overview,
      ready: true,
    };
    this.emit();
  }
  async setProfile(profile: Profile) {
    const previous = this.snapshot.profile;
    this.snapshot.profile = profile;
    this.emit();
    const write = this.profileWrites
      .catch(() => {})
      .then(() => this.storage.saveProfile(profile));
    this.profileWrites = write;
    try {
      await write;
    } catch (e) {
      if (this.snapshot.profile === profile) {
        this.snapshot.profile = previous;
        this.emit();
      }
      throw e;
    }
  }
  private async save(r: CoachRecord) {
    await this.storage.save(r);
    this.snapshot.records = { ...this.snapshot.records, [r.gameId]: r };
    this.emit();
  }
  get busy() {
    return (
      this.starting ||
      Object.values(this.snapshot.records).some((r) => !!r.attempt)
    );
  }
  async start(gameId: string, input: CoachInput) {
    if (this.busy) throw new Error(coachError("coach_busy"));
    this.starting = true;
    try {
      const r: CoachRecord = {
        gameId,
        answers: this.snapshot.records[gameId]?.answers ?? [],
        attempt: { input, sentAt: null, cancel: false },
        error: null,
      };
      await this.save(r); // IDと送信本文を永続化できるまで、回数を使う通信をしない。
    } finally {
      this.starting = false;
    }
    await this.sync();
  }
  async cancel(gameId: string) {
    const r = this.snapshot.records[gameId];
    if (!r?.attempt) return;
    await this.save({ ...r, attempt: { ...r.attempt, cancel: true } });
    // 待機中のPOST/GETがpendingで戻っても、画面の次の同期に頼らず中止を処理する。
    await this.working;
    await this.sync();
  }
  async idle() {
    await this.working;
    await this.profileWrites;
  }
  sync = (): Promise<void> => {
    if (dataPaused) return Promise.resolve();
    if (this.working) return this.working;
    this.working = this.run().finally(() => {
      this.working = null;
    });
    return this.working;
  };
  private async apply(r: CoachRecord, reply: CoachReply) {
    // 中止の意思がHTTP待ちの間に変わっても、古い文書で上書きしない。
    r = this.snapshot.records[r.gameId] ?? r;
    if (!r.attempt || r.attempt.input.requestId !== reply.requestId) return;
    if (this.snapshot.overview) {
      this.snapshot.overview = {
        ...this.snapshot.overview,
        quota: reply.quota,
      };
      await this.storage.saveOverview(this.snapshot.overview);
    }
    if (reply.status === "pending") {
      if (r.error) await this.save({ ...r, error: null });
      return;
    }
    let answers = r.answers;
    if (reply.status === "completed") {
      if (!reply.sections?.length) throw new Error("応答を読めません");
      const { style, question } = r.attempt.input;
      const answer = {
        requestId: reply.requestId,
        sections: reply.sections,
        style,
        ...(question === undefined ? {} : { question }),
      };
      answers = question === undefined ? [answer] : [...answers, answer];
    }
    await this.save({
      ...r,
      answers,
      attempt: null,
      error: reply.status === "failed" ? coachError(reply.error) : null,
      failedQuestion:
        reply.status === "failed" ? r.attempt.input.question : undefined,
    });
    if (reply.status !== "cancelled")
      this.notify(r.gameId, reply.status === "failed");
  }
  private async run() {
    if (!this.snapshot.ready) return;
    try {
      const overview = await this.api.coach();
      await this.storage.saveOverview(overview);
      this.snapshot.overview = overview;
      this.snapshot.offline = false;
      this.emit();
      for (const original of Object.values(this.snapshot.records)) {
        let r = this.snapshot.records[original.gameId];
        if (!r?.attempt) continue;
        const a = r.attempt,
          id = a.input.requestId;
        let posting = false;
        try {
          if (a.cancel) {
            await this.apply(r, await this.api.cancelCoach(id));
            continue;
          }
          if (a.sentAt !== null) {
            try {
              await this.apply(r, await this.api.getCoach(id));
              continue;
            } catch (e) {
              if (!(e instanceof ApiError) || e.status !== 404) throw e;
            }
            // サーバーのID保持期限を越えたか不明な依頼は再POSTしない。
            if (this.now() - a.sentAt >= 7 * 86400000)
              throw new ApiError(410, "result_expired");
          } else {
            r = { ...r, attempt: { ...a, sentAt: this.now() } };
            await this.save(r);
          }
          // 中止が先行した場合、遅延POSTを送らず同じIDをDELETEする。
          if (this.snapshot.records[r.gameId]?.attempt?.cancel) {
            await this.apply(r, await this.api.cancelCoach(id));
            continue;
          }
          posting = true;
          try {
            await this.apply(r, await this.api.createCoach(a.input));
          } catch (e) {
            if (e instanceof ApiError && e.code === "request_exists")
              await this.apply(r, await this.api.getCoach(id));
            else throw e;
          }
        } catch (e) {
          r = this.snapshot.records[r.gameId];
          if (!r) continue;
          if (
            e instanceof ApiError &&
            (e.status === 410 ||
              (posting && [400, 403, 413, 429].includes(e.status)))
          ) {
            if (e.quota && "remaining" in e.quota && this.snapshot.overview) {
              this.snapshot.overview = {
                ...this.snapshot.overview,
                quota: e.quota,
              };
              await this.storage.saveOverview(this.snapshot.overview);
            }
            await this.save({
              ...r,
              attempt: null,
              error: coachError(e),
              failedQuestion: a.input.question,
            });
          } else {
            this.snapshot.offline = !(e instanceof ApiError);
            await this.save({ ...r, error: coachError(e) });
          }
        }
      }
    } catch {
      this.snapshot.offline = true;
    }
    this.emit();
  }
}
