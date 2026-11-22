import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { Device, RealtimeAccount } from '../src/index';
import { monthStart, nextMonth, sha256 } from '../src/model';
import { fetchRealtimeAnalysis, MONTHLY_MS, RealtimeSessions, type RealtimeBackend } from '../src/realtime';

const devices = (env as unknown as {DEVICES: DurableObjectNamespace<Device>}).DEVICES;
const position = {initial: 'startpos', moves: []};
const origin = Date.parse('2026-11-17T00:00:00Z');
async function fixture(check: (f: any) => Promise<void>, idleMs = 30_000, holdIdleMs = 300_000) {
  const stub = devices.getByName(await sha256(crypto.randomUUID()));
  await runInDurableObject(stub, async (_instance, state) => {
    let now = origin, stops = 0, due = 0;
    const tasks: Promise<void>[] = [], calls: any[] = [];
    const backend: RealtimeBackend = {
      analyze: async (input, session, sequence, round, movetimeMs, signal) => {
        calls.push({input, session, sequence, round, movetimeMs, signal});
        return Response.json({ply: input.moves.length, score: {kind: 'cp', value: sequence}, candidates: [], mate: null, terminal: true});
      },
      stop: async () => { stops++; now += 5; },
      schedule: async when => { due = when; },
    };
    let rt = new RealtimeSessions(state.storage, backend, idleMs, holdIdleMs, () => now);
    const send = async (request: Request, owner = 'a', paid = true, checkPaid?: () => Promise<boolean>) => {
      const response = await rt.fetch(request, owner, paid, work => tasks.push(work), checkPaid);
      return {httpStatus: response.status, ...await response.json() as any};
    };
    const request = (method = 'GET', data?: unknown, owner = 'a', paid = true, id?: string) => send(
      new Request('https://device/v1/realtime' + (id ? '/' + id : ''), {
        method, headers: {'content-type': 'application/json'}, ...(data === undefined ? {} : {body: JSON.stringify(data)}),
      }), owner, paid);
    await check({request, send, backend, calls, sql: state.storage.sql,
      advance: (ms: number) => { now += ms; }, time: (value: number) => { now = value; },
      drain: async () => { await Promise.all(tasks.splice(0)); }, expire: () => rt.expire(),
      stops: () => stops, due: () => due, disconnected: (id?: string, gen?: number, ended?: number) => rt.disconnected(id, gen, ended),
      restart: () => { rt = new RealtimeSessions(state.storage, backend, idleMs, holdIdleMs, () => now); },
    });
  });
}

it('コールド起動時のAccount→Engineは初回・旧bridgeへのフォールバック双方へ内部世代を渡す', async () => {
  await runInDurableObject(devices.getByName(crypto.randomUUID()), async (_instance, state) => {
    const seen: Request[] = [];
    let done!: () => void;
    const finished = new Promise<void>(resolve => { done = resolve; });
    const account = new RealtimeAccount(state, {ENVIRONMENT: 'staging', ALLOW_DEV_PAID: 'true', RT_ENGINE: {getByName: () => ({
      fetch: async (url: string, init: RequestInit) => {
        seen.push(new Request(url, init));
        if (url.endsWith('/deepen')) return new Response(null, {status: 404});
        done(); return Response.json({ply: 0, score: null});
      },
    })}} as any);
    const accepted = await account.fetch(new Request('https://device/v1/realtime', {method: 'POST',
      headers: {'content-type':'application/json', 'X-Dev-Paid':'1', 'X-Dev-Entitlement':'1', 'X-Realtime-Owner':'a'.repeat(64)}, body: JSON.stringify(position)}));
    const {sessionId} = await accepted.json() as any;
    expect(accepted.status).toBe(202); await finished;
    expect(seen.map(r => [new URL(r.url).pathname, r.headers.get('X-Account'), r.headers.get('X-Session'), r.headers.get('X-Generation')])).toEqual([
      ['/realtime/deepen', state.id.toString(), sessionId, '0'], ['/realtime', state.id.toString(), sessionId, '0'],
    ]);
  });
});

describe('リアルタイム解析', () => {
  it('新DOは旧bridgeの404で旧形式に戻し、局面ごとに単発の結果を返す', async () => fixture(async f => {
    const paths: string[] = [];
    f.backend.analyze = (...args: Parameters<RealtimeBackend['analyze']>) => fetchRealtimeAnalysis(async (url, init) => {
      const path = new URL(url).pathname;
      paths.push(path);
      const body = JSON.parse(init.body as string);
      if (path !== '/realtime') {
        expect(body).toMatchObject({round: 0, movetimeMs: 250});
        return new Response(null, {status: 404});
      }
      const [input, sessionId, sequence] = args;
      if (Object.keys(body).sort().join(',') !== 'initial,mode,moves,ply,sequence,sessionId') return new Response(null, {status: 422});
      expect(body).toEqual({...input, ply: input.moves.length, sessionId, sequence});
      return Response.json({ply: body.ply, score: {kind: 'cp', value: 30}, candidates: [{rank: 1, depth: 8}], mate: null});
    }, ...args);
    const first = await f.request('POST', position); await f.drain();
    expect(await f.request()).toMatchObject({status: 'ready', searching: false, error: null, result: {ply: 0, depth: 8}});
    expect((await f.request('PUT', {...position, moves: ['7g7f'], sequence: 1}, 'a', true, first.sessionId)).httpStatus).toBe(202);
    await f.drain();
    const latest = await f.request();
    expect(latest).toMatchObject({status: 'ready', searching: false, error: null, result: {ply: 1, depth: 8}});
    expect(latest.result).not.toHaveProperty('terminal');
    expect(paths).toEqual(['/realtime/deepen', '/realtime', '/realtime/deepen', '/realtime']);
    expect(f.stops()).toBe(0);
  }));
  it.each(['例外', '503', '連続503'])('休止後の初回転送失敗（%s）は別roundで一度だけ再試行する', async failure => fixture(async f => {
    const first = await f.request('POST', position); await f.drain();
    f.advance(30_001); await f.expire();
    const rounds: number[] = [];
    f.backend.analyze = async (_: unknown, id: string, sequence: number, round: number) => {
      expect([id, sequence]).toEqual([first.sessionId, 1]); rounds.push(round);
      if (!round && failure === '例外') throw new Error();
      return !round || failure === '連続503' ? new Response(null, {status: 503}) : Response.json({ply: 0, terminal: true});
    };
    await f.request('PUT', {...position, sequence: 1, hold: true}, 'a', true, first.sessionId); await f.drain();
    expect(rounds).toEqual([0, 1]); expect((await f.request()).status).toBe(failure === '連続503' ? 'failed' : 'ready');
  }));
  it('詰み評価を保存して即座に深読みを終える', async () => fixture(async f => {
    const score = {kind: 'mate', value: 3, winner: 'sente'};
    f.backend.analyze = async (_input: unknown, _id: string, _seq: number, round: number) => {
      f.calls.push(round);
      return Response.json({ply: 0, score, candidates: [{rank: 1, depth: 7}], terminal: round > 0});
    };
    await f.request('POST', position); await f.drain();
    expect(await f.request()).toMatchObject({status: 'ready', searching: false, result: {depth: 7, score}});
    expect(f.calls).toEqual([0]); expect(f.stops()).toBe(0);
  }));
  it('本文受信後の外部権利再照会で取消を検知し、コンテナを起動しない', async () => {
    await runInDurableObject(devices.getByName(crypto.randomUUID()), async (_, state) => {
      let starts = 0;
      const rt = new RealtimeSessions(state.storage, {
        analyze: async () => { starts++; return Response.json({ply: 0}); },
        stop: async () => {}, schedule: async () => {},
      });
      const response = await rt.fetch(new Request('https://device/v1/realtime', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(position),
      }), 'a', true, () => {}, async () => false);
      expect(response.status).toBe(403); expect(starts).toBe(0);
    });
  });
  it('JST月境界・年越し・うるう年', () => {
    const boundary = Date.parse('2026-11-30T15:00:00Z');
    expect(monthStart(boundary - 1)).toBe(Date.parse('2026-10-31T15:00:00Z'));
    expect(monthStart(boundary)).toBe(boundary);
    expect(nextMonth(Date.parse('2026-12-31T15:00:00Z'))).toBe(Date.parse('2027-01-31T15:00:00Z'));
    expect(nextMonth(Date.parse('2028-02-28T15:00:00Z'))).toBe(Date.parse('2028-02-29T15:00:00Z'));
  });
  it('同じsequenceで結果を更新し、時間を倍増して60秒を繰り返す。終局で探索だけ終了する', async () => fixture(async f => {
    const pending: ((response: Response) => void)[] = [];
    f.backend.analyze = async (_input: unknown, session: string, sequence: number, round: number, ms: number) => {
      f.calls.push({session, sequence, round, ms});
      return new Promise<Response>(resolve => { pending.push(resolve); });
    };
    const first = await f.request('POST', position);
    expect(first.searching).toBe(true);
    expect(first.result).toBeNull();
    const times = [250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];
    for (const [round, ms] of times.entries()) {
      await expect.poll(() => pending.length).toBe(round + 1);
      expect(f.calls[round]).toEqual({session: first.sessionId, sequence: 0, round, ms});
      f.advance(250);
      const terminal = round === times.length - 1;
      pending[round](Response.json({ply: 0, candidates: [{rank: 1, depth: round + 5}], terminal}));
      await expect.poll(async () => (await f.request()).result?.depth).toBe(round + 5);
      const latest = await f.request();
      expect(latest.status).toBe('ready'); expect(latest.sequence).toBe(0);
      expect(latest.searching).toBe(!terminal);
      expect(latest.result).not.toHaveProperty('terminal');
      expect(f.due()).toBe(origin + 30_000);
      expect(latest.quota.usedMs).toBe((round + 1) * 250);
    }
    await f.drain();
    expect(f.calls).toHaveLength(times.length);
    expect(f.stops()).toBe(0);
  }));
  it('hold保存後も旧版の列名なしINSERTで更新でき、利用時間を保持する', async () => fixture(async f => {
    const first = await f.request('POST', {...position, hold: true}); await f.drain();
    f.advance(1234);
    // origin/main の INSERT。旧版の局面更新では hold 用テーブルに触れない。
    f.sql.exec(`INSERT INTO rt_sessions VALUES (?,?,?,'preparing',NULL,NULL,?,?)
      ON CONFLICT(owner) DO UPDATE SET id=excluded.id,sequence=excluded.sequence,status=CASE WHEN rt_sessions.charged IS NULL THEN 'preparing' ELSE 'analyzing' END,
      result=NULL,error=NULL,charged=COALESCE(rt_sessions.charged,excluded.charged),activity=excluded.activity`,
      'a', first.sessionId, 1, origin + 1234, origin + 1234);
    f.restart();
    const existing = await f.request();
    expect(existing.sessionId).toBe(first.sessionId); expect(existing.sequence).toBe(1); expect(existing.idleMs).toBe(30_000);
    expect(existing.quota.usedMs).toBe(1234);
    await f.request('DELETE', undefined, 'a', true, first.sessionId);
  }));
  it('holdは5分。PUTごとに数え直し、省略・falseは通常の期限に戻す', async () => fixture(async f => {
    const update = (sequence: number, extra = {}) => f.request('PUT', {...position, sequence, ...extra}, 'a', true, first.sessionId);
    const first = await f.request('POST', {...position, hold: true});
    await f.drain();
    expect(first.idleMs).toBe(300_000); expect(f.due()).toBe(origin + 300_000);
    f.advance(30_000);
    f.restart();
    const kept = await f.request();
    expect(kept.status).toBe('ready'); expect(kept.idleMs).toBe(300_000);
    expect((await update(1, {hold: true})).idleMs).toBe(300_000);
    await f.drain();
    expect(f.due()).toBe(origin + 330_000);
    f.advance(270_000); await f.expire();
    expect(f.stops()).toBe(0);
    f.advance(30_000); await f.expire();
    const paused = await f.request();
    expect(paused.status).toBe('paused'); expect(paused.searching).toBe(false);
    expect(paused.quota.usedMs).toBe(330_005);
    expect((await update(2)).idleMs).toBe(30_000);
    expect((await update(3, {hold: true})).idleMs).toBe(300_000);
    expect((await update(4, {hold: false})).idleMs).toBe(30_000);
    await f.drain();
    expect(f.due()).toBe(origin + 360_005);
  }));
  it.each([false, true])('探索中の休止・月上限では古い結果を保存しない（上限=%s）', async limited => fixture(async f => {
    if (limited) f.sql.exec('INSERT INTO rt_usage VALUES (?,?,?)', 'a', monthStart(origin), MONTHLY_MS - 1000);
    let signal!: AbortSignal, release!: (response: Response) => void;
    f.backend.analyze = async (_input: unknown, _id: string, _sequence: number, round: number, _ms: number, abort: AbortSignal) => {
      if (round === 0) return Response.json({ply: 0, candidates: [{rank: 1, depth: 5}], terminal: false});
      signal = abort;
      return new Promise<Response>(resolve => { release = resolve; });
    };
    await f.request('POST', position);
    await expect.poll(() => !!release).toBe(true);
    f.advance(1000); await f.expire();
    expect(signal.aborted).toBe(true);
    release(Response.json({ply: 0, candidates: [{rank: 1, depth: 9}], terminal: false}));
    await f.drain();
    const end = await f.request();
    expect(end.status).toBe(limited ? 'limit' : 'paused');
    expect(end.searching).toBe(false); expect(end.result.depth).toBe(5);
    expect(end.quota.usedMs).toBe(limited ? MONTHLY_MS : 1005);
  }, 1000));
  it('探索済みの待機時間も数え、GETでは休止期限を延長しない。休止・再開・明示停止', async () => fixture(async f => {
    const first = await f.request('POST', position);
    expect(first.httpStatus).toBe(202); expect(first.sequence).toBe(0);
    await f.drain();
    expect((await f.request()).status).toBe('ready');
    f.advance(20_000);
    expect((await f.request()).quota.usedMs).toBe(20_000);
    expect(f.due()).toBe(origin + 30_000);
    f.advance(10_000); await f.expire();
    const paused = await f.request();
    expect(paused.status).toBe('paused'); expect(paused.quota.usedMs).toBe(30_005); expect(f.stops()).toBe(1);
    f.advance(50_000);
    expect((await f.request()).quota.usedMs).toBe(30_005);
    const resumed = await f.request('PUT', {...position, sequence: 1}, 'a', true, first.sessionId);
    expect(resumed.httpStatus).toBe(202); await f.drain();
    f.advance(1000);
    const stopped = await f.request('DELETE', undefined, 'a', true, first.sessionId);
    expect(stopped.status).toBe('off'); expect(stopped.quota.usedMs).toBe(31_010);
    expect((await f.request('PUT', {...position, sequence: 2}, 'a', true, first.sessionId)).error).toBe('stale_session');
    expect((await f.request('POST', position)).httpStatus).toBe(202); await f.drain();
  }));
  it('準備中も数え、旧局面をAbortし、逆順・重複の局面と遅延結果を捨てる', async () => fixture(async f => {
    let release!: (response: Response) => void;
    f.backend.analyze = async (...args: any[]) => {
      f.calls.push(args);
      return new Promise<Response>(resolve => { release = resolve; });
    };
    const first = await f.request('POST', position);
    f.advance(2000); expect((await f.request()).quota.usedMs).toBe(2000);
    f.backend.analyze = async () => Response.json({ply: 1, score: {kind: 'cp', value: 99}, terminal: true});
    const latest = await f.request('PUT', {...position, moves: ['7g7f'], sequence: 2}, 'a', true, first.sessionId);
    expect(latest.httpStatus).toBe(202); expect(f.calls[0][5].aborted).toBe(true);
    expect((await f.request('PUT', {...position, sequence: 1}, 'a', true, first.sessionId)).error).toBe('stale_sequence');
    expect((await f.request('PUT', {...position, sequence: 2}, 'a', true, first.sessionId)).error).toBe('stale_sequence');
    release(Response.json({ply: 0, score: {kind: 'cp', value: -999}})); await f.drain();
    expect((await f.request()).result.score.value).toBe(99);
  }));
  it('有料権利・混雑・別端末の結果隔離・全局の利用回数からの独立', async () => fixture(async f => {
    expect((await f.request('POST', position, 'a', false)).httpStatus).toBe(403);
    expect(f.calls).toEqual([]);
    const first = await f.request('POST', position); await f.drain();
    expect((await f.request('POST', position, 'b')).error).toBe('realtime_busy');
    const other = await f.request('GET', undefined, 'b');
    expect(other.sessionId).toBe(null); expect(other.result).toBe(null); expect(other.quota.usedMs).toBe(0);
    expect((await f.request('DELETE', undefined, 'b', true, first.sessionId)).error).toBe('stale_session');
    f.advance(1000);
    expect((await f.request('GET', undefined, 'a', false)).status).toBe('off');
    expect(f.stops()).toBe(1);
    expect(f.sql.exec('SELECT * FROM usage').toArray()).toEqual([]);
  }));
  it.each(['POST', 'PUT'])('%sの本文待機中に有料権利が失効したら解析を開始しない', async method => fixture(async f => {
    let id: string | undefined;
    if (method === 'PUT') {
      id = (await f.request('POST', position)).sessionId;
      await f.drain(); f.advance(1000);
    }
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let reading!: () => void;
    const bodyRead = new Promise<void>(resolve => { reading = resolve; });
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      pull() { reading(); },
    }, {highWaterMark: 0});
    const pending = f.send(new Request('https://device/v1/realtime' + (id ? '/' + id : ''), {
      method, headers: {'content-type': 'application/json'}, body,
    }));
    await bodyRead;
    const revoked = await f.request('GET', undefined, 'a', false);
    expect(revoked.paid).toBe(false); expect(revoked.status).toBe('off');
    expect((await f.request('GET', undefined, 'b', true)).paid).toBe(true);
    const calls = f.calls.length;
    controller.enqueue(new TextEncoder().encode(JSON.stringify({...position, ...(id ? {sequence: 1} : {})})));
    controller.close();
    const denied = await pending; await f.drain();
    expect(denied.httpStatus).toBe(403); expect(denied.error).toBe('paid_required');
    expect(f.calls.length).toBe(calls);
    expect(f.sql.exec('SELECT owner FROM rt_sessions WHERE charged IS NOT NULL').toArray()).toEqual([]);
    f.advance(1000);
    expect((await f.request('GET', undefined, 'a', false)).quota.usedMs).toBe(revoked.quota.usedMs);
  }));
  it.each(['POST', 'PUT'])('%sの本文待機中の外部権利失効で所有セッションを停止してから拒否する', async method => fixture(async f => {
    const first = await f.request('POST', position); await f.drain();
    let paid = true, controller!: ReadableStreamDefaultController<Uint8Array>, reading!: () => void;
    const bodyRead = new Promise<void>(resolve => {reading = resolve;});
    const body = new ReadableStream<Uint8Array>({
      start(value) {controller = value;}, pull() {reading();},
    }, {highWaterMark: 0});
    const pending = f.send(new Request('https://device/v1/realtime' + (method === 'PUT' ? '/' + first.sessionId : ''), {
      method, headers: {'Content-Type': 'application/json'}, body,
    }), 'a', true, async () => paid);
    await bodyRead;
    // 入口のGETで停止させず、本文受信後の外部再照会だけで失効を検知する。
    f.advance(1000); paid = false;
    controller.enqueue(new TextEncoder().encode(JSON.stringify({...position, ...(method === 'PUT' ? {sequence: 1} : {})})));
    controller.close();
    const denied = await pending;
    expect(denied.httpStatus).toBe(403); expect(denied.error).toBe('paid_required');
    expect(denied.status).toBe('off'); expect(f.stops()).toBe(1); expect(f.calls.length).toBe(1);
    expect(f.sql.exec('SELECT charged FROM rt_sessions WHERE owner=?', 'a').one().charged).toBeNull();
    expect(denied.quota.usedMs).toBe(1005);
    f.advance(1000);
    expect((await f.request()).quota.usedMs).toBe(denied.quota.usedMs);
  }));
  it.each([false, true])('PUTで休止完了を待ったら権利を再確認する（待機後の権利=%s）', async paidAfterStop => fixture(async f => {
    const first = await f.request('POST', position); await f.drain();
    let paid = true, checks = 0, entered!: () => void, finish!: () => void;
    const beganStopping = new Promise<void>(resolve => { entered = resolve; });
    const stop = f.backend.stop;
    f.backend.stop = async () => {
      await new Promise<void>(resolve => { finish = resolve; entered(); });
      await stop();
    };
    f.advance(29_999);
    const pending = f.send(new Request(`https://device/v1/realtime/${first.sessionId}`, {
      method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({...position, sequence: 1}),
    }), 'a', true, async () => {
      if (++checks === 1) f.advance(1);
      return paid;
    });
    await beganStopping;
    expect(checks).toBe(1); expect(f.calls).toHaveLength(1);
    paid = paidAfterStop;
    finish();
    const updated = await pending; await f.drain();
    expect(checks).toBe(2); expect(f.stops()).toBe(1);
    expect(updated).toMatchObject(paidAfterStop ? {httpStatus: 202, sequence: 1, error: null}
      : {httpStatus: 403, sequence: 0, status: 'paused', error: 'paid_required'});
    expect(f.calls).toHaveLength(paidAfterStop ? 2 : 1);
    expect(updated.quota.usedMs).toBe(30_005);
  }));
  it('本文受信後の再照会失効で別端末の稼働を停止しない', async () => fixture(async f => {
    await f.request('POST', position); await f.drain();
    const denied = await f.send(new Request('https://device/v1/realtime', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(position),
    }), 'b', true, async () => false);
    expect(denied.httpStatus).toBe(403); expect(f.stops()).toBe(0);
    expect((await f.request()).status).toBe('ready');
  }));
  it('月300分で自動停止して戻る日時を返し、翌月の局面更新で再開する', async () => fixture(async f => {
    f.sql.exec('INSERT INTO rt_usage VALUES (?,?,?)', 'a', monthStart(origin), MONTHLY_MS - 500);
    const first = await f.request('POST', position); await f.drain();
    expect(f.due()).toBe(origin + 500);
    f.advance(500); await f.expire();
    const limited = await f.request();
    expect(limited.status).toBe('limit'); expect(limited.quota.remainingMs).toBe(0);
    expect(limited.quota.low).toBe(true); expect(limited.quota.resetsAt).toBe(nextMonth(origin));
    expect((await f.request('PUT', {...position, sequence: 1}, 'a', true, first.sessionId)).httpStatus).toBe(429);
    f.time(nextMonth(origin));
    expect((await f.request()).quota.usedMs).toBe(0);
    expect((await f.request('PUT', {...position, sequence: 2}, 'a', true, first.sessionId)).httpStatus).toBe(202); await f.drain();
  }));
  it('月をまたぐ稼働を両月に分け、DO再生成でも集計を重複しない', async () => fixture(async f => {
    const boundary = nextMonth(origin); f.time(boundary - 1000);
    const first = await f.request('POST', position); await f.drain();
    f.time(boundary + 1000); f.restart();
    expect((await f.request()).quota.usedMs).toBe(1000);
    expect((await f.request()).quota.usedMs).toBe(1000);
    await f.request('DELETE', undefined, 'a', true, first.sessionId);
    expect(f.sql.exec('SELECT ms FROM rt_usage WHERE month=?', monthStart(origin)).toArray()[0].ms).toBe(1000);
  }));
  it('停止後の遅延結果を破棄し、失敗でも稼働済み時間は返却しない', async () => fixture(async f => {
    let release!: (response: Response) => void;
    f.backend.analyze = async () => new Promise<Response>(resolve => { release = resolve; });
    const first = await f.request('POST', position);
    f.advance(1000); await f.request('DELETE', undefined, 'a', true, first.sessionId);
    release(Response.json({ply: 0})); await f.drain();
    expect((await f.request()).result).toBe(null);
    f.backend.analyze = async () => { f.advance(2000); return new Response('', {status: 422}); };
    await f.request('POST', position); await f.drain();
    const failed = await f.request();
    expect(failed.status).toBe('failed'); expect(failed.error).toBe('invalid_position_or_move');
    expect(failed.quota.usedMs).toBe(3010); expect(f.stops()).toBe(2);
  }));
  it('停止失敗では枠と集計を保持し、再試行で停止する', async () => fixture(async f => {
    const first = await f.request('POST', position); await f.drain();
    const stop = f.backend.stop;
    f.backend.stop = async () => { throw new Error('temporary'); };
    expect((await f.request('DELETE', undefined, 'a', true, first.sessionId)).httpStatus).toBe(503);
    f.advance(1000); expect((await f.request()).httpStatus).toBe(503);
    expect(f.sql.exec('SELECT charged FROM rt_sessions').toArray()[0].charged).not.toBe(null);
    f.backend.stop = stop;
    await f.request('DELETE', undefined, 'a', true, first.sessionId);
    expect(f.stops()).toBe(1);
  }));
  it('追加フィールド・不正なsequenceを拒否する', async () => fixture(async f => {
    expect((await f.request('POST', {...position, mode: 'precise'})).httpStatus).toBe(400);
    expect((await f.request('POST', {...position, name: '名前'})).httpStatus).toBe(400);
    expect((await f.request('POST', {...position, hold: 'true'})).httpStatus).toBe(400);
    const first = await f.request('POST', position); await f.drain();
    for (const extra of [{round: 1}, {mode: 'std'}, {hold: null}, {hold: 1}]) {
      expect((await f.request('PUT', {...position, sequence: 1, ...extra}, 'a', true, first.sessionId)).httpStatus).toBe(400);
    }
    for (const sequence of [-1, 0, 1.5, '1']) {
      expect((await f.request('PUT', {...position, sequence}, 'a', true, first.sessionId)).httpStatus).toBe(400);
    }
    const old = first.sessionId;
    await f.request('DELETE', undefined, 'a', true, old);
    await f.request('POST', position); await f.drain();
    expect((await f.request('DELETE', undefined, 'a', true, old)).error).toBe('stale_session');
  }));
  it('alarmが月境界をまたいで遅延しても旧月の上限で停止し、自動再開しない', async () => fixture(async f => {
    const boundary = nextMonth(origin);
    f.sql.exec('INSERT INTO rt_usage VALUES (?,?,?)', 'a', monthStart(origin), MONTHLY_MS - 500);
    f.time(boundary - 1000);
    const first = await f.request('POST', position); await f.drain();
    f.time(boundary + 100); await f.expire();
    const limited = await f.request();
    expect(limited.status).toBe('limit'); expect(limited.quota.usedMs).toBe(105);
    expect(f.stops()).toBe(1); expect(f.calls.length).toBe(1);
    expect((await f.request('PUT', {...position, sequence: 1}, 'a', true, first.sessionId)).httpStatus).toBe(202);
    await f.drain();
  }));
  it('終局後にエンジンが落ちても通知時刻ではなく終了時刻で確定し、古い世代の通知を無視する', async () => fixture(async f => {
    const first = await f.request('POST', {...position, hold: true}); await f.drain();
    f.advance(5000); expect((await f.request()).quota.usedMs).toBe(5000);
    f.disconnected(first.sessionId, 0, origin + 500);
    expect(await f.request()).toMatchObject({status: 'paused', quota: {usedMs: 500}});
    await f.request('PUT', {...position, sequence: 1}, 'a', true, first.sessionId); await f.drain();
    f.disconnected(first.sessionId, 0, origin + 500); f.advance(1000);
    await f.request('DELETE', undefined, 'a', true, first.sessionId);
    f.disconnected(first.sessionId, 1, origin + 6000); f.advance(2000);
    expect(await f.request()).toMatchObject({status: 'off', quota: {usedMs: 1505}});
  }));
  it('休止時間を設定でき、予期せぬ停止でも時間を確定する', async () => fixture(async f => {
    const first = await f.request('POST', position); await f.drain();
    expect(f.due()).toBe(origin + 1000);
    f.advance(500); f.disconnected();
    expect((await f.request()).quota.usedMs).toBe(500);
    f.advance(5000); expect((await f.request()).quota.usedMs).toBe(500);
    await f.request('PUT', {...position, sequence: 1}, 'a', true, first.sessionId); await f.drain();
    f.advance(1000); await f.expire(); expect(f.stops()).toBe(1);
    expect((await f.request()).quota.usedMs).toBe(1505);
  }, 1000));

});
