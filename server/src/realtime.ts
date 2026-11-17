import { ApiError, RETENTION_MS, json, monthStart, nextMonth, parseInput, readJson, type Input } from './model';

export const MONTHLY_MS = 300 * 60_000;
export interface RealtimeBackend {
  analyze(input: Input, session: string, sequence: number, signal: AbortSignal): Promise<Response>;
  stop(): Promise<void>;
  schedule(when: number): Promise<void>;
}
interface Session extends Record<string, SqlStorageValue> {
  owner: string; id: string; sequence: number; status: string; result: string | null;
  error: string | null; charged: number | null; activity: number;
}

/** 分岐用の各枠を一端末へ排他的に貸与。探索完了後の待機も停止完了まで集計する。 */
export class RealtimeSessions {
  private abort?: AbortController;
  private stopping?: Promise<void>;
  private entitlements = new Map<string, {paid: boolean; pending: number}>();
  private sql: SqlStorage;
  constructor(private storage: DurableObjectStorage, private backend: RealtimeBackend, private idleMs: number, private now = Date.now) {
    this.sql = storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rt_usage (owner TEXT, month INTEGER, ms INTEGER NOT NULL, PRIMARY KEY(owner,month));
      CREATE TABLE IF NOT EXISTS rt_sessions (owner TEXT PRIMARY KEY, id TEXT NOT NULL, sequence INTEGER NOT NULL,
        status TEXT NOT NULL, result TEXT, error TEXT, charged INTEGER, activity INTEGER NOT NULL);`);
  }
  private session(owner: string): Session | undefined {
    return this.sql.exec<Session>('SELECT * FROM rt_sessions WHERE owner=?', owner).toArray()[0];
  }
  private active(): Session | undefined {
    return this.sql.exec<Session>('SELECT * FROM rt_sessions WHERE charged IS NOT NULL').toArray()[0];
  }
  private used(owner: string, month: number): number {
    return this.sql.exec<{ms: number}>('SELECT ms FROM rt_usage WHERE owner=? AND month=?', owner, month).toArray()[0]?.ms ?? 0;
  }
  private account(now: number) {
    const session = this.active();
    if (!session || session.charged === null) return;
    if (now <= session.charged) return;
    this.storage.transactionSync(() => {
      let cursor = session.charged!;
      while (cursor < now) {
        const month = monthStart(cursor), end = Math.min(now, nextMonth(cursor));
        const exhausted = this.used(session.owner, month) + end - cursor >= MONTHLY_MS;
        this.sql.exec('INSERT INTO rt_usage VALUES (?,?,?) ON CONFLICT(owner,month) DO UPDATE SET ms=MIN(?,ms+excluded.ms)',
          session.owner, month, Math.min(MONTHLY_MS, end - cursor), MONTHLY_MS);
        if (exhausted) this.sql.exec("UPDATE rt_sessions SET status='limit' WHERE owner=? AND status NOT IN ('off','failed')", session.owner);
        cursor = end;
      }
      this.sql.exec('UPDATE rt_sessions SET charged=? WHERE owner=?', now, session.owner);
    });
  }
  quota(owner: string) {
    this.account(this.now());
    const now = this.now(), month = monthStart(now), usedMs = this.used(owner, month);
    return {monthStart: month, resetsAt: nextMonth(now), limitMs: MONTHLY_MS, usedMs,
      remainingMs: Math.max(0, MONTHLY_MS - usedMs), low: MONTHLY_MS - usedMs < MONTHLY_MS / 10};
  }
  private view(owner: string) {
    const quota = this.quota(owner), session = this.session(owner);
    return {sessionId: session?.id ?? null, sequence: session?.sequence ?? 0,
      status: session?.status ?? 'off', result: session?.result ? JSON.parse(session.result) : null,
      error: session?.error ?? null, idleMs: this.idleMs, quota};
  }
  private async schedule() {
    const session = this.active();
    if (!session) return;
    const now = this.now(), remaining = this.quota(session.owner).remainingMs;
    await this.backend.schedule(Math.max(now + 1, Math.min(session.activity + this.idleMs, now + remaining, nextMonth(now))));
  }
  private async halt(status: string, error: string | null = null) {
    if (this.stopping) return this.stopping;
    const session = this.active();
    if (!session) return;
    this.abort?.abort();
    this.sql.exec('UPDATE rt_sessions SET status=?,error=? WHERE owner=?', status, error, session.owner);
    this.stopping = (async () => {
      // SIGKILL/destroy の完了まで課金。停止に失敗した場合は貸与も集計も解除しない。
      await this.backend.stop();
      this.account(this.now());
      this.sql.exec('UPDATE rt_sessions SET charged=NULL WHERE owner=?', session.owner);
    })();
    try { await this.stopping; }
    catch (error) { await this.backend.schedule(this.now() + 1000); throw error; }
    finally { this.stopping = undefined; }
  }
  async expire() {
    if (this.stopping) await this.stopping;
    const session = this.active();
    if (!session) return;
    const quota = this.quota(session.owner), current = this.session(session.owner)!;
    if (['off', 'failed'].includes(current.status)) await this.halt(current.status, current.error);
    else if (!quota.remainingMs || current.status === 'limit') await this.halt('limit');
    else if (this.now() >= session.activity + this.idleMs) await this.halt('paused');
    else await this.schedule();
  }
  disconnected() {
    if (this.stopping) return;
    const session = this.active();
    if (!session) return;
    this.abort?.abort(); this.account(this.now());
    this.sql.exec("UPDATE rt_sessions SET charged=NULL,status='paused',error='analysis_unavailable' WHERE owner=?", session.owner);
  }
  async fetch(request: Request, owner: string, paid: boolean, waitUntil: (work: Promise<void>) => void): Promise<Response> {
    // 本文待機中も同じ端末の最新権利を参照し、完了した端末の情報は保持しない。
    const entitlement = this.entitlements.get(owner) ?? {paid, pending: 0};
    entitlement.paid = paid; entitlement.pending++;
    this.entitlements.set(owner, entitlement);
    try {
      await this.expire();
      this.sql.exec("UPDATE rt_sessions SET result=NULL WHERE charged IS NULL AND activity<?", this.now() - RETENTION_MS);
      this.sql.exec("DELETE FROM rt_sessions WHERE charged IS NULL AND activity<? AND (status!='limit' OR activity<?)",
        this.now() - RETENTION_MS, this.now() - 40 * 86400_000);
      this.sql.exec('DELETE FROM rt_usage WHERE month<?', monthStart(monthStart(this.now()) - 1));
      const url = new URL(request.url);
      const match = /^\/v1\/realtime\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (!entitlement.paid && this.active()?.owner === owner) await this.halt('off', 'paid_required');
      if (request.method === 'GET' && url.pathname === '/v1/realtime') return json({...this.view(owner), paid: entitlement.paid});
      if (request.method === 'DELETE' && match) {
        const session = this.session(owner);
        if (session?.id !== match[1]) throw new ApiError(409, 'stale_session');
        if (this.active()?.owner === owner) await this.halt('off');
        this.sql.exec("UPDATE rt_sessions SET status='off',result=NULL,error=NULL WHERE owner=?", owner);
        return json(this.view(owner));
      }
      if (!entitlement.paid) throw new ApiError(403, 'paid_required');
      const creating = request.method === 'POST' && url.pathname === '/v1/realtime';
      if (!creating && !(request.method === 'PUT' && match)) throw new ApiError(404, 'not_found');
      const raw = await readJson(request) as Record<string, unknown>;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(400, 'invalid_input');
      const {sequence, ...position} = raw;
      if (creating ? sequence !== undefined : !Number.isSafeInteger(sequence) || (sequence as number) < 1) throw new ApiError(400, 'invalid_sequence');
      const input = parseInput({...position, mode: 'std'});
      if ('mode' in position) throw new ApiError(400, 'invalid_input');
      // readJson は await するため、ここでも最新の貸与・権利・期限を確認する。
      await this.expire();
      if (!entitlement.paid) throw new ApiError(403, 'paid_required');
      const current = this.session(owner), active = this.active();
      if (active && active.owner !== owner) throw new ApiError(409, 'realtime_busy');
      if (!this.quota(owner).remainingMs) throw new ApiError(429, 'monthly_limit');
      if (creating && current && !['off', 'failed'].includes(current.status)) throw new ApiError(409, 'session_exists');
      if (!creating && (current?.id !== match![1] || ['off', 'failed'].includes(current.status))) throw new ApiError(409, 'stale_session');
      if (!creating && (sequence as number) <= current!.sequence) throw new ApiError(409, 'stale_sequence');
      const id = creating ? crypto.randomUUID() : current!.id;
      const seq = creating ? 0 : sequence as number, now = this.now();
      this.abort?.abort(); this.abort = new AbortController();
      this.sql.exec(`INSERT INTO rt_sessions VALUES (?,?,?,'preparing',NULL,NULL,?,?)
        ON CONFLICT(owner) DO UPDATE SET id=excluded.id,sequence=excluded.sequence,status=CASE WHEN rt_sessions.charged IS NULL THEN 'preparing' ELSE 'analyzing' END,
        result=NULL,error=NULL,charged=COALESCE(rt_sessions.charged,excluded.charged),activity=excluded.activity`,
        owner, id, seq, now, now);
      const signal = this.abort.signal;
      await this.schedule();
      waitUntil(this.run(owner, id, seq, input, signal));
      return json(this.view(owner), 202);
    } catch (error) {
      if (error instanceof ApiError) return json({...this.view(owner), error: error.code}, error.status);
      return json({error: 'analysis_unavailable'}, 503);
    } finally {
      if (--entitlement.pending === 0) this.entitlements.delete(owner);
    }
  }
  private async run(owner: string, id: string, sequence: number, input: Input, signal: AbortSignal) {
    try {
      if (signal.aborted) return;
      const response = await this.backend.analyze(input, id, sequence, signal);
      await this.expire();
      const current = this.session(owner);
      if (signal.aborted || current?.id !== id || current.sequence !== sequence || current.charged === null) return;
      if (!response.ok) {
        await this.halt('failed', response.status === 422 ? 'invalid_position_or_move' : 'analysis_unavailable');
        return;
      }
      const result = await response.json() as {ply?: number};
      if (result.ply !== input.moves.length) throw new Error('invalid_result');
      // JSON の読み取り中に次の局面へ進んだ場合も古い結果を保存しない。
      this.sql.exec("UPDATE rt_sessions SET status='ready',result=? WHERE owner=? AND id=? AND sequence=? AND charged IS NOT NULL AND status NOT IN ('limit','off','failed')",
        JSON.stringify(result), owner, id, sequence);
    } catch {
      const current = this.session(owner);
      if (!signal.aborted && current?.id === id && current.sequence === sequence) await this.halt('failed', 'analysis_unavailable');
    }
  }
}
