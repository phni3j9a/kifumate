import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { Coach, messages, parseCoach, references, signAnalysis, validateOutput } from '../src/coach';
import { contradicts, type CoachFacts } from '../src/coach-facts';
import { Device } from '../src/index';

const analysis = {initial: 'startpos', moves: ['7g7f'], mode: 'precise' as const,
  results: [0, 1].map(ply => ({ply, score: {kind: 'cp', value: -600}, candidates: [], mate: null}))};
const refs = references(analysis.results);
const facts: CoachFacts = {視点: 'あなたが先手、相手が後手', 実戦手: [], 終局: {勝った側: '相手', 負けた側: 'あなた'}, 参照: [
  {id: '1:position', 優勢な側: '相手', 詰まされる側: 'あなた', 宣言できる側: '相手', 直前の実戦手: {指した側: 'あなた', 動いた駒: '金', 取った駒: '歩'}},
]};
const section = (text: string) => ({sections: [{kind: 'facts', title: '振り返り', text, refs: ['1:position']}]});
const config = {ENVIRONMENT: 'staging', COACH_PROVIDER: 'fake', COACH_SIGNING_KEY: 'key'};
async function payload() {
  return {requestId: crypto.randomUUID(), analysis, proof: await signAnalysis('key', 'device', 'job', {initial: analysis.initial, moves: analysis.moves, mode: analysis.mode}, analysis.results), perspective: 'sente',
    profile: {practice: [], goal: ''}, style: {focus: '総合', detail: 'ふつう'}, history: []};
}
function post(p: unknown, async = true, signal?: AbortSignal) {
  return new Request('https://device/v1/coach', {method: 'POST', headers: {'Content-Type': 'application/json', ...(async ? {Prefer: 'respond-async'} : {})}, body: JSON.stringify(p), signal});
}
const devices = (env as unknown as {DEVICES: DurableObjectNamespace<Device>}).DEVICES;
async function fixture(callback: (state: DurableObjectState) => Promise<void>) {
  await runInDurableObject(devices.getByName(crypto.randomUUID()), async (_, state) => callback(state));
}

describe('日本語事実の矛盾検査', () => {
  const correct = ['相手が有利です。', 'あなたは金を動かしました。', '相手が勝ちました。', 'あなたは負けました。', '相手は宣言可能です。', 'あなたは詰まされる側です。', 'あなたは先手です。', '第一歩は、次の一手を盤上で確認することです。', '一段と玉を安全にする練習をしましょう。'];
  const wrong = ['あなたが有利です。', '相手は金を動かしました。', 'あなたは玉を動かしました。', 'あなたが勝ちました。', '相手は負けました。', 'あなたは宣言可能です。', '相手は詰まされる側です。', 'あなたは後手です。'];
  it.each(correct)('正しい文・通常表現を誤って拒否しない: %s', text => {
    expect(() => validateOutput(section(text), refs, facts)).not.toThrow();
  });
  it.each(wrong)('明示的な矛盾を拒否する: %s', text => {
    expect(() => validateOutput(section(text), refs, facts)).toThrow('invalid_output');
  });
  it('観戦の呼称・未確定の宣言勝ちを拒否する', () => {
    expect(contradicts('あなたが有利です。', ['1:position'], {...facts, 視点: '観戦'})).toBe(true);
    expect(contradicts('あなたが勝ちました。', [], {...facts, 終局: {勝敗: '不明'}})).toBe(true);
  });
  it('資料と自由文のどちらからも生USIと符号付き評価を送らない', async () => {
    const p = parseCoach({...await payload(), question: '7g7f の +600 と -300 は？'});
    const sent = JSON.parse(messages(p, refs, facts)[1].content);
    expect(JSON.stringify(sent)).not.toMatch(/7g7f|startpos|\+600|-300|"score"|"value"/);
    expect(sent.facts).toEqual(facts);
  });
});

describe('依頼と取得の分離', () => {
  it('切断・DO再生成後もalarmで完了し、再取得では一度しか数えない', async () => fixture(async state => {
    const c = new Coach(state.storage, config, 'device', () => true), p = await payload();
    const connection = new AbortController();
    expect((await c.fetch(post(p, true, connection.signal))).status).toBe(202);
    connection.abort();
    expect(c.quota().reserved).toBe(1);
    const restored = new Coach(state.storage, config, 'device', () => true);
    await restored.alarm(); await restored.alarm();
    for (let i = 0; i < 2; i++) {
      const output = await (await restored.fetch(new Request('https://device/v1/coach/' + p.requestId))).json() as any;
      expect(output.status).toBe('completed'); expect(output.sections).toHaveLength(2);
      expect(output.quota.used).toBe(1); expect(output.quota.reserved).toBe(0);
    }
    expect((await restored.fetch(post(p))).status).toBe(409);
    const latest = await (await restored.fetch(new Request('https://device/v1/coach'))).json() as any;
    expect(latest.latest.requestId).toBe(p.requestId);
    expect(latest.latest.status).toBe('completed');
    const free = new Coach(state.storage, config, 'device', () => false);
    expect((await free.fetch(new Request('https://device/v1/coach/' + p.requestId))).status).toBe(200);
  }));
  it('実行前の中止・権利失効・提供元失敗は数えず、状態を取得できる', async () => fixture(async state => {
    let paid = true;
    const c = new Coach(state.storage, config, 'device', () => paid), p = await payload();
    await c.fetch(post(p));
    await c.fetch(new Request('https://device/v1/coach/' + p.requestId, {method: 'DELETE'}));
    await c.alarm();
    expect(c.quota().used).toBe(0);
    const p2 = await payload(); await c.fetch(post(p2)); paid = false; await c.alarm();
    const failed = await (await c.fetch(new Request('https://device/v1/coach/' + p2.requestId))).json() as any;
    expect(failed.status).toBe('failed'); expect(failed.error).toBe('paid_required');
    expect(c.quota().used).toBe(0); expect(c.quota().reserved).toBe(0);
  }));
  it('生成中の中止は遅延応答を保存せず、同時依頼も拒否する', async () => fixture(async state => {
    const c = new Coach(state.storage, {...config, COACH_PROVIDER: 'openai-compatible', COACH_API_KEY: 'test'}, 'device', () => true);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => {release = r;});
    const called = new Promise<void>(r => {entered = r;});
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      entered(); await gate;
      return Response.json({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(section('解析を振り返りましょう。'))}}]});
    });
    try {
      const p = await payload(); await c.fetch(post(p));
      const running = c.alarm(); await called;
      expect((await c.fetch(post(await payload()))).status).toBe(409);
      await c.fetch(new Request('https://device/v1/coach/' + p.requestId, {method: 'DELETE'}));
      release(); await running;
      const output = await (await c.fetch(new Request('https://device/v1/coach/' + p.requestId))).json() as any;
      expect(output.status).toBe('cancelled'); expect(output.sections).toBeUndefined();
      expect(c.quota().used).toBe(0); expect(c.quota().reserved).toBe(0);
    } finally {release(); spy.mockRestore();}
  }));
  it('実行途中のプロセス消失は再送せず期限で予約を返す。保存結果は七日で削除', async () => fixture(async state => {
    const c = new Coach(state.storage, config, 'device', () => true), p = await payload();
    await c.fetch(post(p));
    state.storage.sql.exec('UPDATE coach_tasks SET started=1 WHERE id=?', p.requestId);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 240001);
    try {
      const restored = new Coach(state.storage, config, 'device', () => true); await restored.alarm();
      const failed = await (await restored.fetch(new Request('https://device/v1/coach/' + p.requestId))).json() as any;
      expect(failed.status).toBe('failed'); expect(failed.error).toBe('coach_timeout'); expect(restored.quota().reserved).toBe(0);
      expect(state.storage.sql.exec('SELECT payload FROM coach_tasks WHERE id=?', p.requestId).one().payload).toBeNull();
      clock.mockReturnValue(Date.now() + 7 * 86400_000 + 1);
      expect((await restored.fetch(new Request('https://device/v1/coach/' + p.requestId))).status).toBe(410);
      expect(state.storage.sql.exec('SELECT * FROM coach_tasks WHERE id=?', p.requestId).toArray()).toHaveLength(0);
    } finally {clock.mockRestore();}
  }));
});

describe('実APIの接続', () => {
  it('Worker内のalarmが中継で日本語化し、提供元へ生棋譜を送らない', async () => {
    await runInDurableObject(devices.getByName(crypto.randomUUID()), async (instance: any) => {
      await instance.fetch(new Request('https://device/register?hash=' + 'a'.repeat(64), {method: 'POST'}));
      instance.env.COACH_SIGNING_KEY = 'key';
      instance.env.COACH_PROVIDER = 'openai-compatible';
      instance.env.COACH_API_KEY = 'test-secret';
      let received = false;
      instance.env.PRECISE = {getByName: () => ({fetch: async (url: string, init: RequestInit) => {
        expect(url).toBe('http://container/coach-facts');
        const body = JSON.parse(init.body as string);
        expect(body.initial).toBe('startpos'); expect(body.perspective).toBe('sente');
        received = true; return Response.json(facts);
      }})};
      const p = await payload();
      p.proof = await signAnalysis('key', instance.ctx.id.toString(), 'job', {initial: analysis.initial, moves: analysis.moves, mode: analysis.mode}, analysis.results);
      const request = post(p); request.headers.set('X-Dev-Paid', '1');
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        expect(url).toBe('https://api.deepseek.com/chat/completions');
        const body = JSON.parse(init!.body as string);
        expect(body.model).toBe('deepseek-flash'); expect(body.reasoning_effort).toBe('max'); expect(body.max_tokens).toBe(32768);
        expect(body.messages[1].content).not.toMatch(/7g7f|startpos|"score"|-600/);
        return Response.json({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(section('相手が有利です。'))}}]});
      });
      try {
        expect((await instance.fetch(request)).status).toBe(202);
        await instance.alarm(); expect(received).toBe(true);
        const get = new Request('https://device/v1/coach/' + p.requestId); get.headers.set('X-Dev-Paid', '1');
        const output = await (await instance.fetch(get)).json();
        expect(output.status).toBe('completed'); expect(output.sections[0].text).toBe('相手が有利です。'); expect(output.quota.used).toBe(1);
      } finally {spy.mockRestore();}
    });
  });
});
