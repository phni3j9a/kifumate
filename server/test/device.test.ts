import { env } from 'cloudflare:workers';
import { SELF, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { parseInput, sha256, weekStart, RETENTION_MS } from '../src/model';
import { Device } from '../src/index';
import { deepPositions } from '../src/deep';
import { verifyAnalysis } from '../src/coach';

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
    instance.env.PAUSE_FREE_ANALYSIS = 'false';
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

it('全局の新bindingは端末IDでなく受理したジョブIDを選ぶ', async () => {
  const stub = await setup();
  const {data: job} = await request(stub, '/v1/jobs', 'POST', base);
  await runInDurableObject(stub, async (instance: any) => {
    const names: string[] = [];
    instance.env.STD_JOB = {getByName: (name: string) => {
      names.push(name); return instance.env.STD.getByName(name);
    }};
    try {
      await instance.alarm();
      instance.env.USE_LEGACY_ANALYSIS = 'true';
      await instance.alarm();
      expect(names).toEqual([job.id]);
    } finally { delete instance.env.STD_JOB; delete instance.env.USE_LEGACY_ANALYSIS; }
  });
});

it('停止中は無料の新規局だけを拒み、重複・有料は維持する', async () => {
  for (const paid of [false, true]) {
    const stub = await setup(paid);
    expect((await request(stub, '/v1/jobs', 'POST', base)).status).toBe(202);
    await runInDurableObject(stub, (instance: any) => { instance.env.PAUSE_FREE_ANALYSIS = 'true'; });
    expect((await request(stub, '/v1/jobs', 'POST', base)).status).toBe(200);
    expect((await request(stub, '/v1/jobs', 'POST', {...base, moves: []})).status).toBe(paid ? 202 : 503);
  }
});

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
  const secrets = {COACH_API_KEY: 'realtime-provider-secret', COACH_SIGNING_KEY: 'realtime-signing-secret',
    INVITE_ADMIN_KEY: 'realtime-admin-secret', DEV_PAID_HASHES: 'realtime-development-secret'};
  await runInDurableObject(stub, (instance: any) => {
    Object.assign(instance.env, secrets);
    instance.env.RT_ACCOUNTS = {getByName: (slot: string) => ({fetch: async (request: Request) => Response.json({
      slot, owner: request.headers.get('X-Realtime-Owner'), paid: request.headers.get('X-Dev-Paid'),
      auth: request.headers.get('Authorization'), path: new URL(request.url).pathname,
      hash: request.headers.get('X-Device-Hash'), devEntitlement: request.headers.get('X-Dev-Entitlement'),
      config: request.headers.get('X-Coach-Config'), headers: Object.fromEntries(request.headers), body: await request.text(),
    })})};
  });
  const body = JSON.stringify({initial: 'startpos', moves: []});
  const response = await SELF.fetch('https://api/v1/realtime', {method: 'POST', body, headers: {
    'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-Realtime-Owner': 'f'.repeat(64), 'X-Dev-Paid': '1',
    'X-Dev-Entitlement': '1', 'X-Device-Hash': 'forged', 'X-Coach-Config': 'forged',
  }});
  expect(response.status).toBe(200);
  const result = await response.json() as any;
  expect(result.owner).toBe(stub.id.toString()); expect(result.paid).toBe('0'); expect(result.auth).toBe(null);
  expect(result.path).toBe('/v1/realtime'); expect(result.slot).toBe(result.owner);
  expect(result.hash).toBe(hash); expect(result.devEntitlement).toBe('0'); expect(result.config).toBe(null);
  expect(result.body).toBe(body);
  for (const value of [...Object.values(secrets), token]) expect(JSON.stringify([result.headers, result.body])).not.toContain(value);
});

describe('精密の2段目', () => {
  const input = {...base, moves: Array(39).fill('7g7f'), mode: 'precise' as const};
  const score = (value: number) => ({kind: 'cp' as const, value});
  const result = (ply: number, deep = false) => ({ply, score: score(deep ? 100 : ply % 2 ? -900 : 0), candidates: [], mate: null});
  async function engine(stub: any, deep: (ply: number) => Response | Promise<Response>) {
    return runInDurableObject(stub, (instance: any) => {
      instance.env.COACH_SIGNING_KEY = 'deep-device-test-key';
      instance.env.PRECISE = {getByName: () => ({fetch: async (url: string, init: RequestInit) => {
        const payload = JSON.parse(init.body as string);
        expect(payload).toEqual({...input, ply: payload.ply});
        if (url.endsWith('/analyze/deep')) return deep(payload.ply);
        expect(url).toBe('http://container/analyze');
        return Response.json(result(payload.ply));
      }})};
    });
  }
  async function start(deep: (ply: number) => Response | Promise<Response>) {
    const stub = await setup(true);
    await engine(stub, deep);
    const {data} = await request(stub, '/v1/jobs', 'POST', input);
    // 先頭38局面を保存済みにして、1段目の最後の2局面から再開する。
    await runInDurableObject(stub, (instance: any, state) => {
      state.storage.sql.exec("UPDATE jobs SET status='running',cursor=38 WHERE id=?", data.id);
      for (let i = 0; i < 38; i++) state.storage.sql.exec('INSERT INTO results VALUES (?,?,?)', data.id, i, JSON.stringify(result(i)));
      return (async () => { await instance.alarm(); await instance.alarm(); })();
    });
    const path = `/v1/jobs/${data.id}`;
    const stage = (await request(stub, path + '?from=39')).data;
    expect(stage).toMatchObject({status: 'running', next: 40, deep: {total: 4, done: 0}, coachProof: null,
      results: [result(39)], quota: {reserved: {total: 1, precise: 1}, completed: {total: 0, precise: 0}}});
    return {stub, path};
  }
  it('対象の前後を組で選ぶ。序盤・同点・重複・欠損・詰み確定・後手始まりを処理する', () => {
    const rows = Array.from({length: 40}, (_, i) => result(i));
    expect(deepPositions('startpos', rows)).toEqual([30, 31, 32, 33]);
    rows[30].score.value = 9000; // 大差でのcp低下そのものではなく勝率の低下順。
    rows[31].score.value = 8000;
    expect(deepPositions('startpos', rows)).toEqual([32, 33, 34, 35]);
    const mate = {kind: 'mate' as const, winner: 'gote' as const};
    const exceptional = Array.from({length: 86}, (_, ply) => ({ply, score: null, mate: null})) as Parameters<typeof deepPositions>[1];
    const set = (i: number, s: Parameters<typeof deepPositions>[1][number]['score'], m: unknown = null) => { exceptional[i] = {ply: i, score: s, mate: m}; };
    set(29, score(-1000)); set(30, mate, {}); set(31, score(-2000), {}); // 線の両端が詰み確定、除外
    set(32, score(-1000)); set(33, score(0)); set(34, score(-1000)); // 33/34は重複
    set(40, score(-1000)); set(41, score(0)); set(42, score(-1000)); // 同点は先の手から
    set(50, score(-2000)); set(51, score(0)); // 最大の低下
    set(60, score(-1000)); set(61, score(0)); // 9局面になるため入らない
    expect(deepPositions('4k4/9/9/9/9/9/9/9/4K4 w - 1', exceptional)).toEqual([32, 33, 34, 40, 41, 42, 50, 51]);
  });
  it('着手側の+600→0と0→−600は同じ低下として早い手を選ぶ', () => {
    const scores = new Map([[30, 600], [31, 0], [32, 0], [33, -600]]);
    const rows = Array.from({length: 37}, (_, ply) => ({ply, score: scores.has(ply) ? score(scores.get(ply)!) : null, mate: null}));
    expect(deepPositions('startpos', rows)).toEqual([30, 31]);
    const mirrored = new Map([[30, -62], [31, -93], [34, 93], [35, 62]]);
    const rows2 = Array.from({length: 37}, (_, ply) => ({ply, score: mirrored.has(ply) ? score(mirrored.get(ply)!) : null, mate: null}));
    expect(deepPositions('startpos', rows2)).toEqual([30, 31]);
  });
  it('再起動して続きから探索し、完了時は全件を返して深読みを含む署名と1局を確定する', async () => {
    const called: number[] = [];
    const {stub, path} = await start(ply => { called.push(ply); return Response.json(result(ply, true)); });
    await tick(stub);
    const progress = (await request(stub, path + '?from=40')).data;
    expect(progress).toMatchObject({status: 'running', next: 40, deep: {total: 4, done: 1}, results: [], coachProof: null});
    await runInDurableObject(stub, (instance: any, state) => new Device(state, instance.env).alarm());
    for (let i = 0; i < 5; i++) await tick(stub);
    expect(called).toEqual([30, 31, 32, 33]);
    const done = (await request(stub, path + '?from=40')).data;
    expect(done).toMatchObject({status: 'completed', deep: {total: 4, done: 4}, next: 40,
      quota: {reserved: {total: 0, precise: 0}, completed: {total: 1, precise: 1}}});
    expect(done.results).toEqual(Array.from({length: 40}, (_, i) => ({...result(i), ...(called.includes(i) ? {deep: result(i, true)} : {})})));
    await expect(verifyAnalysis('deep-device-test-key', stub.id.toString(), input, done.results, done.coachProof)).resolves.toBeUndefined();
    await expect(verifyAnalysis('deep-device-test-key', stub.id.toString(), input, done.results.map(({deep: _, ...r}: any) => r), done.coachProof)).rejects.toThrow('invalid_proof');
    await sql(stub, 'UPDATE jobs SET terminal=?', Date.now() - RETENTION_MS);
    await tick(stub);
    for (const table of ['jobs', 'results', 'coach_proofs']) expect(await sql(stub, `SELECT * FROM ${table}`)).toEqual([]);
  });
  it.each([404, 503])('HTTP %i では深読みを公開せず精密1局で完了する', async (status) => {
    const called: number[] = [];
    const {stub, path} = await start(ply => {
      called.push(ply);
      return status === 503 && ply === 30 ? Response.json(result(ply, true)) : new Response(null, {status});
    });
    for (let i = 0; i < 8; i++) await tick(stub);
    expect(called).toEqual(status === 404 ? [30] : [30, ...Array(5).fill(31)]);
    const done = (await request(stub, path + '?from=40')).data;
    expect(done).toMatchObject({status: 'completed', next: 40, error: null, deep: {total: 4, done: 0},
      quota: {reserved: {total: 0, precise: 0}, completed: {total: 1, precise: 1}}});
    expect(done.results).toEqual(Array.from({length: 40}, (_, i) => result(i)));
    await expect(verifyAnalysis('deep-device-test-key', stub.id.toString(), input, done.results, done.coachProof)).resolves.toBeUndefined();
  });
  it('512手・長い候補・詰み応手を含む全件を返し、コーチの1 MiB上限は維持する', async () => {
    const stub = await setup(true);
    const long = {...input, moves: Array(512).fill('7g7f')};
    const created = (await request(stub, '/v1/jobs', 'POST', long)).data;
    const target = Array.from({length: 51}, (_, i) => i + 30);
    const positions = Array.from({length: 513}, (_, ply) => {
      const r = {ply, score: {kind: 'cp', value: 100, bound: 'lowerbound'},
        candidates: [1, 2, 3].map(rank => ({rank, score: {kind: 'cp', value: 100}, move: '7g7f+', depth: 20, pv: Array(128).fill('7g7f+')})),
        mate: ply % 20 === 0 ? {plies: 3, pv: ['7g7f', '3c3d', '2g2f'], branches: Array(40).fill({reply: '3c3d', mate: '2g2f'})} : null};
      return target.includes(ply) ? {...r, deep: r} : r;
    });
    // 探索結果のサイズだけを検証する人工データ。棋譜の合法性はbridgeのテストで確認する。
    await runInDurableObject(stub, (instance: any, state) => {
      instance.env.COACH_SIGNING_KEY = 'deep-device-test-key';
      state.storage.transactionSync(() => {
        state.storage.sql.exec("UPDATE jobs SET status='running',cursor=513,deep_targets=?,deep_done=51 WHERE id=?", JSON.stringify(target), created.id);
        for (const r of positions) state.storage.sql.exec('INSERT INTO results VALUES (?,?,?)', created.id, r.ply, JSON.stringify(r));
      });
      return instance.alarm();
    });
    const reply = (await request(stub, `/v1/jobs/${created.id}?from=513`)).data;
    expect(reply).toMatchObject({status: 'completed', next: 513, deep: {total: 51, done: 51}});
    expect(reply.results).toEqual(positions);
    expect(new TextEncoder().encode(JSON.stringify(reply)).length).toBeGreaterThan(1_048_576);
    await expect(verifyAnalysis('deep-device-test-key', stub.id.toString(), long, reply.results, reply.coachProof)).resolves.toBeUndefined();
    const coach = await request(stub, '/v1/coach', 'POST', {analysis: {...long, results: reply.results}, proof: reply.coachProof});
    expect(coach).toMatchObject({status: 413, data: {error: 'input_too_large'}});
  });
  it('深読み中に中止すると遅れて届いた結果を保存せず予約を返す', async () => {
    let started!: () => void;
    let release!: () => void;
    const called = new Promise<void>(resolve => {started = resolve;});
    const gate = new Promise<void>(resolve => {release = resolve;});
    const {stub, path} = await start(async ply => { started(); await gate; return Response.json(result(ply, true)); });
    await runInDurableObject(stub, async (instance: any) => {
      const running = instance.alarm();
      await called;
      const cancelled = await instance.fetch(new Request(`https://device${path}`, {method: 'DELETE', headers: {'X-Dev-Paid': '1'}}));
      expect((await cancelled.json()).status).toBe('cancelled');
      release(); await running;
    });
    const done = (await request(stub, path)).data;
    expect(done).toMatchObject({status: 'cancelled', next: 40, deep: {total: 4, done: 0}, coachProof: null,
      quota: {reserved: {total: 0, precise: 0}, completed: {total: 0, precise: 0}, preciseRemaining: 20}});
    expect(done.results).toEqual(Array.from({length: 40}, (_, i) => result(i)));
  });
});
