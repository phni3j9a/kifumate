import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';

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
interface EngineRun { generation: number; account: string; session: string; lastAlive: number; ended?: number; stopping?: boolean }
export class RealtimeEngine extends StandardJob {
  protected get idleMs() { return 310_000; }
  private watching?: number;
  private get run() { return this.ctx.storage.kv.get<EngineRun>('run'); }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const run = this.run;
    if (run && run.ended === undefined && !run.stopping) {
      if (ctx.container?.running) this.watch(run);
      else ctx.waitUntil(Promise.resolve(this.exited(run, run.lastAlive))); // 再生成中の終了時刻は不明。最後の生存確認までに限る。
    }
  }
  private watch(run: EngineRun) {
    if (this.watching === run.generation) return;
    this.watching = run.generation;
    this.ctx.waitUntil(this.ctx.container!.monitor().then(() => this.exited(run, Date.now()), () => this.exited(run, Date.now())));
  }
  private exited(run: EngineRun, ended: number) {
    const current = this.run;
    if (current?.generation !== run.generation || current.ended !== undefined) return;
    this.ctx.storage.kv.put('run', {...current, ended});
    if (!current.stopping) return this.ctx.storage.setAlarm(Date.now());
  }
  async alarm() {
    const run = this.run;
    if (run?.ended === undefined || run.stopping) return;
    const accounts = (this.env as Env).RT_ACCOUNTS!;
    await accounts.get(accounts.idFromString(run.account)).engineExited(run.session, run.generation, run.ended);
  }
  async fetch(request: Request) {
    const generation = Number(request.headers.get('X-Generation')), account = request.headers.get('X-Account');
    const session = request.headers.get('X-Session');
    const previous = this.run;
    if (!session || !account || !request.headers.has('X-Generation') || !Number.isSafeInteger(generation) || generation < 0) return new Response(null, {status: 400});
    if (previous) {
      const closed = previous.stopping || previous.ended !== undefined || (this.watching === generation && !this.ctx.container?.running);
      if (generation < previous.generation || (generation === previous.generation && closed)) return new Response(null, {status: 409});
    }
    const run = {generation, account, session, lastAlive: Date.now()};
    this.ctx.storage.kv.put('run', run);
    const response = super.fetch(request); // 世代照合とstartの間にawaitを挟まない。
    if (this.ctx.container?.running) this.watch(run);
    return response;
  }
  async stop(generation: number) {
    const previous = this.run;
    if (previous && previous.generation > generation) return Date.now();
    const run = previous?.generation === generation ? previous : {generation, account: '', session: '', lastAlive: Date.now()};
    this.ctx.storage.kv.put('run', {...run, stopping: true}); // 未起動でも遅着要求を封じる。
    if (this.ctx.container?.running) await this.ctx.container.destroy();
    const ended = this.run?.ended ?? Date.now();
    this.ctx.storage.kv.put('run', {...run, stopping: true, ended});
    return ended;
  }
}
