import { dataPaused } from "../storage/maintenance";
import {
  AnalysisClient,
  AnalysisConfigurationError,
  ApiError,
  errorText,
} from "./client";
import type { AnalysisStorage } from "./storage";
import {
  active,
  needsRetryConfirmation,
  type Analysis,
  type Input,
  type Quota,
  type Reply,
} from "./types";
export interface Snapshot {
  ready: boolean;
  records: Record<string, Analysis>;
  quota: Quota | null;
  offline: boolean;
  problem: string;
}
/** UIから独立した永続outbox。POST応答を失っても同一入力の再送はサーバーで重複排除される。 */
export class AnalysisController {
  snapshot: Snapshot = {
    ready: false,
    records: {},
    quota: null,
    offline: false,
    problem: "",
  };
  private listeners = new Set<() => void>();
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private api: AnalysisClient,
    private storage: AnalysisStorage,
    private notify: (id: string, failed: boolean) => void = () => {},
  ) {}
  onNotify(fn: (id: string, failed: boolean) => void) {
    this.notify = fn;
  }
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
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => {});
    return p;
  }
  init() {
    return this.serial(async () => {
      const records = await this.storage.load();
      this.snapshot = {
        ...this.snapshot,
        ready: true,
        records: Object.fromEntries(records.map((a) => [a.gameId, a])),
        quota: await this.storage.quota(),
      };
      this.emit();
    });
  }
  private async save(a: Analysis) {
    await this.storage.save(a);
    this.snapshot.records = { ...this.snapshot.records, [a.gameId]: a };
    this.emit();
  }
  private async quota(q: Quota) {
    await this.storage.saveQuota(q);
    this.snapshot.quota = q;
  }
  private async receive(a: Analysis, reply: Reply) {
    const attempt = a.attempt!;
    const merged = new Map(attempt.results.map((r) => [r.ply, r]));
    // 精密の完了時は全件が届く。受信済み局面も deep を含むオブジェクトで上書きする。
    reply.results.forEach((r) => merged.set(r.ply, r));
    const results = [...merged.values()].sort((a, b) => a.ply - b.ply);
    const ended = ["completed", "failed", "cancelled"].includes(reply.status);
    // nextと結果を同じ文書で保存。完了しても局面が欠けていれば0から取り直す。
    if (
      reply.status === "completed" &&
      (results.length !== reply.total || results.some((r, i) => r.ply !== i))
    ) {
      await this.save({
        ...a,
        attempt: {
          ...attempt,
          job: { ...reply, next: 0, status: "running", results: [] },
          results: [],
        },
      });
      return;
    }
    const saved =
      reply.status === "completed"
        ? {
            initial: attempt.initial,
            moves: attempt.moves,
            mode: attempt.mode,
            results,
            coachProof: reply.coachProof,
            jobId: reply.id,
          }
        : a.saved;
    await this.quota(reply.quota);
    await this.save({
      ...a,
      saved,
      error:
        reply.status === "failed"
          ? reply.error === "invalid_position_or_move"
            ? "棋譜の局面や指し手を解析できませんでした。回数は減っていません"
            : "解析を終えられませんでした。回数は減っていません。もう一度試せます"
          : null,
      attempt: ended
        ? null
        : { ...attempt, job: { ...reply, results: [] }, results },
    });
    if (reply.status === "completed" || reply.status === "failed")
      this.notify(a.gameId, reply.status === "failed");
  }
  start(id: string, input: Input, confirmed = false) {
    return this.serial(async () => {
      if (
        needsRetryConfirmation(this.snapshot.records[id]?.attempt) &&
        !confirmed
      )
        throw new Error(
          "前回の依頼の結果が分かりません。もう一度解析するには確認が必要です",
        );
      if (active(this.snapshot.records[id])) return;
      if (input.moves.length > 512)
        throw new Error("解析できる棋譜は512手までです");
      await this.save({
        gameId: id,
        saved: this.snapshot.records[id]?.saved ?? null,
        error: null,
        attempt: {
          ...input,
          firstSentAt: null,
          job: null,
          results: [],
          cancel: false,
        },
      });
    }).then(() => this.sync());
  }
  cancel(id: string) {
    return this.serial(async () => {
      const a = this.snapshot.records[id];
      if (a?.attempt)
        await this.save({
          ...a,
          attempt: needsRetryConfirmation(a.attempt)
            ? null
            : { ...a.attempt, cancel: true },
        });
    }).then(() => this.sync());
  }
  idle() {
    return this.serial(async () => {});
  }
  private syncing: Promise<void> | undefined;
  sync(): Promise<void> {
    if (dataPaused) return Promise.resolve();
    return (this.syncing ??= this.serial(async () => {
      this.snapshot.problem = "";
      try {
        const existing = new Set(
          (await this.storage.load()).map((a) => a.gameId),
        );
        this.snapshot.records = Object.fromEntries(
          Object.entries(this.snapshot.records).filter(([id]) =>
            existing.has(id),
          ),
        );
        for (let a of Object.values(this.snapshot.records)) {
          if (!a.attempt || needsRetryConfirmation(a.attempt)) continue;
          try {
            let t = a.attempt;
            const recovering = !t.job && t.firstSentAt !== null;
            if (!t.job && t.firstSentAt === null) {
              t = { ...t, firstSentAt: Date.now() };
              a = { ...a, attempt: t };
              await this.save(a);
            }
            const reply = !t.job
              ? await this.api.create(t, recovering)
              : t.cancel
                ? await this.api.cancel(t.job.id)
                : await this.api.get(t.job.id, t.job.next);
            await this.receive(a, reply);
            const next = this.snapshot.records[a.gameId]!;
            if (t.cancel && !t.job && next.attempt?.job)
              await this.receive(
                next,
                await this.api.cancel(next.attempt.job.id),
              );
          } catch (e) {
            if (
              e instanceof AnalysisConfigurationError ||
              (e instanceof ApiError && e.status >= 400 && e.status < 500)
            ) {
              if (e instanceof ApiError && e.quota && "paid" in e.quota)
                await this.quota(e.quota);
              await this.save({ ...a, attempt: null, error: errorText(e) });
            } else throw e;
          }
        }
        await this.quota(await this.api.quota());
        this.snapshot.offline = false;
      } catch (e) {
        this.snapshot.offline = !(
          e instanceof ApiError || e instanceof AnalysisConfigurationError
        );
        this.snapshot.problem = errorText(e);
      }
      this.emit();
    }).finally(() => {
      this.syncing = undefined;
    }));
  }
}
