import { DurableObject } from 'cloudflare:workers';

/** 同じジョブ／セッションの局面だけが同じエンジンに届く。永続データは持たない。 */
export class StandardJob extends DurableObject<unknown> {
  private ready = false;
  protected vcpu = 1;
  protected get idleMs() { return 10_000; }
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    if (ctx.container?.running) ctx.waitUntil(ctx.container.setInactivityTimeout(this.idleMs));
  }
  async fetch(request: Request) {
    const c = this.ctx.container!;
    if (!c.running) {
      this.ready = false;
      c.start({image: c.images.base, instance: {vcpu: this.vcpu, memoryMib: 1536, diskMb: 2000}, enableInternet: false});
      await c.setInactivityTimeout(this.idleMs);
    }
    const port = c.getTcpPort(8080);
    if (this.ready) return port.fetch(request);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(40_000)]);
    while (!signal.aborted && c.running) {
      try {
        const health = await port.fetch('http://container/health', {signal});
        await health.arrayBuffer();
        if (health.ok) { this.ready = true; return port.fetch(request); }
      } catch { /* 起動直後は接続できない */ }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return new Response(null, {status: 503});
  }
}
export class PreciseJob extends StandardJob { protected vcpu = 2; }
export class RealtimeEngine extends StandardJob {
  // 休止・停止は端末別の台帳が決める。台帳が失われた場合も課金し続けない。
  protected get idleMs() { return 310_000; }
  async stop() { if (this.ctx.container?.running) await this.ctx.container.destroy(); }
}
