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
  const correct = ['相手が有利です。', 'あなたは金を動かしました。', '相手が勝ちました。', 'あなたは負けました。', '相手は宣言可能です。', 'あなたは詰まされる側です。', 'あなたは先手です。', '第一歩は、次の一手を盤上で確認することです。', '一段と玉を安全にする練習をしましょう。', '相手が金を取った飛車を桂で取り返す形を検討しましょう。', 'あなたが金を動かした局面では相手が有利です。'];
  const wrong = ['あなたが有利です。', '相手は金を動かしました。', 'あなたは玉を動かしました。', 'あなたが勝ちました。', '相手は負けました。', 'あなたは宣言可能です。', '相手は詰まされる側です。', 'あなたは後手です。'];
  it.each(correct)('正しい文・通常表現を誤って拒否しない: %s', text => {
    expect(() => validateOutput(section(text), refs, facts)).not.toThrow();
  });
  it.each(wrong)('明示的な矛盾を拒否する: %s', text => {
    expect(() => validateOutput(section(text), refs, facts)).toThrow('invalid_output');
  });
  it.each([
    'あなたが金を動かした局面ではあなたが有利です。',
    'あなたが金を動かした局面ではあなたが勝ちました。',
    'あなたが金を動かし相手が有利になった局面ではあなたが宣言可能です。',
  ])('後続の主語の矛盾も個別に検査する: %s', text => {
    expect(() => validateOutput(section(text), refs, facts)).toThrow('invalid_output');
  });
  it.each([
    '相手が有利ではありません。',
    '相手が有利ではなかったです。',
    '相手が有利にならないように玉を守りましょう。',
    '相手が有利なら玉を守りましょう。',
    '相手が有利だった場合の手順を検討しましょう。',
    '相手が有利になったと仮定します。',
    'あなたが悪手を指せば相手が有利です。',
    '相手が有利になるのを防ぐために受けを確認します。',
    'あなたが勝ちましたとは言えません。',
    'あなたが宣言可能でない局面もあります。',
    '相手が玉を動かさないように備えましょう。',
    '相手が有利になる可能性があります。',
    'あなたが勝ちましたというのは誤解です。',
    '相手が金を動かす練習を行います。',
  ])('否定・仮定・予防の助言を断定として拒否しない: %s', text => {
    const ownFavored = {...facts, 参照: facts.参照.map(r => ({...r, 優勢な側: 'あなた'}))};
    expect(() => validateOutput(section(text), refs, ownFavored)).not.toThrow();
  });
  it('観戦の呼称・未確定の宣言勝ちを拒否する', () => {
    expect(contradicts('あなたが有利です。', ['1:position'], {...facts, 視点: '観戦'})).toBe(true);
    expect(contradicts('相手玉の安全を考えましょう。', [], {...facts, 視点: '観戦'})).toBe(false);
    expect(contradicts('あなたが勝ちました。', [], {...facts, 終局: {勝敗: '不明'}})).toBe(true);
  });
  it('解析事実に生USIや評価値を含めず、利用者が書いた数値は表記を変えずに保持する', async () => {
    const numbers = '評価は＋６００、−300、+ 500、+600、-300です';
    const p = parseCoach({...await payload(), question: '7g7f の ' + numbers,
      profile: {practice: [numbers], goal: numbers}, history: [{role: 'user', content: numbers}, {role: 'assistant', content: numbers}]});
    const sent = JSON.parse(messages(p, refs, facts)[1].content);
    expect(JSON.stringify(sent)).not.toMatch(/7g7f|startpos|"score"|"value"/);
    expect(sent.question).toBe('（指し手は参照で確認） の ' + numbers);
    expect(sent.profile).toEqual({practice: [numbers], goal: numbers});
    expect(sent.history).toEqual(p.history);
    expect(sent.facts).toEqual(facts);
  });
});

describe('出力の手数・KIF照合', () => {
  const rows: CoachFacts['実戦手'] = [
    [1, '▲7六歩(77)', '疑問手', '互角'], [2, '△3四歩(33)', '判定なし', '不利'],
  ];
  const results = [{...analysis.results[0], candidates: [{rank: 1, score: null, pv: ['2g2f']}, {rank: 2, score: null, pv: ['5g5f']}]},
    analysis.results[1], {ply: 2, score: null, candidates: [], mate: null}];
  const all = references(results);
  const sample: CoachFacts = {...facts, 実戦手: rows, 参照: [...facts.参照, {
    id: '0:candidate:1', 読み筋: [{表記: '▲2六歩(27)'}, {表記: '△同　成桂(34)'}, {表記: '▲3五角打'}],
  }]};
  it.each([
    '1手目 ▲7六歩(77)から、2手目の△3四歩まで進みました。',
    '１ 手目：☗７六歩。おすすめは ▲2六歩。',
    '候補は二六歩、続いて△同成桂(34)や▲3五角打。',
    '指す前に候補を2つ読み、1手詰めも確認しましょう。',
    '練習では一歩ずつ、駒の利きを確認します。',
  ])('資料の表記や通常の数字を許可: %s', text => {
    expect(() => validateOutput(section(text), all, sample)).not.toThrow();
  });
  it.each([
    '▲2四歩', '△7六歩', '1手目 ▲7六歩(78)', '▲7六歩成', '▲3五角', '△同成銀',
    '1手目 ▲2六歩', '2手目 △同成桂', '1手目 △3四歩', '0手目', '1手目と３手目', '▲',
    '評価値-1200', '＋３５０', '評価値は − 1200', '評価値は500', '2g2f',
  ])('未知・不一致の手、評価値、USIを拒否: %s', text => {
    expect(() => validateOutput(section(text), all, sample)).toThrow('invalid_output');
  });
  it('一覧のみの局面は参照・意味照合できるが、未提示の候補は参照できない', () => {
    const output = (id: string, text: string) => ({sections: [{...section(text).sections[0], refs: [id]}]});
    expect(() => validateOutput(output('2:position', '2手目 △3四歩。相手は歩を進めました。相手が有利です。'), all, sample)).not.toThrow();
    expect(() => validateOutput(output('2:position', 'あなたは歩を進めました。'), all, sample)).toThrow('invalid_output');
    expect(() => validateOutput(output('0:candidate:2', '振り返りましょう。'), all, sample)).toThrow('invalid_output');
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
  it('権利の外部照会を受理・実行・成功確定時に更新し、生成中の取消は保存しない', async () => fixture(async state => {
    let active = true, cached = true, checks = 0;
    const c = new Coach(state.storage, config, 'device', () => cached,
      async () => { active = false; return undefined; },
      async () => { checks++; cached = active; });
    const p = await payload();
    expect((await c.fetch(post(p))).status).toBe(202);
    expect(checks).toBe(2);
    await c.alarm();
    const result = await (await c.fetch(new Request('https://device/v1/coach/' + p.requestId))).json() as any;
    expect(result.status).toBe('failed'); expect(result.error).toBe('paid_required');
    expect(result.sections).toBeUndefined(); expect(c.quota().used).toBe(0); expect(c.quota().reserved).toBe(0);
    expect(checks).toBeGreaterThanOrEqual(4);
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
  it('同期要求も実行前にwatchdogを永続化し、再生成後のalarmだけで入力を削除する', async () => fixture(async state => {
    await state.storage.deleteAlarm();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => {release = r;});
    const called = new Promise<void>(r => {entered = r;});
    const c = new Coach(state.storage, config, 'device', () => true, async () => {entered(); await gate; return undefined;});
    const p = await payload(), running = c.fetch(post(p, false));
    await called;
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const {deadline} = state.storage.sql.exec<{deadline: number}>('SELECT deadline FROM coach_requests WHERE id=?', p.requestId).one();
      expect(await state.storage.getAlarm()).toBe(deadline);
      clock = vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
      await new Coach(state.storage, config, 'device', () => true).alarm();
      expect(state.storage.sql.exec('SELECT payload FROM coach_tasks WHERE id=?', p.requestId).one().payload).toBeNull();
      expect(state.storage.sql.exec('SELECT status FROM coach_requests WHERE id=?', p.requestId).one().status).toBe('failed');
      expect(c.quota().reserved).toBe(0);
      release(); expect((await running).status).toBe(504);
    } finally {release(); await running; clock?.mockRestore();}
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
        expect(body.question).toBe('1手目はどうでしたか？');
        received = true; return Response.json(facts);
      }})};
      const p = {...await payload(), question: '1手目はどうでしたか？'};
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
