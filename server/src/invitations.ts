import { DurableObject } from 'cloudflare:workers';
import { ApiError } from './model';

interface Invite extends Record<string, SqlStorageValue> { hash: string; max_devices: number; expires: number | null; revoked: number }
export interface Entitlement { paid: boolean; source: 'invite' | null; expiresAt: number | null }
export class Invitations extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS invites (hash TEXT PRIMARY KEY, max_devices INTEGER NOT NULL, expires INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS redemptions (device TEXT NOT NULL, invite TEXT NOT NULL, PRIMARY KEY(device,invite));
      CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, started INTEGER NOT NULL, count INTEGER NOT NULL);`);
  }
  create(hash: string, maxDevices: number, expiresAt: number | null) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(maxDevices) || maxDevices < 1 || maxDevices > 100
      || (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()))) return {error: 'invalid_invite'};
    if (this.ctx.storage.sql.exec('SELECT hash FROM invites WHERE hash=?', hash).toArray().length) return {error: 'invite_exists'};
    this.ctx.storage.sql.exec('INSERT INTO invites (hash,max_devices,expires) VALUES (?,?,?)', hash, maxDevices, expiresAt);
    return {ok: true};
  }
  revoke(hash: string) {
    this.ctx.storage.sql.exec('UPDATE invites SET revoked=1 WHERE hash=?', hash);
    return {ok: true};
  }
  attempt(device: string, ip: string): boolean {
    const now = Date.now(), window = 15 * 60_000;
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM attempts WHERE started<=?', now - window);
      const keys = [[`device:${device}`, 5], [`ip:${ip}`, 20]] as const;
      if (keys.some(([key, limit]) => (this.ctx.storage.sql.exec<{count: number}>('SELECT count FROM attempts WHERE key=?', key).toArray()[0]?.count ?? 0) >= limit)) return false;
      for (const [key] of keys) this.ctx.storage.sql.exec('INSERT INTO attempts VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET count=count+1', key, now);
      return true;
    });
  }
  entitlement(device: string): Entitlement {
    const active = this.ctx.storage.sql.exec<{expires: number | null}>(`SELECT expires FROM invites JOIN redemptions ON invite=hash
      WHERE device=? AND revoked=0 AND (expires IS NULL OR expires>?) ORDER BY expires IS NULL DESC, expires DESC LIMIT 1`, device, Date.now()).toArray()[0];
    return {paid: !!active, source: active ? 'invite' : null, expiresAt: active?.expires ?? null};
  }
  redeem(device: string, hash: string): {error: string} | Entitlement {
    return this.ctx.storage.transactionSync(() => {
      const invite = this.ctx.storage.sql.exec<Invite>('SELECT * FROM invites WHERE hash=?', hash).toArray()[0];
      // 有効性の内訳は公開せず、コードの存在を調べる手掛かりを減らす。
      if (!invite || invite.revoked || (invite.expires !== null && invite.expires <= Date.now())) return {error: 'invite_invalid'};
      const used = this.ctx.storage.sql.exec('SELECT device FROM redemptions WHERE invite=? AND device=?', hash, device).toArray().length;
      const count = this.ctx.storage.sql.exec<{n: number}>('SELECT COUNT(*) AS n FROM redemptions WHERE invite=?', hash).one().n;
      if (!used && count >= invite.max_devices) return {error: 'invite_full'};
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO redemptions VALUES (?,?)', device, hash);
      return this.entitlement(device);
    });
  }
}

export async function limit(binding: RateLimit | undefined, key: string, environment: string) {
  if (!binding) {
    if (environment !== 'local') throw new ApiError(503, 'rate_limit_unavailable');
    return;
  }
  if (!(await binding.limit({key})).success) throw new ApiError(429, 'rate_limited');
}
