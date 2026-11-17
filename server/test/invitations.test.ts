import { env } from 'cloudflare:workers';
import { SELF, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker, { Device, type Env } from '../src/index';
import { Invitations, limit } from '../src/invitations';
import { generateInviteCode, normalizeInviteCode } from '../src/invite-code.mjs';
import { sha256 } from '../src/model';

const bindings = env as unknown as Env;
const registry = () => bindings.INVITATIONS.getByName(crypto.randomUUID());
const headers = (token: string) => ({Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'});
async function device() {
  const response = await SELF.fetch('https://api/v1/devices', {method: 'POST'});
  return (await response.json() as {token: string}).token;
}
async function issue(store: DurableObjectStub<Invitations>, maxDevices = 1, expiresAt: number | null = null) {
  const code = generateInviteCode();
  const hash = await sha256(normalizeInviteCode(code)!);
  expect(await store.create(hash, maxDevices, expiresAt)).toEqual({ok: true});
  return {code, hash};
}

describe('Crockford Base32の入力正規化', () => {
  it('80ビットの16文字を4文字ずつ区切り、原文を正規化してハッシュ化できる', () => {
    const codes = Array.from({length: 100}, generateInviteCode);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
      expect(normalizeInviteCode(code)).toBe(code.replaceAll('-', ''));
    }
  });
  it.each([
    'OIL0-1234-ABCD-EFGH', 'oil0 1234 abcd efgh', 'ｏｉｌ０　－１２３４‐ａｂｃｄ \nｅｆｇｈ', '01101234ABCDEFGH',
  ])('大小文字・全角・空白・ハイフン・読み替えを同じ値へ正規化する: %s', code => {
    expect(normalizeInviteCode(code)).toBe('01101234ABCDEFGH');
  });
  it.each(['a'.repeat(64), 'ABCD-EFGH-JKMN-PQRU', 'ABCD_EFGH_JKMN_PQRS', 'ABCD-EFGH-JKMN-PQR', '招待ABCD-EFGH-JKMN-PQRS', ''])('旧形式・長さ違い・不正文字は拒否する: %s', code => {
    expect(normalizeInviteCode(code)).toBeNull();
  });
});

describe('招待コードの永続権利', () => {
  it('ハッシュだけを保存し、重複入力は枠を増やさず、上限を並列でも超えない', async () => {
    const store = registry(), {code, hash} = await issue(store);
    expect(await store.redeem('device-a', hash)).toMatchObject({paid: true, source: 'invite'});
    expect(await store.redeem('device-a', hash)).toMatchObject({paid: true});
    expect(await store.redeem('device-b', hash)).toEqual({error: 'invite_full'});
    const rows = await runInDurableObject(store, (_, state) => state.storage.sql.exec('SELECT * FROM invites').toArray());
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(JSON.stringify(rows)).not.toContain(normalizeInviteCode(code));
    expect(rows[0].hash).toBe(hash);
    const next = await issue(store);
    const results = await Promise.all(['a', 'b', 'c'].map(id => store.redeem(id, next.hash)));
    expect(results.filter(x => 'paid' in x)).toHaveLength(1);
  });
  it('期限・取消・不存在を無効にし、別の有効コードがあれば有料のまま', async () => {
    const store = registry(), {hash} = await issue(store, 2, Date.now() + 60_000);
    await store.redeem('a', hash);
    expect((await store.entitlement('a')).expiresAt).not.toBeNull();
    await runInDurableObject(store, (_, state) => state.storage.sql.exec('UPDATE invites SET expires=? WHERE hash=?', Date.now() - 1, hash));
    expect(await store.entitlement('a')).toEqual({paid: false, source: null, expiresAt: null});
    expect(await store.redeem('b', hash)).toEqual({error: 'invite_invalid'});
    const permanent = await issue(store);
    await store.redeem('a', permanent.hash);
    expect((await store.entitlement('a')).paid).toBe(true);
    await store.revoke(permanent.hash);
    expect((await store.entitlement('a')).paid).toBe(false);
    expect(await store.redeem('a', permanent.hash)).toEqual({error: 'invite_invalid'});
    expect(await store.redeem('a', '0'.repeat(64))).toEqual({error: 'invite_invalid'});
    expect(await store.create(hash, 0, null)).toEqual({error: 'invalid_invite'});
    expect(await store.create(hash, 1, Date.now() - 1)).toEqual({error: 'invalid_invite'});
  });
  it('端末5回・IP20回/15分を全拠点で共有し、窓終了後だけ戻す', async () => {
    const store = registry();
    for (let i = 0; i < 5; i++) expect(await store.attempt('a', 'ip-a')).toBe(true);
    expect(await store.attempt('a', 'ip-b')).toBe(false);
    for (let i = 0; i < 20; i++) expect(await store.attempt('device-' + i, 'ip-c')).toBe(true);
    expect(await store.attempt('new', 'ip-c')).toBe(false);
    await runInDurableObject(store, (_, state) => state.storage.sql.exec('UPDATE attempts SET started=?', Date.now() - 900_001));
    expect(await store.attempt('a', 'ip-a')).toBe(true);
  });
  it('アプリAPIは入力後に有料になり、取消はquotaと精密APIへ次の呼び出しで反映する', async () => {
    const token = await device(), store = bindings.INVITATIONS.getByName('registry');
    const {code, hash} = await issue(store);
    const request = (path: string, method = 'GET', data?: unknown) => SELF.fetch('https://api' + path, {
      method, headers: {...headers(token), 'X-Dev-Paid': '1'}, ...(data === undefined ? {} : {body: JSON.stringify(data)}),
    });
    expect(await (await request('/v1/entitlements')).json()).toEqual({paid: false, source: null, expiresAt: null});
    expect(await (await request('/v1/invitations/redeem', 'POST', {code})).json()).toEqual({paid: true, source: 'invite', expiresAt: null});
    expect((await (await request('/v1/quota')).json() as any).paid).toBe(true);
    await store.revoke(hash);
    expect((await (await request('/v1/quota')).json() as any).paid).toBe(false);
    expect((await request('/v1/jobs', 'POST', {initial: 'startpos', moves: [], mode: 'precise'})).status).toBe(403);
    expect((await request('/v1/invitations/redeem', 'POST', {code})).status).toBe(400);
  });
  it('APIでも全角・小文字・読み替えの入力を同じハッシュとして扱い、原文を保存しない', async () => {
    const token = await device(), store = bindings.INVITATIONS.getByName('registry');
    const canonical = '01101234ABCDEFGH', hash = await sha256(canonical);
    expect(await store.create(hash, 1, null)).toEqual({ok: true});
    const redeem = (code: unknown) => SELF.fetch('https://api/v1/invitations/redeem', {
      method: 'POST', headers: headers(token), body: JSON.stringify({code}),
    });
    try {
      expect((await redeem('ｏｉｌ０　－１２３４‐ａｂｃｄ \nｅｆｇｈ')).status).toBe(200);
      expect((await redeem('0110-1234-ABCD-EFGH')).status).toBe(200);
      expect((await redeem('a'.repeat(64))).status).toBe(400);
      expect((await redeem(1234)).status).toBe(400);
      const rows = await runInDurableObject(store, (_, state) => state.storage.sql.exec('SELECT * FROM invites WHERE hash=?', hash).toArray());
      expect(JSON.stringify(rows)).not.toContain(canonical);
    } finally { await store.revoke(hash); }
  });
  it('本文受信中に取り消された精密解析を受理しない', async () => {
    const token = await device(), hash = await sha256(token), store = bindings.INVITATIONS.getByName('registry');
    const invitation = await issue(store);
    await store.redeem(hash, invitation.hash);
    const stub = bindings.DEVICES.getByName(hash);
    await runInDurableObject(stub, async (instance: Device) => {
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => {release = resolve;});
      const started = new Promise<void>(resolve => {entered = resolve;});
      const body = new ReadableStream({async pull(controller) { entered(); await gate; controller.enqueue(new TextEncoder().encode(JSON.stringify({initial: 'startpos', moves: [], mode: 'precise'}))); controller.close(); }});
      const pending = instance.fetch(new Request('https://device/v1/jobs', {method: 'POST', headers: {'Content-Type': 'application/json'}, body}));
      await started; await (instance as any).env.INVITATIONS.getByName('registry').revoke(invitation.hash); release();
      expect((await pending).status).toBe(403);
    });
  });
  it('不正形式も試行として数え、6回目はJSONを読む前に拒否する', async () => {
    const token = await device();
    for (let i = 0; i < 5; i++) {
      expect((await SELF.fetch('https://api/v1/invitations/redeem', {method: 'POST', headers: headers(token), body: '{"code":"bad"}'})).status).toBe(400);
    }
    const response = await SELF.fetch('https://api/v1/invitations/redeem', {method: 'POST', headers: headers(token), body: '{}'});
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('900');
    expect(await response.json()).toMatchObject({error: 'invite_rate_limited'});
  });
});

describe('入口のレート制限と管理認証', () => {
  it('公式bindingを使い、キー別に拒否・窓を管理する', async () => {
    const binding = (env as any).TEST_LIMITER as RateLimit, key = crypto.randomUUID();
    await limit(binding, key, 'staging'); await limit(binding, key, 'staging');
    await expect(limit(binding, key, 'staging')).rejects.toThrow('rate_limited');
    await expect(limit(binding, key + '-other', 'staging')).resolves.toBeUndefined();
    await expect(limit(undefined, key, 'production')).rejects.toThrow('rate_limit_unavailable');
  });
  it('端末作成はIP、各APIは端末と操作種別、コード入力はIPと端末で制限する', async () => {
    const calls: string[] = [];
    const limiter = {limit: vi.fn(async ({key}: {key: string}) => {calls.push(key); return {success: true};})};
    const config = {...bindings, REGISTRATION_LIMITER: limiter, API_LIMITER: limiter, WRITE_LIMITER: limiter, INVITE_LIMITER: limiter} as Env;
    await worker.fetch(new Request('https://api/v1/devices', {method: 'POST', headers: {'CF-Connecting-IP': '192.0.2.1'}}), config);
    expect(calls).toContain('register:' + await sha256('192.0.2.1'));
    const token = await device(), hash = await sha256(token);
    await worker.fetch(new Request('https://api/v1/invitations/redeem', {method: 'POST', headers: headers(token), body: '{}'}), config);
    expect(calls).toEqual(expect.arrayContaining([hash, hash + ':invitations', 'device:' + hash, 'ip:' + await sha256('unknown')]));
    const denied = {limit: async () => ({success: false})};
    const registration = await worker.fetch(new Request('https://api/v1/devices', {method: 'POST'}), {...config, REGISTRATION_LIMITER: denied});
    expect(registration.status).toBe(429); expect(registration.headers.get('Retry-After')).toBe('60');
    for (const path of ['/v1/quota', '/v1/jobs', '/v1/realtime', '/v1/coach', '/v1/entitlements']) {
      expect((await worker.fetch(new Request('https://api' + path, {headers: headers(token)}), {...config, API_LIMITER: denied})).status).toBe(429);
    }
    expect((await worker.fetch(new Request('https://api/v1/jobs', {method: 'POST', headers: headers(token), body: '{}'}), {...config, WRITE_LIMITER: denied})).status).toBe(429);
  });
  it('管理APIは管理鍵だけを許可し、コードではなくハッシュを受け取る', async () => {
    const key = '1'.repeat(64), config = {...bindings, INVITE_ADMIN_KEY: key};
    const input = {hash: await sha256(crypto.randomUUID()), maxDevices: 2, expiresAt: null};
    const request = (authorization: string) => new Request('https://api/admin/invitations', {method: 'POST', headers: {Authorization: authorization, 'Content-Type': 'application/json'}, body: JSON.stringify(input)});
    expect((await worker.fetch(request('Bearer wrong'), config)).status).toBe(401);
    expect((await worker.fetch(request('Bearer ' + key), config)).status).toBe(201);
    expect((await worker.fetch(request('Bearer ' + key), config)).status).toBe(400);
    expect((await worker.fetch(new Request('https://api/admin/invitations/' + input.hash, {method: 'DELETE', headers: {Authorization: 'Bearer ' + key}}), config)).status).toBe(200);
  });
});
