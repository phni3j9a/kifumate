import { env } from 'cloudflare:workers';
import { SELF, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { parseInput, sha256, weekStart, RETENTION_MS } from '../src/model';
import { Device } from '../src/index';

const devices = (env as unknown as {DEVICES: DurableObjectNamespace<Device>}).DEVICES;
const base = {initial: 'startpos', moves: ['7g7f'], mode: 'std'};
const paidStubs = new Set<unknown>();
async function setup(paid = false) {
  const name = await sha256(crypto.randomUUID());
  const stub = devices.getByName(name);
  await stub.fetch('https://device/register?hash=' + name, {method: 'POST'});
  if (paid) paidStubs.add(stub);
  await runInDurableObject(stub, (instance: any) => {
    instance.env.ENVIRONMENT = 'staging';
    const mock = {getByName: () => ({fetch: async (_url: string, init: RequestInit) => {
      const data = JSON.parse(init.body as string);
      return Response.json({ply: data.ply, score: {kind: 'cp', value: 10}, candidates: [], mate: null});
    }})};
    instance.env.STD = mock; instance.env.PRECISE = mock;
  });
  return stub;
}
async function request(stub: any, path: string, method = 'GET', data?: unknown) {
  const response = await stub.fetch('https://device' + path, {method,
    headers: {'X-Dev-Paid': paidStubs.has(stub) ? '1' : '0', 'content-type': 'application/json'},
    ...(data === undefined ? {} : {body: JSON.stringify(data)})});
  return {status: response.status, data: await response.json() as any};
}
async function tick(stub: any) { await runInDurableObject(stub, (instance: any) => instance.alarm()); }
async function sql(stub: any, query: string, ...params: any[]) {
  return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec(query, ...params).toArray());
}

describe('JST と入力境界', () => {
  it('日曜23:59:59 JST と月曜00:00 JST を別週にする', () => {
    const before = Date.parse('2026-11-15T14:59:59.999Z');
    const monday = Date.parse('2026-11-15T15:00:00Z');
    expect(weekStart(before)).toBe(monday - 7 * 86400_000);
    expect(weekStart(monday)).toBe(monday);
    expect(weekStart(Date.parse('2026-11-16T00:00:00Z'))).toBe(monday);
  });
  it('対局者名・不正形式・過長棋譜を拒否する', () => {
    expect(() => parseInput({...base, sente: 'name'})).toThrow();
    expect(() => parseInput({...base, moves: Array(513).fill('7g7f')})).toThrow();
    expect(() => parseInput({...base, initial: 'startpos\nquit'})).toThrow();
    expect(() => parseInput({...base, moves: ['resign']})).toThrow();
    expect(parseInput({...base, initial: '  startpos  '})).toEqual(base);
  });
});

describe('匿名認証', () => {
  it('乱数トークンを発行しハッシュのDOだけを認証する', async () => {
    const reg = await SELF.fetch('https://api/v1/devices', {method: 'POST'});
    const {token} = await reg.json() as any;
    expect(reg.status).toBe(201); expect(token).toMatch(/^[a-f0-9]{64}$/);
    const hash = await sha256(token);
    expect(await sql(devices.getByName(hash), 'SELECT * FROM meta ORDER BY key')).toEqual([{key: 'hash', value: hash}, {key: 'registered', value: '1'}]);
    const quota = await SELF.fetch('https://api/v1/quota', {headers: {Authorization: `Bearer ${token}`, 'X-Dev-Paid': '1'}});
    expect(quota.status).toBe(200); expect((await quota.json() as any).paid).toBe(false);
    expect((await SELF.fetch('https://api/v1/quota', {headers: {Authorization: `Bearer ${'a'.repeat(64)}`}})).status).toBe(401);
    expect((await SELF.fetch('https://api/v1/quota')).status).toBe(401);
    expect((await SELF.fetch('https://api/register', {method: 'POST'})).status).toBe(404);
  });
});

describe('永続ジョブと回数', () => {
  it('同一棋譜+モードは重複せず、順番待ちし、取り消すと枠を返す', async () => {
    const stub = await setup();
    const a = await request(stub, '/v1/jobs', 'POST', base);
    const dup = await request(stub, '/v1/jobs', 'POST', base);
    expect(a.status).toBe(202); expect(dup.data.id).toBe(a.data.id); expect(dup.data.duplicate).toBe(true);
    const b = await request(stub, '/v1/jobs', 'POST', {...base, moves: []});
    await tick(stub);
    expect((await request(stub, `/v1/jobs/${a.data.id}`)).data.status).toBe('running');
    expect((await request(stub, `/v1/jobs/${b.data.id}`)).data.status).toBe('queued');
    const cancelled = await request(stub, `/v1/jobs/${b.data.id}`, 'DELETE');
    expect(cancelled.data.status).toBe('cancelled'); expect(cancelled.data.quota.totalRemaining).toBe(9);
    await tick(stub);
    const done = await request(stub, `/v1/jobs/${a.data.id}?from=1`);
    expect(done.data.status).toBe('completed'); expect(done.data.results.map((x: any) => x.ply)).toEqual([1]);
    expect(done.data.quota.completed.total).toBe(1); expect(done.data.quota.reserved.total).toBe(0);
    expect((await request(stub, '/v1/jobs', 'POST', base)).data.id).toBe(a.data.id);
    expect((await request(stub, '/v1/jobs', 'POST', {...base, moves: []})).status).toBe(202);
  });
  it('実行中の中止後に届いた結果を捨てて、次の待ちを処理する', async () => {
    const stub = await setup();
    const a = await request(stub, '/v1/jobs', 'POST', base);
    const b = await request(stub, '/v1/jobs', 'POST', {...base, moves: []});
    await runInDurableObject(stub, async (instance: any) => {
      let started!: () => void; let release!: () => void;
      const called = new Promise<void>(resolve => {started = resolve;});
      const gate = new Promise<void>(resolve => {release = resolve;});
      instance.env.STD = {getByName: () => ({fetch: async (_url: string, init: RequestInit) => {
        started(); await gate;
        return Response.json({ply: JSON.parse(init.body as string).ply, score: {kind: 'cp', value: 0}, candidates: [], mate: null});
      }})};
      const running = instance.alarm();
      await called;
      const cancelled = await instance.fetch(new Request(`https://device/v1/jobs/${a.data.id}`, {method: 'DELETE'}));
      expect((await cancelled.json()).status).toBe('cancelled');
      release(); await running;
    });
    const cancelled = await request(stub, `/v1/jobs/${a.data.id}`);
    expect(cancelled.data.next).toBe(0); expect(cancelled.data.results).toEqual([]);
    expect(cancelled.data.quota.totalRemaining).toBe(9);
    await tick(stub);
    expect((await request(stub, `/v1/jobs/${b.data.id}`)).data.status).toBe('completed');
  });
  it('無料10局を予約込みで制限し、失敗・中止は集計しない', async () => {
    const stub = await setup();
    await sql(stub, 'INSERT INTO usage VALUES (?,9,0)', weekStart(Date.now()));
    const a = await request(stub, '/v1/jobs', 'POST', base);
    const limit = await request(stub, '/v1/jobs', 'POST', {...base, moves: []});
    expect(limit.status).toBe(429); expect(limit.data.quota.resetsAt).toBeGreaterThan(Date.now());
    await request(stub, `/v1/jobs/${a.data.id}`, 'DELETE');
    expect((await request(stub, '/v1/quota')).data.totalRemaining).toBe(1);
    const retry = await request(stub, '/v1/jobs', 'POST', base);
    await runInDurableObject(stub, (instance: any) => {
      instance.env.STD = {getByName: () => ({fetch: async () => new Response('', {status: 503})})};
    });
    for (let i = 0; i < 5; i++) await tick(stub);
    const failed = await request(stub, `/v1/jobs/${retry.data.id}`);
    expect(failed.data.status).toBe('failed'); expect(failed.data.quota.totalRemaining).toBe(1);
    expect(failed.data.quota.completed.total).toBe(9);
  });
  it('精密20局を使い切っても合計100局までstdが使える。productionで開発課金を無効化', async () => {
    const stub = await setup(true);
    await sql(stub, 'INSERT INTO usage VALUES (?,20,20)', weekStart(Date.now()));
    expect((await request(stub, '/v1/jobs', 'POST', {...base, mode: 'precise'})).status).toBe(429);
    expect((await request(stub, '/v1/jobs', 'POST', base)).status).toBe(202);
    await sql(stub, 'UPDATE usage SET total=100');
    expect((await request(stub, '/v1/jobs', 'POST', {...base, moves: []})).status).toBe(429);
    await runInDurableObject(stub, (instance: any) => {instance.env.ENVIRONMENT = 'production';});
    expect((await request(stub, '/v1/quota')).data.paid).toBe(false);
    expect((await request(stub, '/v1/jobs', 'POST', {...base, mode: 'precise'})).status).toBe(403);
  });
  it('コンテナの一時失敗後、永続cursorから再開して一度だけ集計する', async () => {
    const stub = await setup();
    const a = await request(stub, '/v1/jobs', 'POST', base);
    await tick(stub);
    await runInDurableObject(stub, (instance: any) => {
      let failed = false;
      instance.env.STD = {getByName: () => ({fetch: async (_url: string, init: RequestInit) => {
        if (!failed) {failed = true; throw new Error('stopped');}
        return Response.json({ply: JSON.parse(init.body as string).ply, score: {kind: 'cp', value: 20}, candidates: [], mate: null});
      }})};
    });
    await tick(stub);
    expect((await request(stub, `/v1/jobs/${a.data.id}`)).data.next).toBe(1);
    await tick(stub); await tick(stub);
    const done = await request(stub, `/v1/jobs/${a.data.id}`);
    expect(done.data.results.map((r: any) => r.ply)).toEqual([0, 1]);
    expect(done.data.status).toBe('completed'); expect(done.data.quota.completed.total).toBe(1);
  });
  it('完了7日後に結果とジョブを消し、回数集計は残す', async () => {
    const stub = await setup();
    const a = await request(stub, '/v1/jobs', 'POST', {...base, moves: []});
    await tick(stub);
    await sql(stub, 'UPDATE jobs SET terminal=?', Date.now() - RETENTION_MS + 60000);
    expect((await request(stub, `/v1/jobs/${a.data.id}`)).status).toBe(200);
    await sql(stub, 'UPDATE jobs SET terminal=?', Date.now() - RETENTION_MS);
    await tick(stub);
    expect((await request(stub, `/v1/jobs/${a.data.id}`)).status).toBe(404);
    expect(await sql(stub, 'SELECT * FROM results')).toEqual([]);
    expect((await request(stub, '/v1/quota')).data.completed.total).toBe(1);
  });
  it('同時重複要求を一つにし、モードが異なれば別ジョブにする', async () => {
    const stub = await setup(true);
    const [a, b] = await Promise.all([request(stub, '/v1/jobs', 'POST', base), request(stub, '/v1/jobs', 'POST', base)]);
    expect(a.data.id).toBe(b.data.id);
    const precise = await request(stub, '/v1/jobs', 'POST', {...base, mode: 'precise'});
    expect(precise.data.id).not.toBe(a.data.id);
    expect(precise.data.quota.reserved).toEqual({total: 2, precise: 1});
  });
  it('新しいDOインスタンスでもSQLiteのcursorから再開する', async () => {
    const stub = await setup();
    const a = await request(stub, '/v1/jobs', 'POST', base);
    await tick(stub);
    await runInDurableObject(stub, (instance: any, state) => {
      const restarted = new Device(state, instance.env);
      return restarted.alarm();
    });
    const done = await request(stub, `/v1/jobs/${a.data.id}`);
    expect(done.data.status).toBe('completed'); expect(done.data.next).toBe(2);
    expect(done.data.results.map((r: any) => r.ply)).toEqual([0, 1]);
  });
  it('不正な合法手列の失敗で枠を返し、差分カーソルの不正値を拒否する', async () => {
    const stub = await setup();
    const a = await request(stub, '/v1/jobs', 'POST', {...base, moves: ['7g7e']});
    await runInDurableObject(stub, (instance: any) => {
      instance.env.STD = {getByName: () => ({fetch: async () => new Response('', {status: 422})})};
    });
    await tick(stub);
    const failed = await request(stub, `/v1/jobs/${a.data.id}`);
    expect(failed.data.error).toBe('invalid_position_or_move');
    expect(failed.data.quota.totalRemaining).toBe(10);
    expect((await request(stub, `/v1/jobs/${a.data.id}?from=-1`)).status).toBe(400);
    expect((await request(stub, '/v1/jobs', 'POST', {...base, moves: [], sente: '名前'})).status).toBe(400);
  });
  it('本文サイズ・Content-Typeを入口で制限する', async () => {
    const stub = await setup();
    expect((await request(stub, '/v1/jobs', 'POST', {...base, extra: 'x'.repeat(17000)})).status).toBe(413);
    const response = await stub.fetch('https://device/v1/jobs', {method: 'POST', body: JSON.stringify(base)});
    expect(response.status).toBe(415);
    expect((await SELF.fetch('https://api/v1/devices', {method: 'POST', body: '名前'})).status).toBe(400);
  });
  it('後週へは予約と回数を持ち越さない', async () => {
    const stub = await setup();
    await sql(stub, 'INSERT INTO usage VALUES (?,10,0)', weekStart(Date.now()) - 7 * 86400_000);
    expect((await request(stub, '/v1/quota')).data.totalRemaining).toBe(10);
  });
});

it('分岐APIでも認証を通し、所有者・権利の内部ヘッダーを必ず上書きする', async () => {
  expect((await SELF.fetch('https://api/v1/realtime')).status).toBe(401);
  const reg = await SELF.fetch('https://api/v1/devices', {method: 'POST'});
  const {token} = await reg.json() as any;
  const hash = await sha256(token), stub = devices.getByName(hash);
  await runInDurableObject(stub, (instance: any) => {
    instance.env.REALTIME = {getByName: (slot: string) => ({fetch: async (request: Request) => Response.json({
      slot, owner: request.headers.get('X-Realtime-Owner'), paid: request.headers.get('X-Dev-Paid'),
      auth: request.headers.get('Authorization'), path: new URL(request.url).pathname,
    })})};
  });
  const response = await SELF.fetch('https://api/v1/realtime', {headers: {
    Authorization: 'Bearer ' + token, 'X-Realtime-Owner': 'f'.repeat(64), 'X-Dev-Paid': '1',
  }});
  expect(response.status).toBe(200);
  const result = await response.json() as any;
  expect(result.owner).toBe(stub.id.toString()); expect(result.paid).toBe('0'); expect(result.auth).toBe(null);
  expect(result.path).toBe('/v1/realtime'); expect(result.slot).toMatch(/^slot-[01]$/);
});
