import { normalizeInviteCode } from './invite-code.mjs';
import { Invitations, limit, type Entitlement } from './invitations';
export { Invitations } from './invitations';
import { Coach, parseCoach, signAnalysis, type CoachEnv } from './coach';
import { coachTags, readCoachResponse } from './coach-tools';
import { DurableObject } from 'cloudflare:workers';
import { RealtimeSessions, fetchRealtimeAnalysis } from './realtime';
import { Container } from '@cloudflare/containers';
import { ApiError, RETENTION_MS, json, parseInput, readJson, sha256, weekStart, type Input, type Mode } from './model';

export interface Env extends CoachEnv {
  DEVICES: DurableObjectNamespace<Device>;
  STD: DurableObjectNamespace<StandardContainer>;
  PRECISE: DurableObjectNamespace<PreciseContainer>;
  REALTIME: DurableObjectNamespace<RealtimeContainer>;
  INVITATIONS: DurableObjectNamespace<Invitations>;
  INVITE_ADMIN_KEY?: string;
  REGISTRATION_LIMITER?: RateLimit;
  API_LIMITER?: RateLimit;
  WRITE_LIMITER?: RateLimit;
  INVITE_LIMITER?: RateLimit;
  REALTIME_IDLE_MS?: string;
  REALTIME_HOLD_IDLE_MS?: string;
  ENVIRONMENT: string;
  ALLOW_DEV_PAID: string;
  DEV_PAID_HASHES?: string;
}
export class StandardContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '10s';
  enableInternet = false;
}
export class PreciseContainer extends StandardContainer {}

export class RealtimeContainer extends StandardContainer {
  sleepAfter = '60s';
  private sessions: RealtimeSessions;
  private boot?: Promise<void>;
  private lifetime = new AbortController();
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    const idleTime = (value: string | undefined, fallback: number) => {
      const ms = Number(value);
      return Number.isSafeInteger(ms) && ms >= 1000 && ms <= 300_000 ? ms : fallback;
    };
    this.sessions = new RealtimeSessions(ctx.storage, {
      analyze: async (input, sessionId, sequence, round, movetimeMs, signal) => {
        if (this.boot || !ctx.container?.running) {
          // 局面変更では共通の初回起動まで中断しない。明示停止・休止だけが起動を打ち切る。
          const boot = this.boot ??= this.startAndWaitForPorts(8080, {abort: this.lifetime.signal});
          try { await boot; } finally { if (this.boot === boot) this.boot = undefined; }
        }
        if (signal.aborted) return new Response(null, {status: 409});
        return fetchRealtimeAnalysis(this.containerFetch.bind(this), input, sessionId, sequence, round, movetimeMs, signal);
      },
      stop: async () => {
        this.lifetime.abort();
        await this.boot?.catch(() => {});
        await this.destroy();
        await this.stop();
        this.lifetime = new AbortController();
      },
      schedule: async when => {
        this.deleteSchedules('expireRealtime');
        await this.schedule(new Date(when), 'expireRealtime');
      },
    }, idleTime(env.REALTIME_IDLE_MS, 30_000), idleTime(env.REALTIME_HOLD_IDLE_MS, 300_000));
  }
  async expireRealtime() { await this.sessions.expire(); }
  async onActivityExpired() { await this.sessions.expire(); }
  onStop() { if (!this.boot) this.sessions.disconnected(); }
  async fetch(request: Request): Promise<Response> {
    const owner = request.headers.get('X-Realtime-Owner');
    if (!owner || !/^[a-f0-9]{64}$/.test(owner)) return json({error: 'unauthorized'}, 401);
    const devPaid = request.headers.get('X-Dev-Entitlement') === '1' && ['local', 'staging'].includes(this.env.ENVIRONMENT) && this.env.ALLOW_DEV_PAID === 'true';
    const hash = request.headers.get('X-Device-Hash');
    return this.sessions.fetch(request, owner, request.headers.get('X-Dev-Paid') === '1', work => this.ctx.waitUntil(work),
      async () => devPaid || (!!hash && (await this.env.INVITATIONS.getByName('registry').entitlement(hash)).paid));
  }
}

interface Job {
  id: string; fingerprint: string; payload: string; mode: Mode;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  cursor: number; week: number; created: number; terminal: number | null;
  attempts: number; error: string | null;
}
export class Device extends DurableObject<Env> {
  private busy = false;
  private coach: Coach;
  private entitlement: Entitlement = {paid: false, source: null, expiresAt: null};
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const coachContainer = (path: 'coach-facts' | 'coach-tools', data: unknown, signal: AbortSignal) => {
      signal.throwIfAborted();
      const slot = parseInt(ctx.id.toString().slice(0, 8), 16) % 2;
      return env.PRECISE.getByName('slot-' + slot).fetch('http://container/' + path, {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data), signal,
      });
    };
    const game = (input: ReturnType<typeof parseCoach>) => ({initial: input.input.initial, moves: input.input.moves,
      results: input.results, perspective: input.perspective, question: input.question});
    this.coach = new Coach(ctx.storage, env, ctx.id.toString(), () => this.paid(), async (input, signal) => {
      if (env.COACH_PROVIDER === 'fake') return undefined;
      const response = await coachContainer('coach-facts', game(input), signal);
      if (!response.ok) throw new ApiError(502, 'facts_unavailable');
      return await response.json();
    }, () => this.refreshEntitlement(), async (input, calls, signal) => {
      const data = game(input);
      let tags;
      if (calls.some(call => call.name === 'game_tags')) {
        try { tags = await coachTags(data.initial, data.moves); } catch { /* 分類未確認 */ }
      }
      const response = await coachContainer('coach-tools', {game: {...data, tags}, calls}, signal);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new ApiError(502, 'tools_unavailable');
      }
      const result = await readCoachResponse(response, signal) as {results?: unknown[]};
      if (!Array.isArray(result?.results)) throw new ApiError(502, 'tools_unavailable');
      return result.results;
    });
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, payload TEXT NOT NULL,
        mode TEXT NOT NULL, status TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
        week INTEGER NOT NULL, created INTEGER NOT NULL, terminal INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE TABLE IF NOT EXISTS results (job TEXT NOT NULL, ply INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job,ply));
      CREATE TABLE IF NOT EXISTS usage (week INTEGER PRIMARY KEY, total INTEGER NOT NULL, precise INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS coach_proofs (job TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  }
  private rows<T extends Record<string, SqlStorageValue>>(sql: string, ...params: SqlStorageValue[]): T[] {
    return this.ctx.storage.sql.exec<T>(sql, ...params).toArray();
  }
  private async refreshEntitlement() {
    const hash = this.rows<{value: string}>("SELECT value FROM meta WHERE key='hash'")[0]?.value;
    this.entitlement = hash && this.env.INVITATIONS ? await this.env.INVITATIONS.getByName('registry').entitlement(hash)
      : {paid: false, source: null, expiresAt: null};
  }
  private devPaid(): boolean {
    return ['local', 'staging'].includes(this.env.ENVIRONMENT) && this.env.ALLOW_DEV_PAID === 'true'
      && this.rows<{value: string}>("SELECT value FROM meta WHERE key='paid'")[0]?.value === '1';
  }
  private paid(): boolean {
    return this.devPaid() || (this.entitlement.paid && (this.entitlement.expiresAt === null || this.entitlement.expiresAt > Date.now()));
  }
  private quota(week = weekStart(Date.now())) {
    const paid = this.paid();
    const used = this.rows<{total: number; precise: number}>('SELECT total, precise FROM usage WHERE week=?', week)[0] ?? {total: 0, precise: 0};
    const reserved = this.rows<{total: number; precise: number}>("SELECT COUNT(*) AS total, COALESCE(SUM(mode='precise'),0) AS precise FROM jobs WHERE week=? AND status IN ('queued','running')", week)[0];
    return {paid, weekStart: week, resetsAt: week + 7 * 86400_000,
      totalRemaining: Math.max(0, (paid ? 100 : 10) - used.total - reserved.total),
      preciseRemaining: Math.max(0, (paid ? 20 : 0) - used.precise - reserved.precise),
      completed: used, reserved};
  }
  private getJob(id: string): Job {
    const job = this.rows<Job & Record<string, SqlStorageValue>>('SELECT * FROM jobs WHERE id=?', id)[0];
    if (!job) throw new ApiError(404, 'job_not_found');
    return job;
  }
  private view(job: Job, from = 0) {
    const input = JSON.parse(job.payload) as Input;
    return {id: job.id, mode: job.mode, status: job.status, next: job.cursor,
      total: input.moves.length + 1, createdAt: job.created, finishedAt: job.terminal,
      expiresAt: job.terminal === null ? null : job.terminal + RETENTION_MS, error: job.error,
      coachProof: job.status === 'completed' && job.mode === 'precise' ? JSON.parse(this.rows<{data: string}>('SELECT data FROM coach_proofs WHERE job=?', job.id)[0]?.data ?? 'null') : null,
      results: this.rows<{data: string}>('SELECT data FROM results WHERE job=? AND ply>=? ORDER BY ply', job.id, from).map(x => JSON.parse(x.data))};
  }
  private prune(now: number) {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM results WHERE job IN (SELECT id FROM jobs WHERE terminal IS NOT NULL AND terminal<=?)', now - RETENTION_MS);
      this.ctx.storage.sql.exec('DELETE FROM coach_proofs WHERE job IN (SELECT id FROM jobs WHERE terminal IS NOT NULL AND terminal<=?)', now - RETENTION_MS);
      this.ctx.storage.sql.exec('DELETE FROM jobs WHERE terminal IS NOT NULL AND terminal<=?', now - RETENTION_MS);
      this.ctx.storage.sql.exec('DELETE FROM usage WHERE week<?', weekStart(now) - 7 * 86400_000);
    });
  }
  async fetch(request: Request): Promise<Response> {
    try {
      this.prune(Date.now());
      const url = new URL(request.url);
      if (url.pathname === '/register' && request.method === 'POST') {
        const hash = url.searchParams.get('hash');
        if (!hash || !/^[a-f0-9]{64}$/.test(hash)) throw new ApiError(400, 'invalid_device');
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec("INSERT OR IGNORE INTO meta VALUES ('registered','1')");
          this.ctx.storage.sql.exec("INSERT OR IGNORE INTO meta VALUES ('hash',?)", hash);
        });
        return json({ok: true}, 201);
      }
      if (!this.rows('SELECT key FROM meta WHERE key=?', 'registered').length) throw new ApiError(401, 'unauthorized');
      this.ctx.storage.sql.exec("INSERT INTO meta VALUES ('paid',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", request.headers.get('X-Dev-Paid') === '1' ? '1' : '0');
      await this.refreshEntitlement();
      if (url.pathname === '/v1/entitlements' && request.method === 'GET') return json({...this.entitlement, paid: this.paid(), source: this.devPaid() ? 'development' : this.entitlement.source});
      if (url.pathname === '/v1/invitations/redeem' && request.method === 'POST') {
        const hash = this.rows<{value: string}>("SELECT value FROM meta WHERE key='hash'")[0].value;
        const registry = this.env.INVITATIONS.getByName('registry');
        if (!await registry.attempt(hash, request.headers.get('X-Invite-IP') ?? 'unknown')) throw new ApiError(429, 'invite_rate_limited');
        const input = await readJson(request, 1024) as Record<string, unknown>;
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.code !== 'string') throw new ApiError(400, 'invalid_input');
        const code = normalizeInviteCode(input.code);
        if (!code) throw new ApiError(400, 'invalid_input');
        const result = await registry.redeem(hash, await sha256(code));
        if ('error' in result) throw new ApiError(result.error === 'invite_full' ? 409 : 400, result.error);
        this.entitlement = result;
        return json(result);
      }
      if (url.pathname === '/v1/coach' || /^\/v1\/coach\/[a-f0-9-]{36}$/.test(url.pathname)) return await this.coach.fetch(request);
      if (url.pathname === '/v1/realtime' || /^\/v1\/realtime\/[0-9a-f-]{36}$/.test(url.pathname)) {
        const headers = new Headers(request.headers);
        headers.set('X-Realtime-Owner', this.ctx.id.toString());
        headers.set('X-Dev-Paid', this.paid() ? '1' : '0');
        headers.set('X-Dev-Entitlement', this.devPaid() ? '1' : '0');
        headers.set('X-Device-Hash', this.rows<{value: string}>("SELECT value FROM meta WHERE key='hash'")[0].value);
        // 全局解析と独立した固定2枠。枠内は一端末へ排他的に貸与し、待ち行列を作らない。
        const slot = parseInt(this.ctx.id.toString().slice(0, 8), 16) % 2;
        return await this.env.REALTIME.getByName('slot-' + slot).fetch(new Request(request, {headers}));
      }
      if (url.pathname === '/v1/quota' && request.method === 'GET') return json(this.quota());
      if (url.pathname === '/v1/jobs' && request.method === 'GET') {
        return json({jobs: this.rows<Job & Record<string, SqlStorageValue>>('SELECT * FROM jobs ORDER BY created,id').map(j => ({...this.view(j, j.cursor), results: undefined})), quota: this.quota()});
      }
      if (url.pathname === '/v1/jobs' && request.method === 'POST') {
        const input = parseInput(await readJson(request));
        await this.refreshEntitlement();
        const fingerprint = await sha256(JSON.stringify(input));
        // 先に alarm を永続化し、ジョブ保存直後のプロセス消失でも処理を起こす。
        await this.ctx.storage.setAlarm(Date.now() + 100);
        return this.ctx.storage.transactionSync(() => {
          const existing = this.rows<Job & Record<string, SqlStorageValue>>('SELECT * FROM jobs WHERE fingerprint=?', fingerprint)[0];
          if (existing && !['failed', 'cancelled'].includes(existing.status)) return json({...this.view(existing), duplicate: true, quota: this.quota()});
          const quota = this.quota();
          if (input.mode === 'precise' && !quota.paid) throw new ApiError(403, 'paid_required');
          if (quota.totalRemaining <= 0 || (input.mode === 'precise' && quota.preciseRemaining <= 0)) throw new ApiError(429, 'weekly_limit');
          if (existing) {
            this.ctx.storage.sql.exec('DELETE FROM results WHERE job=?', existing.id);
            this.ctx.storage.sql.exec('DELETE FROM jobs WHERE id=?', existing.id);
          }
          const id = crypto.randomUUID();
          this.ctx.storage.sql.exec("INSERT INTO jobs (id,fingerprint,payload,mode,status,week,created) VALUES (?,?,?,?,'queued',?,?)", id, fingerprint, JSON.stringify(input), input.mode, quota.weekStart, Date.now());
          return json({...this.view(this.getJob(id)), duplicate: false, quota: this.quota()}, 202);
        });
      }
      const match = /^\/v1\/jobs\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (match && request.method === 'GET') {
        const raw = url.searchParams.get('from') ?? '0';
        if (!/^\d{1,4}$/.test(raw)) throw new ApiError(400, 'invalid_cursor');
        return json({...this.view(this.getJob(match[1]), Number(raw)), quota: this.quota()});
      }
      if (match && request.method === 'DELETE') {
        await this.ctx.storage.setAlarm(Date.now() + 100);
        const job = this.getJob(match[1]);
        if (['queued', 'running'].includes(job.status)) this.ctx.storage.sql.exec("UPDATE jobs SET status='cancelled',terminal=? WHERE id=?", Date.now(), job.id);
        return json({...this.view(this.getJob(job.id)), quota: this.quota()});
      }
      throw new ApiError(404, 'not_found');
    } catch (error) {
      if (error instanceof ApiError) return json({error: error.code, ...(error.status === 429 ? {quota: this.quota()} : {})}, error.status);
      return json({error: 'internal_error'}, 500);
    }
  }
  async alarm(): Promise<void> {
    if (this.busy) { await this.ctx.storage.setAlarm(Date.now() + 2000); return; }
    this.busy = true;
    try {
      await this.refreshEntitlement();
      await this.coach.alarm();
      this.prune(Date.now());
      const job = this.rows<Job & Record<string, SqlStorageValue>>("SELECT * FROM jobs WHERE status IN ('running','queued') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,created,rowid LIMIT 1")[0];
      if (!job) return;
      this.ctx.storage.sql.exec("UPDATE jobs SET status='running' WHERE id=?", job.id);
      // fetch が途中で落ちても、この watchdog が保存済み cursor から再開する。
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      const input = JSON.parse(job.payload) as Input;
      try {
        const namespace = job.mode === 'std' ? this.env.STD : this.env.PRECISE;
        // shortcut: 中継はモード別2枠。公開時に負荷計測して枠数と max_instances を同時調整する。
        const slot = parseInt(this.ctx.id.toString().slice(0, 8), 16) % 2;
        const response = await namespace.getByName('slot-' + slot).fetch('http://container/analyze', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({...input, ply: job.cursor}), signal: AbortSignal.timeout(45_000),
        });
        if (response.status === 422) {
          this.ctx.storage.sql.exec("UPDATE jobs SET status='failed',terminal=?,error='invalid_position_or_move' WHERE id=? AND status='running'", Date.now(), job.id);
          return;
        }
        if (!response.ok) throw new Error('container_http_' + response.status);
        const result = await response.json() as {ply?: number};
        if (result.ply !== job.cursor) throw new Error('invalid_result');
        const completedAt = Date.now();
        const proof = job.mode === 'precise' && job.cursor === input.moves.length && this.env.COACH_SIGNING_KEY
          ? await signAnalysis(this.env.COACH_SIGNING_KEY, this.ctx.id.toString(), job.id, input,
            [...this.rows<{data: string}>('SELECT data FROM results WHERE job=? ORDER BY ply', job.id).map(x => JSON.parse(x.data)), result], completedAt)
          : null;
        this.ctx.storage.transactionSync(() => {
          const current = this.getJob(job.id);
          if (current.status !== 'running' || current.cursor !== job.cursor) return;
          this.ctx.storage.sql.exec('INSERT OR IGNORE INTO results VALUES (?,?,?)', job.id, job.cursor, JSON.stringify(result));
          const completed = job.cursor === input.moves.length;
          this.ctx.storage.sql.exec('UPDATE jobs SET cursor=cursor+1,attempts=0,status=?,terminal=? WHERE id=?', completed ? 'completed' : 'running', completed ? completedAt : null, job.id);
          if (completed) console.log(JSON.stringify({event: 'analysis_completed', mode: job.mode}));
          if (completed && proof) this.ctx.storage.sql.exec('INSERT OR REPLACE INTO coach_proofs VALUES (?,?)', job.id, JSON.stringify(proof));
          if (completed) this.ctx.storage.sql.exec('INSERT INTO usage VALUES (?,1,?) ON CONFLICT(week) DO UPDATE SET total=total+1,precise=precise+excluded.precise', job.week, job.mode === 'precise' ? 1 : 0);
        });
      } catch (error) {
        console.warn('解析の再試行', {jobId: job.id, ply: job.cursor, reason: error instanceof Error ? error.message : 'unknown'});
        const attempts = job.attempts + 1;
        this.ctx.storage.sql.exec("UPDATE jobs SET attempts=?,status=?,terminal=?,error=? WHERE id=? AND status='running' AND cursor=?", attempts, attempts >= 5 ? 'failed' : 'running', attempts >= 5 ? Date.now() : null, attempts >= 5 ? 'analysis_unavailable' : null, job.id, job.cursor);
      }
    } finally {
      this.busy = false;
      const next = this.rows<{attempts: number}>("SELECT attempts FROM jobs WHERE status IN ('running','queued') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,created,rowid LIMIT 1")[0];
      const expiry = this.rows<{expiry: number}>('SELECT MIN(terminal) + ? AS expiry FROM jobs WHERE terminal IS NOT NULL', RETENTION_MS)[0]?.expiry;
      const coachAlarm = this.coach.nextAlarm();
      if (next) await this.ctx.storage.setAlarm(Date.now() + (next.attempts ? Math.min(30_000, 1000 * 2 ** next.attempts) : 100));
      else if (expiry) await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, expiry));
      else await this.ctx.storage.deleteAlarm();
      if (coachAlarm !== null) {
        const current = await this.ctx.storage.getAlarm();
        if (current === null || current > coachAlarm) await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, coachAlarm));
      }
    }
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      // ネイティブアプリ専用。CORSを許可せず、ブラウザ由来の処理自体も拒否する。
      if (env.ENVIRONMENT === 'production' && (request.headers.has('Origin') || request.method === 'OPTIONS')) throw new ApiError(403, 'browser_forbidden');
      const ip = await sha256(request.headers.get('CF-Connecting-IP') ?? 'unknown');
      if (url.pathname === '/admin/invitations' || /^\/admin\/invitations\/[a-f0-9]{64}$/.test(url.pathname)) {
        await limit(env.REGISTRATION_LIMITER, 'admin:' + ip, env.ENVIRONMENT);
        if (!env.INVITE_ADMIN_KEY || await sha256(request.headers.get('Authorization') ?? '') !== await sha256('Bearer ' + env.INVITE_ADMIN_KEY)) throw new ApiError(401, 'unauthorized');
        const registry = env.INVITATIONS.getByName('registry');
        if (request.method === 'DELETE' && url.pathname !== '/admin/invitations') return json(await registry.revoke(url.pathname.split('/').pop()!));
        if (request.method !== 'POST' || url.pathname !== '/admin/invitations') throw new ApiError(404, 'not_found');
        const input = await readJson(request, 1024) as any;
        if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'expiresAt,hash,maxDevices') throw new ApiError(400, 'invalid_input');
        const result = await registry.create(input.hash, input.maxDevices, input.expiresAt);
        return json(result, 'error' in result ? 400 : 201);
      }
      if (url.pathname === '/v1/devices' && request.method === 'POST') {
        await limit(env.REGISTRATION_LIMITER, 'register:' + ip, env.ENVIRONMENT);
        if (request.body) {
          const reader = request.body.getReader();
          while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            if (value.byteLength) { await reader.cancel(); throw new ApiError(400, 'body_not_allowed'); }
          }
        }
        // shortcut: 端末実在性は未検証。一般公開前に App Attest / Play Integrity を追加する。
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const token = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        const hash = await sha256(token);
        const registered = await env.DEVICES.getByName(hash).fetch('https://device/register?hash=' + hash, {method: 'POST'});
        if (!registered.ok) throw new ApiError(503, 'registration_unavailable');
        console.log(JSON.stringify({event: 'device_created'}));
        return json({token}, 201);
      }
      if (!['/v1/jobs', '/v1/quota', '/v1/realtime', '/v1/coach', '/v1/entitlements', '/v1/invitations/redeem'].includes(url.pathname) && !/^\/v1\/(?:jobs|realtime|coach)\/[0-9a-f-]{36}$/.test(url.pathname)) throw new ApiError(404, 'not_found');
      const auth = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('Authorization') ?? '');
      if (!auth) throw new ApiError(401, 'unauthorized');
      const hash = await sha256(auth[1]);
      await limit(env.API_LIMITER, hash, env.ENVIRONMENT);
      const family = url.pathname.split('/')[2];
      if (!['GET', 'DELETE'].includes(request.method)) await limit(env.WRITE_LIMITER, hash + ':' + family, env.ENVIRONMENT);
      if (url.pathname === '/v1/invitations/redeem') {
        await limit(env.INVITE_LIMITER, 'device:' + hash, env.ENVIRONMENT);
        await limit(env.INVITE_LIMITER, 'ip:' + ip, env.ENVIRONMENT);
      }
      // 外部ヘッダーは必要なAPI指定だけ許可し、認証・内部設定・偽装した権利を転送しない。
      const headers = new Headers();
      for (const name of ['Content-Type', 'Prefer']) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      headers.set('X-Invite-IP', ip);
      // 権利判定の結果だけを渡す。secretの値・設定一式はDO自身のenvから読む。
      const paid = ['local', 'staging'].includes(env.ENVIRONMENT) && env.ALLOW_DEV_PAID === 'true'
        && (env.DEV_PAID_HASHES ?? '').split(',').map(x => x.trim()).includes(hash);
      headers.set('X-Dev-Paid', paid ? '1' : '0');
      let response = await env.DEVICES.getByName(hash).fetch(new Request(request, {headers}));
      if (response.status === 429 && family === 'invitations') {
        response = new Response(response.body, response);
        response.headers.set('Retry-After', '900');
      }
      console.log(JSON.stringify({event: 'api', family, method: request.method, status: response.status}));
      return response;
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      console.warn(JSON.stringify({event: 'api_rejected', status, error: error instanceof ApiError ? error.code : 'internal_error'}));
      const response = json({error: error instanceof ApiError ? error.code : 'internal_error'}, status);
      if (status === 429) response.headers.set('Retry-After', '60');
      return response;
    }
  },
} satisfies ExportedHandler<Env>;
