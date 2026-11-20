import { env } from 'cloudflare:workers';
import { SELF, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { Device } from '../src/index';
import { Coach, PROOF_LIFETIME, checkNames, complete, messages, parseCoach, references, signAnalysis, validateOutput, verifyAnalysis, type CoachEnv } from '../src/coach';
import { MODEL_PROFILES } from '../src/coach-models';
import { monthStart, nextMonth, sha256 } from '../src/model';

const devices = (env as unknown as {DEVICES: DurableObjectNamespace<Device>}).DEVICES;
const input = {initial: 'startpos', moves: ['7g7f'], mode: 'precise' as const};
const results = [0, 1].map(ply => ({ply, score: {kind: 'cp', value: 20}, candidates: [{rank: 1, score: {kind: 'cp', value: 20}, pv: [ply ? '3c3d' : '7g7f']}], mate: null}));
const config: CoachEnv = {ENVIRONMENT: 'staging', COACH_PROVIDER: 'fake', COACH_SIGNING_KEY: 'test-key'};
async function payload(device: string, now = Date.now()) {
  return {requestId: crypto.randomUUID(), analysis: {...input, results}, proof: await signAnalysis('test-key', device, 'job', input, results, now),
    perspective: 'sente', profile: {practice: ['四間飛車'], goal: '終盤に強くなる'}, style: {focus: '総合', detail: 'ふつう'}, history: []};
}
function req(data: unknown) { return new Request('https://device/v1/coach', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)}); }
async function fixture() {
  const stub = devices.getByName(await sha256(crypto.randomUUID()));
  return stub;
}
const refs = references(results);
const safe = {sections: [{kind: 'facts', title: '振り返り', text: '解析の候補を確かめましょう。', refs: [refs[0].id]}, {kind: 'advice', title: '練習', text: '終盤を練習しましょう。', refs: []}]};

describe('精密結果の署名', () => {
  it('順序に依存せず棋譜・全結果・端末・精密・期限を結びつける', async () => {
    const now = Date.now(), p = await signAnalysis('test-key', 'device', 'job', input, results, now);
    await expect(verifyAnalysis('test-key', 'device', {mode: 'precise', moves: input.moves, initial: 'startpos'}, results, p, now)).resolves.toBeUndefined();
    await expect(verifyAnalysis('test-key', 'other', input, results, p, now)).rejects.toThrow('invalid_proof');
    await expect(verifyAnalysis('other-key', 'device', input, results, p, now)).rejects.toThrow('invalid_proof');
    await expect(verifyAnalysis('test-key', 'device', input, [{...results[0], score: null}, results[1]], p, now)).rejects.toThrow('invalid_proof');
    await expect(verifyAnalysis('test-key', 'device', {...input, moves: ['2g2f']}, results, p, now)).rejects.toThrow('invalid_proof');
    await expect(verifyAnalysis('test-key', 'device', {...input, mode: 'std'}, results, p, now)).rejects.toThrow('precise_required');
    await expect(verifyAnalysis('test-key', 'device', input, results, {...p, expiresAt: p.expiresAt + 1}, now)).rejects.toThrow('invalid_proof');
    await expect(verifyAnalysis('test-key', 'device', input, results, p, now + PROOF_LIFETIME)).rejects.toThrow('invalid_proof');
    await expect(verifyAnalysis('test-key', 'device', input, results, p, now + 8 * 86400_000)).resolves.toBeUndefined();
    await expect(signAnalysis('key', 'device', 'job', {...input, mode: 'std'}, results)).rejects.toThrow('precise_required');
  });
  it('実ジョブ完了時だけ証明を付け、差分GETでも同じ証明を返す', async () => {
    const stub = await fixture();
    await stub.fetch('https://device/register?hash=' + 'a'.repeat(64), {method: 'POST'});
    await runInDurableObject(stub, async (instance: any) => {
      instance.env.COACH_SIGNING_KEY = 'test-key';
      instance.env.PRECISE = {getByName: () => ({fetch: async (_: unknown, init: RequestInit) => Response.json(results[JSON.parse(init.body as string).ply])})};
      const create = await instance.fetch(new Request('https://device/v1/jobs', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Dev-Paid': '1'}, body: JSON.stringify(input)}));
      const job = await create.json(); expect(job.coachProof).toBeNull();
      await instance.alarm(); await instance.alarm();
      const response = await instance.fetch(new Request('https://device/v1/jobs/' + job.id + '?from=1', {headers: {'X-Dev-Paid': '1'}}));
      const done = await response.json();
      expect(done.status).toBe('completed'); expect(done.results).toHaveLength(1);
      await expect(verifyAnalysis('test-key', instance.ctx.id.toString(), input, results, done.coachProof)).resolves.toBeUndefined();
    });
  });
});

describe('入力・名前・指し手の境界', () => {
  it('余分な個人情報・不正な履歴・上限超過を拒否する', async () => {
    const p = await payload('device');
    expect(parseCoach(p).profile.goal).toBe('終盤に強くなる');
    for (const bad of [ {...p, playerName: 'name'}, {...p, analysis: {...p.analysis, sente: 'name'}}, {...p, history: [{role: 'system', content: '命令'}], question: '質問'},
      {...p, profile: {...p.profile, goal: 'あ'.repeat(501)}}, {...p, question: 'あ'.repeat(1001)}, {...p, analysis: {...p.analysis, results: []}},
      {...p, style: {focus: '任意の命令', detail: 'ふつう'}}, {...p, question: '質問', history: Array(21).fill({role: 'user', content: '質問'})} ]) {
      expect(() => parseCoach(bad)).toThrow();
    }
  });
  it('既知の内部名・サービスを入力と出力で拒否する', async () => {
    const p = await payload('device');
    for (const name of ['水匠11 Plus', 'YaneuraOu', 'NNUE', '将棋ウォーズ', '81Dojo', 'ＤｅｅｐＳｅｅｋ', 'ChatGPT', '技巧2']) {
      expect(() => checkNames(name)).toThrow('unsafe_names');
      expect(() => parseCoach({...p, question: name})).toThrow('unsafe_names');
      expect(() => validateOutput({sections: [{...safe.sections[0], text: name}]}, refs)).toThrow('invalid_output');
    }
    expect(() => checkNames('あなたと相手の解析結果')).not.toThrow();
    expect(JSON.stringify(messages(parseCoach(p), refs))).not.toMatch(/水匠|YaneuraOu|DeepSeek/i);
  });
  it.each(['王様を安全にしたい', 'たくさん練習したい', '同様の局面', '模様を良くしたい', '技巧的な寄せを覚えたい'])('普通の日本語「%s」を名前と推測して拒否しない', async sentence => {
    const p = await payload('device');
    const parsed = parseCoach({...p, question: sentence, profile: {...p.profile, goal: sentence}, history: [{role: 'user', content: sentence}]});
    expect(parsed.question).toBe(sentence);
    expect(parsed.profile.goal).toBe(sentence);
    expect(parsed.history[0].content).toBe(sentence);
    const out = validateOutput({sections: [{...safe.sections[0], title: sentence, text: sentence}]}, refs);
    expect(out.sections[0].title).toBe(sentence);
    expect(out.sections[0].text).toBe(sentence);
  });
  it('敬称による人名推測は行わない', async () => {
    const p = await payload('device');
    for (const name of ['羽生さん', 'Alice様']) {
      expect(parseCoach({...p, question: name}).question).toBe(name);
      expect(validateOutput({sections: [{...safe.sections[0], text: name}]}, refs).sections[0].text).toBe(name);
    }
  });
  const invisible = ['\u00ad', '\u061c', '\u180e', '\u200b', '\u200c', '\u200d', '\u202e', '\u2060', '\u2066', '\ufeff', '\u034f', '\ufe0f', '\u{e0100}', '\u{e0001}'];
  it('書式文字やゼロ幅文字を挟んだ禁止名をLLM入力で拒否する', async () => {
    const p = await payload('device');
    for (const separator of invisible) {
      for (const name of ['水匠', 'YaneuraOu', '将棋ウォーズ', 'ＤｅｅｐＳｅｅｋ']) {
        const hidden = name[0] + separator + name.slice(1);
        expect(() => checkNames(hidden)).toThrow('unsafe_names');
        for (const data of [ {...p, question: hidden}, {...p, profile: {...p.profile, goal: hidden}},
          {...p, profile: {...p.profile, practice: [hidden]}}, {...p, question: '質問', history: [{role: 'assistant', content: hidden}]} ]) {
          expect(() => messages(parseCoach(data), refs)).toThrow('unsafe_names');
        }
      }
    }
  });
  it('書式文字やゼロ幅文字を挟んだ禁止名を出力で拒否する', () => {
    for (const separator of invisible) {
      const hidden = '水' + separator + '匠';
      for (const section of [{...safe.sections[0], text: hidden}, {...safe.sections[0], title: hidden}]) {
        expect(() => validateOutput({sections: [section]}, refs)).toThrow('invalid_output');
      }
    }
  });
  it('禁止名を含まない文もLLM送信本文とアプリ応答から不可視文字を除去する', async () => {
    const p = await payload('device');
    for (const separator of invisible) {
      const hidden = '振' + separator + 'り返り';
      const parsed = parseCoach({...p, profile: {practice: [hidden], goal: hidden}, question: hidden, history: [{role: 'user', content: hidden}]});
      const sent = JSON.parse(messages(parsed, refs)[1].content);
      expect(sent.profile).toEqual({practice: ['振り返り'], goal: '振り返り'});
      expect(sent.question).toBe('振り返り');
      expect(sent.history[0].content).toBe('振り返り');
      const out = validateOutput({sections: [{...safe.sections[0], title: hidden, text: hidden}]}, refs);
      expect(out.sections[0].title).toBe('振り返り');
      expect(out.sections[0].text).toBe('振り返り');
    }
  });
  it('不可視文字を除去すると空になる質問・出力を拒否する', async () => {
    const p = await payload('device');
    expect(() => parseCoach({...p, question: '\u2060'})).toThrow('invalid_input');
    expect(() => validateOutput({sections: [{...safe.sections[0], text: '\u2060'}]}, refs)).toThrow('invalid_output');
  });
  it('任意の読み筋や評価値を本文に出せず、署名済み参照だけを返す', () => {
    const out = validateOutput(safe, refs);
    expect(out.sections[0].references[0]).toEqual(refs[0]);
    for (const bad of ['7g7f', '７六歩', '▲７六歩', '七六歩', '評価値は+100です', '3c3d']) {
      expect(() => validateOutput({sections: [{...safe.sections[0], text: bad}]}, refs)).toThrow('invalid_output');
    }
    expect(() => validateOutput({sections: [{...safe.sections[0], refs: ['0:candidate:99']}]}, refs)).toThrow('invalid_output');
    expect(() => validateOutput({sections: [{...safe.sections[0], refs: []}]}, refs)).toThrow('invalid_output');
    expect(() => validateOutput({sections: [{...safe.sections[0], pv: ['7g7g']}]}, refs)).toThrow('invalid_output');
  });
});

describe('提供元', () => {
  it('OpenAI互換URL・モデル・認証・トークンパラメータを差し替え可能', async () => {
    const p = parseCoach(await payload('device'));
    for (const [base, model, parameter] of [['https://api.openai.com/v1', 'gpt-6-luna', 'max_completion_tokens'], ['https://api.deepseek.com', 'deepseek-flash', 'max_tokens']]) {
      let called = false;
      const transport = async (url: any, init: any) => {
        called = true; expect(url).toBe(base + '/chat/completions');
        expect(init.headers.Authorization).toBe('Bearer secret');
        const body = JSON.parse(init.body); expect(body.model).toBe(model); expect(body[parameter]).toBe(32768); expect(body.stream).toBe(false); expect(body.reasoning_effort).toBe('max');
        return Response.json({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(safe)}}]});
      };
      expect(await complete({...config, COACH_PROVIDER: 'openai-compatible', COACH_BASE_URL: base, COACH_MODEL: model, COACH_TOKEN_PARAMETER: parameter, COACH_API_KEY: 'secret'}, p, refs, new AbortController().signal, transport)).toEqual(safe);
      expect(called).toBe(true);
    }
    await expect(complete({...config, ENVIRONMENT: 'production'}, p, refs, new AbortController().signal)).rejects.toThrow('provider_unavailable');
    await expect(complete({...config, COACH_PROVIDER: 'openai-compatible'}, p, refs, new AbortController().signal)).rejects.toThrow('provider_unavailable');
  });
  it('gpt-6.1-terraはChat Completionsでmax_completion_tokensと最大推論を使う', async () => {
    const p = parseCoach(await payload('device'));
    expect(MODEL_PROFILES['gpt-6.1-terra']).toMatchObject({
      id: 'gpt-6.1-terra', tokenParameter: 'max_completion_tokens', reasoningEffort: 'max', maxOutputTokens: 128000,
      pricePerMillion: {input: 1, cachedInput: 0.05, output: 5, cacheWrite30m: 1.25},
    });
    const base = {...config, COACH_PROVIDER: 'openai-compatible', COACH_BASE_URL: 'https://api.openai.com/v1', COACH_MODEL: 'gpt-6.1-terra', COACH_TOKEN_PARAMETER: 'max_tokens', COACH_API_KEY: 'secret'};
    const transport = async (url: any, init: any) => {
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({model: 'gpt-6.1-terra', max_completion_tokens: 32768, reasoning_effort: 'max', stream: false, response_format: {type: 'json_object'}});
      expect(body.max_tokens).toBeUndefined();
      return Response.json({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(safe)}}]});
    };
    expect(await complete(base, p, refs, new AbortController().signal, transport)).toEqual(safe);
    const raised = async (_url: any, init: any) => {
      expect(JSON.parse(init.body).max_completion_tokens).toBe(128000);
      return Response.json({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(safe)}}]});
    };
    await complete({...base, COACH_MAX_TOKENS: '128000'}, p, refs, new AbortController().signal, raised);
    const fallback = async (_url: any, init: any) => {
      expect(JSON.parse(init.body).max_completion_tokens).toBe(32768);
      return Response.json({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(safe)}}]});
    };
    await complete({...base, COACH_MAX_TOKENS: '128001'}, p, refs, new AbortController().signal, fallback);
  });
  it('WorkersのネイティブRequestで提供元の送信オプションを受理でき、リダイレクトを追わない', async () => {
    const p = parseCoach(await payload('device'));
    const e = {...config, COACH_PROVIDER: 'openai-compatible', COACH_API_KEY: 'test'};
    let calls = 0;
    const transport: typeof fetch = async (url, init) => {
      const request = new Request(url, init);
      expect(request.redirect).toBe('manual');
      calls++;
      return calls === 1 ? Response.json({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(safe), reasoning_content: '非公開の推論'}}]})
        : new Response(null, {status: 302, headers: {Location: 'https://other-provider.test'}});
    };
    await expect(complete(e, p, refs, new AbortController().signal, transport)).resolves.toEqual(safe);
    await expect(complete(e, p, refs, new AbortController().signal, transport)).rejects.toThrow('provider_failed');
    expect(calls).toBe(2);
  });
  it('提供元の診断はHTTPステータス・固定種別・所要時間だけを残す', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const p = parseCoach(await payload('device'));
    const e = {...config, COACH_PROVIDER: 'openai-compatible', COACH_API_KEY: 'private-key'};
    try {
      await expect(complete(e, p, refs, new AbortController().signal, async () => new Response('private-body', {status: 429}))).rejects.toThrow('provider_failed');
      expect(JSON.parse(logs.mock.calls[0][0])).toEqual({event: 'coach_provider_failed', stage: 'provider_http', errorType: 'ApiError', httpStatus: 429, elapsedMs: expect.any(Number)});
      const failure = new TypeError('private-key private-question');
      failure.name = 'private-name';
      await expect(complete(e, p, refs, new AbortController().signal, async () => {throw failure;})).rejects.toThrow();
      expect(JSON.parse(logs.mock.calls[1][0])).toEqual({event: 'coach_provider_failed', stage: 'provider_fetch', errorType: 'TypeError', elapsedMs: expect.any(Number)});
      expect(JSON.stringify(logs.mock.calls)).not.toMatch(/private-|四間飛車|終盤に強くなる/);
    } finally { logs.mockRestore(); }
  });
  it('提供元エラー・不正JSON・途中打切り・過大応答は失敗する', async () => {
    const e = {...config, COACH_PROVIDER: 'openai-compatible', COACH_BASE_URL: 'https://provider.test', COACH_MODEL: 'model', COACH_API_KEY: 'secret'};
    const p = parseCoach(await payload('device'));
    for (const response of [new Response('private detail', {status: 500}), Response.json({choices: [{finish_reason: 'length', message: {content: '{}'}}]}), Response.json({choices: [{finish_reason: 'stop', message: {content: 'invalid'}}]}), new Response('x'.repeat(1048577))]) {
      await expect(complete(e, p, refs, new AbortController().signal, async () => response)).rejects.toThrow();
    }
  });
});

describe('権利・回数・中止', () => {
  it('認証と内部ヘッダー偽装を拒否する', async () => {
    expect((await SELF.fetch('https://api/v1/coach')).status).toBe(401);
    const reg = await SELF.fetch('https://api/v1/devices', {method: 'POST'}); const {token} = await reg.json() as any;
    expect((await SELF.fetch('https://api/v1/coach', {headers: {Authorization: `Bearer ${token}`, 'X-Dev-Paid': '1'}})).status).toBe(200);
    const blocked = await SELF.fetch('https://api/v1/coach', {method: 'POST', headers: {Authorization: `Bearer ${token}`, 'X-Dev-Paid': '1'}});
    expect(blocked.status).toBe(403);
  });
  it('設定ヘッダーを無視し、署名鍵・提供元はDO自身のenvから読む', async () => {
    const reg = await SELF.fetch('https://api/v1/devices', {method: 'POST'}); const {token} = await reg.json() as any;
    await SELF.fetch('https://api/v1/coach', {headers: {Authorization: `Bearer ${token}`, 'X-Coach-Config': JSON.stringify({ENVIRONMENT: 'attacker', COACH_API_KEY: 'injected'})}});
    await runInDurableObject(devices.getByName(await sha256(token)), async (instance: any) => {
      expect(instance.env.ENVIRONMENT).toBe('staging'); expect(instance.env.COACH_API_KEY).toBeUndefined();
      instance.env.COACH_SIGNING_KEY = 'test-key'; instance.env.COACH_PROVIDER = 'fake';
      const p = await payload(instance.ctx.id.toString());
      const initial = req(p); initial.headers.set('X-Dev-Paid', '1');
      expect((await instance.fetch(initial)).status).toBe(200);
      instance.env.COACH_PROVIDER = 'openai-compatible';
      const next = req({...p, requestId: crypto.randomUUID()}); next.headers.set('X-Dev-Paid', '1');
      next.headers.set('X-Coach-Config', JSON.stringify({COACH_PROVIDER: 'fake', COACH_API_KEY: 'injected'}));
      expect((await instance.fetch(next)).status).toBe(503);
      expect(instance.env.COACH_API_KEY).toBeUndefined(); expect(instance.coach.quota().used).toBe(1);
    });
  });
  it('成功した解説と質問だけ各一回、重複と失敗と中止は数えない', async () => {
    const stub = await fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const coach = new Coach(state.storage, {...config, COACH_MONTHLY_LIMIT: '3'}, 'device', () => true);
      const p = await payload('device');
      expect((await coach.fetch(req(p))).status).toBe(200); expect(coach.quota().used).toBe(1);
      expect((await coach.fetch(req(p))).status).toBe(409); expect(coach.quota().used).toBe(1);
      expect((await coach.fetch(req({...p, requestId: crypto.randomUUID(), question: '終盤はどうする？', history: [{role: 'assistant', content: '終盤を練習しましょう'}]}))).status).toBe(200);
      const id = crypto.randomUUID();
      expect((await coach.fetch(new Request('https://device/v1/coach/' + id, {method: 'DELETE'}))).status).toBe(200);
      expect((await coach.fetch(req({...p, requestId: id}))).status).toBe(409);
      const unavailable = new Coach(state.storage, {...config, COACH_PROVIDER: 'openai-compatible'}, 'device', () => true);
      expect((await unavailable.fetch(req({...p, requestId: crypto.randomUUID()}))).status).toBe(503);
      expect(coach.quota().used).toBe(2); expect(coach.quota().remaining).toBe(1); expect(coach.quota().reserved).toBe(0);
      const r = req({...p, requestId: crypto.randomUUID()}); const aborted = new AbortController(); aborted.abort();
      expect((await coach.fetch(new Request(r, {signal: aborted.signal}))).status).toBe(409);
      expect((await coach.fetch(req({...p, requestId: crypto.randomUUID()}))).status).toBe(200);
      expect(coach.quota().low).toBe(true);
      expect((await coach.fetch(req({...p, requestId: crypto.randomUUID()}))).status).toBe(429);
      expect(new Coach(state.storage, {...config, COACH_MONTHLY_LIMIT: '3'}, 'device', () => true).quota().used).toBe(3);
    });
  });
  it('実行期限で提供元を中断し、タイマーを後始末して回数を返す', async () => {
    await runInDurableObject(await fixture(), async (_instance, state) => {
      const clear = vi.spyOn(globalThis, 'clearTimeout');
      const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        const abort = () => reject(new DOMException('', 'AbortError'));
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, {once: true});
      }));
      const c = new Coach(state.storage, {...config, COACH_PROVIDER: 'openai-compatible', COACH_API_KEY: 'test', COACH_TIMEOUT_MS: '20'}, 'device', () => true);
      try {
        expect((await c.fetch(req(await payload('device')))).status).toBe(504);
        expect(clear).toHaveBeenCalled();
        expect(c.quota().used).toBe(0); expect(c.quota().reserved).toBe(0);
      } finally { transport.mockRestore(); clear.mockRestore(); }
    });
  });
  it('事実生成の想定外例外も箇所と型だけを記録し、回数を消費しない', async () => {
    await runInDurableObject(await fixture(), async (_instance, state) => {
      const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
      const c = new Coach(state.storage, config, 'device', () => true, async () => {throw new TypeError('private-facts');});
      try {
        expect((await c.fetch(req(await payload('device')))).status).toBe(502);
        expect(JSON.parse(logs.mock.calls[0][0])).toEqual({event: 'coach_failed', error: 'provider_failed', stage: 'load_facts', errorType: 'TypeError', elapsedMs: expect.any(Number)});
        expect(JSON.stringify(logs.mock.calls)).not.toContain('private-facts');
        expect(c.quota().used).toBe(0); expect(c.quota().reserved).toBe(0);
      } finally { logs.mockRestore(); }
    });
  });
  it('提供元の実行中に中止し、遅延結果を捨てる。別要求の同時実行も拒否', async () => {
    const stub = await fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const c = new Coach(state.storage, {...config, COACH_PROVIDER: 'openai-compatible', COACH_API_KEY: 'secret', COACH_BASE_URL: 'https://provider.test', COACH_MODEL: 'model'}, 'device', () => true);
      let release!: () => void; let called!: () => void;
      const gate = new Promise<void>(r => {release = r;}); const entered = new Promise<void>(r => {called = r;});
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {called(); await gate; return Response.json({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(safe)}}]});});
      try {
        const p = await payload('device'); const running = c.fetch(req(p)); await entered;
        expect(c.quota().reserved).toBe(1);
        expect((await c.fetch(req({...p, requestId: crypto.randomUUID()}))).status).toBe(409);
        await c.fetch(new Request('https://device/v1/coach/' + p.requestId, {method: 'DELETE'}));
        release(); expect((await running).status).toBe(409);
        expect(c.quota().used).toBe(0); expect(c.quota().reserved).toBe(0);
      } finally {release(); spy.mockRestore();}
    });
  });
  it('タイムアウトは課金せず、月またぎの成功は受理月だけに数える', async () => {
    const stub = await fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const e = {...config, COACH_PROVIDER: 'openai-compatible', COACH_API_KEY: 'secret', COACH_BASE_URL: 'https://provider.test', COACH_MODEL: 'model'};
      let now = Date.parse('2026-11-30T14:59:59.999Z');
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {now += 2; return Response.json({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(safe)}}]});});
      try {
        const c = new Coach(state.storage, e, 'device', () => true);
        const p = await payload('device', now);
        expect((await c.fetch(req(p))).status).toBe(200);
        expect(c.quota(now).used).toBe(0); expect(c.quota(now - 2).used).toBe(1);
        spy.mockImplementation(async () => {now += 250000; return Response.json({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(safe)}}]});});
        expect((await c.fetch(req(await payload('device', now)))).status).toBe(504);
        expect(c.quota().used).toBe(0); expect(c.quota().reserved).toBe(0);
        // 不正出力も成功とみなさない。
        spy.mockImplementation(async () => Response.json({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({sections: [{...safe.sections[0], text: '7g7g'}]})}}]}));
        expect((await c.fetch(req(await payload('device', now)))).status).toBe(502);
        expect(c.quota().used).toBe(0);
      } finally {spy.mockRestore(); clock.mockRestore();}
    });
  });
  it('本文受信中・生成中の権利失効を再確認する', async () => {
    const stub = await fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      let paid = true;
      const c = new Coach(state.storage, config, 'device', () => paid);
      const p = await payload('device'); let release!: () => void;
      const stream = new ReadableStream({start(controller) {release = () => {paid = false; controller.enqueue(new TextEncoder().encode(JSON.stringify(p))); controller.close();};}});
      const r = c.fetch(new Request('https://device/v1/coach', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: stream}));
      release(); expect((await r).status).toBe(403); expect(c.quota().used).toBe(0);
      paid = true;
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {paid = false; return Response.json({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(safe)}}]});});
      try {
        const live = new Coach(state.storage, {...config, COACH_PROVIDER: 'openai-compatible', COACH_API_KEY: 'secret', COACH_BASE_URL: 'https://provider.test', COACH_MODEL: 'model'}, 'device', () => paid);
        expect((await live.fetch(req(p))).status).toBe(403); expect(c.quota().used).toBe(0);
      } finally {spy.mockRestore();}
    });
  });
  it('本文の実サイズを制限し、メディア型と期限切れ署名を拒否する', async () => {
    const stub = await fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const c = new Coach(state.storage, config, 'device', () => true);
      expect((await c.fetch(new Request('https://device/v1/coach', {method: 'POST', body: '{}'}))).status).toBe(415);
      expect((await c.fetch(req('x'.repeat(1_048_576)))).status).toBe(413);
      expect((await c.fetch(req(await payload('device', Date.now() - PROOF_LIFETIME)))).status).toBe(400);
      expect(c.quota().used).toBe(0);
    });
  });
  it('JST月境界でリセットし、期限切れ予約は再生成後も失敗扱いで返却', async () => {
    const before = Date.parse('2026-11-30T14:59:59.999Z'), after = before + 1;
    expect(monthStart(before)).not.toBe(monthStart(after)); expect(nextMonth(before)).toBe(after);
    const stub = await fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const c = new Coach(state.storage, config, 'device', () => true);
      state.storage.sql.exec('INSERT INTO coach_usage VALUES (?,100)', monthStart(before));
      state.storage.sql.exec("INSERT INTO coach_requests VALUES ('pending',?,'pending',?)", monthStart(before), before + 45000);
      expect(c.quota(before).remaining).toBe(0); expect(c.quota(after).remaining).toBe(100);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(after);
      try {
        expect((await c.fetch(req(await payload('device', after)))).status).toBe(409);
        expect(c.quota(after).used).toBe(0);
      } finally {clock.mockRestore();}
      state.storage.sql.exec("INSERT INTO coach_requests VALUES ('expired',?,'pending',?)", monthStart(Date.now()), Date.now() - 1);
      await c.fetch(new Request('https://device/v1/coach'));
      expect(state.storage.sql.exec("SELECT status FROM coach_requests WHERE id='expired'").one().status).toBe('failed');
    });
  });
});
