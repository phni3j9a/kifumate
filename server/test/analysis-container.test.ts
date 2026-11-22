import { expect, it, vi } from 'vitest';
vi.mock("cloudflare:workers", () => ({DurableObject: class { constructor(protected ctx: unknown) {} }}));
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

it('停止済みセッションを再起動せず停止処理を繰り返せる', async () => {
  const container = {running: false, destroy: vi.fn(() => { container.running = false; })};
  const worker = new RealtimeEngine({container} as unknown as DurableObjectState, {});
  container.running = true;
  await worker.stop(); await worker.stop();
  expect(container.destroy).toHaveBeenCalledOnce();
});
