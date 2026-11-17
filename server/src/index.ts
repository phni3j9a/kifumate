import { DurableObject } from 'cloudflare:workers';
import { Container } from '@cloudflare/containers';
import { ApiError, RETENTION_MS, json, parseInput, readJson, sha256, weekStart, type Input, type Mode } from './model';

export interface Env {
  DEVICES: DurableObjectNamespace<Device>;
  STD: DurableObjectNamespace<StandardContainer>;
  PRECISE: DurableObjectNamespace<PreciseContainer>;
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

interface Job {
  id: string; fingerprint: string; payload: string; mode: Mode;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  cursor: number; week: number; created: number; terminal: number | null;
  attempts: number; error: string | null;
}
export class Device extends DurableObject<Env> {
  private busy = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, payload TEXT NOT NULL,
        mode TEXT NOT NULL, status TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
        week INTEGER NOT NULL, created INTEGER NOT NULL, terminal INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE TABLE IF NOT EXISTS results (job TEXT NOT NULL, ply INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job,ply));
      CREATE TABLE IF NOT EXISTS usage (week INTEGER PRIMARY KEY, total INTEGER NOT NULL, precise INTEGER NOT NULL);`);
  }
  private rows<T extends Record<string, SqlStorageValue>>(sql: string, ...params: SqlStorageValue[]): T[] {
    return this.ctx.storage.sql.exec<T>(sql, ...params).toArray();
  }
  private paid(): boolean {
    // shortcut: ストア検証は未実装。公開前に購入権利検証へ置き換える。production では常に無効。
    return ['local', 'staging'].includes(this.env.ENVIRONMENT) && this.env.ALLOW_DEV_PAID === 'true'
      && (this.env.DEV_PAID_HASHES ?? '').split(',').map(x => x.trim()).includes(this.ctx.id.name ?? '');
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
      results: this.rows<{data: string}>('SELECT data FROM results WHERE job=? AND ply>=? ORDER BY ply', job.id, from).map(x => JSON.parse(x.data))};
  }
  private prune(now: number) {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM results WHERE job IN (SELECT id FROM jobs WHERE terminal IS NOT NULL AND terminal<=?)', now - RETENTION_MS);
      this.ctx.storage.sql.exec('DELETE FROM jobs WHERE terminal IS NOT NULL AND terminal<=?', now - RETENTION_MS);
      this.ctx.storage.sql.exec('DELETE FROM usage WHERE week<?', weekStart(now) - 7 * 86400_000);
    });
  }
  async fetch(request: Request): Promise<Response> {
    try {
      this.prune(Date.now());
      const url = new URL(request.url);
      if (url.pathname === '/register' && request.method === 'POST') {
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO meta VALUES ('registered','1')");
        return json({ok: true}, 201);
      }
      if (!this.rows('SELECT key FROM meta WHERE key=?', 'registered').length) throw new ApiError(401, 'unauthorized');
      if (url.pathname === '/v1/quota' && request.method === 'GET') return json(this.quota());
      if (url.pathname === '/v1/jobs' && request.method === 'GET') {
        return json({jobs: this.rows<Job & Record<string, SqlStorageValue>>('SELECT * FROM jobs ORDER BY created,id').map(j => ({...this.view(j, j.cursor), results: undefined})), quota: this.quota()});
      }
      if (url.pathname === '/v1/jobs' && request.method === 'POST') {
        const input = parseInput(await readJson(request));
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
      this.prune(Date.now());
      const job = this.rows<Job & Record<string, SqlStorageValue>>("SELECT * FROM jobs WHERE status IN ('running','queued') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,created,rowid LIMIT 1")[0];
      if (!job) return;
      this.ctx.storage.sql.exec("UPDATE jobs SET status='running' WHERE id=?", job.id);
      // fetch が途中で落ちても、この watchdog が保存済み cursor から再開する。
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      const input = JSON.parse(job.payload) as Input;
      try {
        const namespace = job.mode === 'std' ? this.env.STD : this.env.PRECISE;
        const response = await namespace.getByName(this.ctx.id.toString()).fetch('http://container/analyze', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({...input, ply: job.cursor}), signal: AbortSignal.timeout(45_000),
        });
        if (response.status === 422) {
          this.ctx.storage.sql.exec("UPDATE jobs SET status='failed',terminal=?,error='invalid_position_or_move' WHERE id=? AND status='running'", Date.now(), job.id);
          return;
        }
        if (!response.ok) throw new Error('analysis_unavailable');
        const result = await response.json() as {ply?: number};
        if (result.ply !== job.cursor) throw new Error('invalid_result');
        this.ctx.storage.transactionSync(() => {
          const current = this.getJob(job.id);
          if (current.status !== 'running' || current.cursor !== job.cursor) return;
          this.ctx.storage.sql.exec('INSERT OR IGNORE INTO results VALUES (?,?,?)', job.id, job.cursor, JSON.stringify(result));
          const completed = job.cursor === input.moves.length;
          this.ctx.storage.sql.exec('UPDATE jobs SET cursor=cursor+1,attempts=0,status=?,terminal=? WHERE id=?', completed ? 'completed' : 'running', completed ? Date.now() : null, job.id);
          if (completed) this.ctx.storage.sql.exec('INSERT INTO usage VALUES (?,1,?) ON CONFLICT(week) DO UPDATE SET total=total+1,precise=precise+excluded.precise', job.week, job.mode === 'precise' ? 1 : 0);
        });
      } catch {
        const attempts = job.attempts + 1;
        this.ctx.storage.sql.exec("UPDATE jobs SET attempts=?,status=?,terminal=?,error=? WHERE id=? AND status='running' AND cursor=?", attempts, attempts >= 5 ? 'failed' : 'running', attempts >= 5 ? Date.now() : null, attempts >= 5 ? 'analysis_unavailable' : null, job.id, job.cursor);
      }
    } finally {
      this.busy = false;
      const next = this.rows<{attempts: number}>("SELECT attempts FROM jobs WHERE status IN ('running','queued') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,created,rowid LIMIT 1")[0];
      const expiry = this.rows<{expiry: number}>('SELECT MIN(terminal) + ? AS expiry FROM jobs WHERE terminal IS NOT NULL', RETENTION_MS)[0]?.expiry;
      if (next) await this.ctx.storage.setAlarm(Date.now() + (next.attempts ? Math.min(30_000, 1000 * 2 ** next.attempts) : 100));
      else if (expiry) await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, expiry));
      else await this.ctx.storage.deleteAlarm();
    }
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/v1/devices' && request.method === 'POST') {
        if (request.body) { await request.body.cancel(); throw new ApiError(400, 'body_not_allowed'); }
        // shortcut: 端末実在性・発行数制限は未実装。公開前に App Attest / Play Integrity と入口のレート制限を追加する。
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const token = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        const hash = await sha256(token);
        const registered = await env.DEVICES.getByName(hash).fetch('https://device/register', {method: 'POST'});
        if (!registered.ok) throw new ApiError(503, 'registration_unavailable');
        return json({token}, 201);
      }
      if (!['/v1/jobs', '/v1/quota'].includes(url.pathname) && !/^\/v1\/jobs\/[0-9a-f-]{36}$/.test(url.pathname)) throw new ApiError(404, 'not_found');
      const auth = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('Authorization') ?? '');
      if (!auth) throw new ApiError(401, 'unauthorized');
      const hash = await sha256(auth[1]);
      const headers = new Headers(request.headers); headers.delete('Authorization');
      return await env.DEVICES.getByName(hash).fetch(new Request(request, {headers}));
    } catch (error) {
      return json({error: error instanceof ApiError ? error.code : 'internal_error'}, error instanceof ApiError ? error.status : 500);
    }
  },
} satisfies ExportedHandler<Env>;
