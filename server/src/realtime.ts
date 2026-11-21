import { ApiError, RETENTION_MS, json, monthStart, nextMonth, parseInput, readJson, type Input } from './model';

export const MONTHLY_MS = 300 * 60_000;
export const MAX_REALTIME_SEARCH_MS = 60_000;
export interface RealtimeBackend {
  analyze(input: Input, session: string, sequence: number, round: number, movetimeMs: number, signal: AbortSignal): Promise<Response>;
  stop(): Promise<void>;
  schedule(when: number): Promise<void>;
}
export async function fetchRealtimeAnalysis(fetch: (url: string, init: RequestInit) => Promise<Response>,
  input: Input, sessionId: string, sequence: number, round: number, movetimeMs: number, signal: AbortSignal) {
  const payload = {...input, ply: input.moves.length, sessionId, sequence};
  const init = {method: 'POST', headers: {'Content-Type': 'application/json'},
    signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(45_000, movetimeMs + 15_000))])};
  const response = await fetch('http://container/realtime/deepen', {...init, body: JSON.stringify({...payload, round, movetimeMs})});
  if (response.status !== 404 || init.signal.aborted) return response;
  // コンテナの段階更新中は旧 bridge の単発探索へ戻す。
  const legacy = await fetch('http://container/realtime', {...init, body: JSON.stringify(payload)});
  return legacy.ok ? Response.json({...await legacy.json() as object, terminal: true}) : legacy;
}
interface Session extends Record<string, SqlStorageValue> {
  owner: string; id: string; sequence: number; status: string; result: string | null;
  error: string | null; charged: number | null; activity: number;
}

/** リアルタイム解析の各枠を一端末へ排他的に貸与。探索完了後の待機も停止完了まで集計する。 */
export class RealtimeSessions {
  private abort?: AbortController;
  private stopping?: Promise<void>;
  private entitlements = new Map<string, {paid: boolean; pending: number}>();
  private sql: SqlStorage;
  constructor(private storage: DurableObjectStorage, private backend: RealtimeBackend,
    private idleMs = 30_000, private holdIdleMs = 300_000, private now = Date.now) {
    this.sql = storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rt_usage (owner TEXT, month INTEGER, ms INTEGER NOT NULL, PRIMARY KEY(owner,month));
      CREATE TABLE IF NOT EXISTS rt_sessions (owner TEXT PRIMARY KEY, id TEXT NOT NULL, sequence INTEGER NOT NULL,
        status TEXT NOT NULL, result TEXT, error TEXT, charged INTEGER, activity INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rt_holds (owner TEXT PRIMARY KEY, id TEXT NOT NULL, sequence INTEGER NOT NULL);`);
  }
  private idleFor(session?: Session) {
    // ロールバック先も列名なし INSERT ができ、旧版の更新で hold は引き継がれない。
    return session && this.sql.exec('SELECT 1 FROM rt_holds WHERE owner=? AND id=? AND sequence=?',
      session.owner, session.id, session.sequence).toArray().length ? this.holdIdleMs : this.idleMs;
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
    const result = session?.result ? JSON.parse(session.result) : null;
    return {sessionId: session?.id ?? null, sequence: session?.sequence ?? 0,
      status: session?.status ?? 'off', result: result && {...result, depth: result.candidates?.[0]?.depth ?? null},
      searching: !!session && session.charged !== null && ['preparing', 'analyzing', 'ready'].includes(session.status)
        && this.abort?.signal.aborted === false,
      error: session?.error ?? null, idleMs: this.idleFor(session), quota};
  }
  private async schedule() {
    const session = this.active();
    if (!session) return;
    const now = this.now(), remaining = this.quota(session.owner).remainingMs;
    await this.backend.schedule(Math.max(now + 1, Math.min(session.activity + this.idleFor(session), now + remaining, nextMonth(now))));
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
  async expire(reschedule = true) {
    const stopping = this.stopping;
    if (stopping) await stopping;
    const session = this.active();
    if (!session) return !!stopping;
    const quota = this.quota(session.owner), current = this.session(session.owner)!;
    if (['off', 'failed'].includes(current.status)) await this.halt(current.status, current.error);
    else if (!quota.remainingMs || current.status === 'limit') await this.halt('limit');
    else if (current.status === 'paused' || this.now() >= session.activity + this.idleFor(session)) await this.halt('paused');
    else {
      if (reschedule) await this.schedule();
      return !!stopping;
    }
    return true;
  }
  disconnected() {
    if (this.stopping) return;
    const session = this.active();
    if (!session) return;
    this.abort?.abort(); this.account(this.now());
    this.sql.exec("UPDATE rt_sessions SET charged=NULL,status='paused',error='analysis_unavailable' WHERE owner=?", session.owner);
  }
  async fetch(request: Request, owner: string, paid: boolean, waitUntil: (work: Promise<void>) => void, checkPaid?: () => Promise<boolean>): Promise<Response> {
    // 本文待機中も同じ端末の最新権利を参照し、完了した端末の情報は保持しない。
    const entitlement = this.entitlements.get(owner) ?? {paid, pending: 0};
    entitlement.paid = paid; entitlement.pending++;
    this.entitlements.set(owner, entitlement);
    try {
      await this.expire();
      this.sql.exec("UPDATE rt_sessions SET result=NULL WHERE charged IS NULL AND activity<?", this.now() - RETENTION_MS);
      this.sql.exec("DELETE FROM rt_sessions WHERE charged IS NULL AND activity<? AND (status!='limit' OR activity<?)",
        this.now() - RETENTION_MS, this.now() - 40 * 86400_000);
      this.sql.exec('DELETE FROM rt_holds WHERE owner NOT IN (SELECT owner FROM rt_sessions)');
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
      const {sequence, hold = false, ...position} = raw;
      if (creating ? sequence !== undefined : !Number.isSafeInteger(sequence) || (sequence as number) < 1) throw new ApiError(400, 'invalid_sequence');
      if (typeof hold !== 'boolean' || 'mode' in position) throw new ApiError(400, 'invalid_input');
      const input = parseInput({...position, mode: 'std'});
      // 停止完了を待つ間にも権利が失効しうるため、待機後は再照会する。
      do {
        if (checkPaid && entitlement.paid && !await checkPaid()) entitlement.paid = false;
        const stopped = await this.expire(false);
        if (!stopped && !this.stopping) break;
        while (this.stopping) await this.stopping;
      } while (checkPaid && entitlement.paid);
      if (!entitlement.paid) {
        if (this.active()?.owner === owner) await this.halt('off', 'paid_required');
        throw new ApiError(403, 'paid_required');
      }
      const current = this.session(owner), active = this.active();
      if (active && active.owner !== owner) throw new ApiError(409, 'realtime_busy');
      if (!this.quota(owner).remainingMs) throw new ApiError(429, 'monthly_limit');
      if (creating && current && !['off', 'failed'].includes(current.status)) throw new ApiError(409, 'session_exists');
      if (!creating && (current?.id !== match![1] || ['off', 'failed'].includes(current.status))) throw new ApiError(409, 'stale_session');
      if (!creating && (sequence as number) <= current!.sequence) throw new ApiError(409, 'stale_sequence');
      const id = creating ? crypto.randomUUID() : current!.id;
      const seq = creating ? 0 : sequence as number, now = this.now();
      this.abort?.abort();
      const controller = this.abort = new AbortController();
      this.storage.transactionSync(() => {
        this.sql.exec(`INSERT INTO rt_sessions VALUES (?,?,?,'preparing',NULL,NULL,?,?)
          ON CONFLICT(owner) DO UPDATE SET id=excluded.id,sequence=excluded.sequence,status=CASE WHEN rt_sessions.charged IS NULL THEN 'preparing' ELSE 'analyzing' END,
          result=NULL,error=NULL,charged=COALESCE(rt_sessions.charged,excluded.charged),activity=excluded.activity`,
          owner, id, seq, now, now);
        if (hold) this.sql.exec('INSERT OR REPLACE INTO rt_holds VALUES (?,?,?)', owner, id, seq);
        else this.sql.exec('DELETE FROM rt_holds WHERE owner=?', owner);
      });
      await this.schedule();
      waitUntil(this.run(owner, id, seq, input, controller));
      return json(this.view(owner), 202);
    } catch (error) {
      if (error instanceof ApiError) return json({...this.view(owner), error: error.code}, error.status);
      return json({error: 'analysis_unavailable'}, 503);
    } finally {
      if (--entitlement.pending === 0) this.entitlements.delete(owner);
    }
  }
  private async run(owner: string, id: string, sequence: number, input: Input, controller: AbortController) {
    const {signal} = controller;
    try {
      await this.expire(false);
      for (let round = 0, ms = 250; !signal.aborted; round++, ms = Math.min(ms * 2, MAX_REALTIME_SEARCH_MS)) {
        const response = await this.backend.analyze(input, id, sequence, round, ms, signal);
        if (signal.aborted) return;
        const {terminal, ...result} = response.ok ? await response.json() as {terminal?: boolean; ply?: number; score?: {kind: string} | null} : {};
        if (signal.aborted) return;
        // 結果の読み取り後にも期限を確認する。再探索は休止期限を延ばさない。
        await this.expire(false);
        const current = this.session(owner);
        if (signal.aborted || current?.id !== id || current.sequence !== sequence || current.charged === null
          || ['limit', 'paused', 'off', 'failed'].includes(current.status)) return;
        if (!response.ok) {
          await this.halt('failed', response.status === 422 ? 'invalid_position_or_move' : 'analysis_unavailable');
          return;
        }
        if (result.ply !== input.moves.length || typeof terminal !== 'boolean') throw new Error('invalid_result');
        this.sql.exec("UPDATE rt_sessions SET status='ready',result=? WHERE owner=?", JSON.stringify(result), owner);
        if (terminal || result.score?.kind === 'mate') return;
      }
    } catch {
      const current = this.session(owner);
      if (!signal.aborted && current?.id === id && current.sequence === sequence) await this.halt('failed', 'analysis_unavailable');
    } finally {
      if (this.abort === controller) this.abort = undefined;
    }
  }
}
