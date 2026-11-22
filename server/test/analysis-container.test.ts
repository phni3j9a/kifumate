import { expect, it, vi } from 'vitest';
vi.mock("cloudflare:workers", () => ({DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} }}));
import { PreciseJob, RealtimeEngine } from '../src/analysis-container';

it('準備完了後だけ探索を1回転送し、次の局面では同じエンジンを使う', async () => {
  const calls: string[] = [];
  const container = {
    running: false, images: {base: 'image'},
    start: vi.fn(() => { container.running = true; }),
    setInactivityTimeout: vi.fn(),
    getTcpPort: () => ({fetch: async (request: string | Request) => {
      calls.push(typeof request === 'string' ? request : request.url);
      return new Response(null, {status: calls.length === 1 ? 503 : 200});
    }}),
  };
  const worker = new PreciseJob({container} as unknown as DurableObjectState, {});
  for (let i = 0; i < 2; i++) expect((await worker.fetch(new Request('http://container/analyze'))).ok).toBe(true);
  expect(calls).toEqual(['http://container/health', 'http://container/health', 'http://container/analyze', 'http://container/analyze']);
  expect(container.start).toHaveBeenCalledExactlyOnceWith({image: 'image', enableInternet: false, instance: {vcpu: 2, memoryMib: 1536, diskMb: 2000}});
  expect(container.setInactivityTimeout).toHaveBeenCalledWith(10_000);
});

it('停止RPCが先着しても遅着した探索は再生成後も起動しない。再開世代の終了だけを台帳へ通知する', async () => {
  const data = new Map(), kv = {get: (k: string) => data.get(k), put: (k: string, v: unknown) => data.set(k, v)};
  let exit!: () => void;
  const tasks: Promise<unknown>[] = [], setAlarm = vi.fn(), engineExited = vi.fn();
  const container = {running: false, images: {base: 'image'}, monitor: () => new Promise<void>(r => { exit = r; }),
    destroy: vi.fn(), setInactivityTimeout: vi.fn(), start: vi.fn(() => {container.running = true;}),
    getTcpPort: () => ({fetch: () => Response.json({})})};
  const ctx = {storage: {kv, setAlarm}, container, waitUntil: (work: Promise<unknown>) => tasks.push(work)} as unknown as DurableObjectState;
  const env = {RT_ACCOUNTS: {idFromString: (s: string) => s, get: () => ({engineExited})}} as any;
  await new RealtimeEngine(ctx, env).stop(0);
  const engine = new RealtimeEngine(ctx, env);
  const fetch = (generation: number) => engine.fetch(new Request('http://container/realtime', {headers: {'X-Session': 'session', 'X-Account': 'account', 'X-Generation': String(generation)}}));
  expect((await fetch(0)).status).toBe(409); expect(container.start).not.toHaveBeenCalled();
  expect((await fetch(1)).ok).toBe(true);
  container.running = false; exit(); await Promise.all(tasks);
  expect(setAlarm).toHaveBeenCalledOnce(); await engine.alarm();
  expect(engineExited).toHaveBeenCalledWith('session', 1, expect.any(Number));
  expect((await fetch(1)).status).toBe(409);
  await engine.stop(1); await engine.alarm(); expect(engineExited).toHaveBeenCalledOnce();
});
