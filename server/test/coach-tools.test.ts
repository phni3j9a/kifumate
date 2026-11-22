import { prices } from './coach-provider-fixtures';
import {env} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {describe, expect, it, vi} from 'vitest';
import {Coach, complete, parseCoach, references, signAnalysis, validateOutput, type CoachEnv} from '../src/coach';
import type {CoachFacts} from '../src/coach-facts';
import type {RunTools} from '../src/coach-tools';
import type {Device} from '../src/index';

const config: CoachEnv = {ENVIRONMENT: 'staging', COACH_PRICES_USD_PER_MILLION: prices, COACH_PROVIDER: 'openai-responses-tools', COACH_API_KEY: 'test-key', COACH_SIGNING_KEY: 'signature'};
const analysis = {initial: 'startpos', mode: 'precise' as const, moves: ['7g7f'],
  results: [0, 1].map(ply => ({ply, score: null, candidates: [], mate: null}))};
const payload = {requestId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', analysis, perspective: 'sente',
  profile: {practice: ['四間飛車'], goal: '終盤を練習する'}, style: {focus: '総合', detail: 'ふつう'}, question: '一手目はどう見る？',
  history: [{role: 'assistant', content: '参考文 7g7f'}]};
const facts = (): CoachFacts => ({視点: 'あなたが先手、相手が後手', 実戦手: [[1, '▲7六歩(77)', '判定なし', '不明', '前進']],
  終局: {勝敗: '不明'}, 参照: [{id: '0:position'}], 要所: [{手数: 1, 実戦手: {表記: '▲7六歩(77)'}, 実戦の続き: ['省略する詳細'], 指す前の参照: '0:position'}]});
const refs = references(analysis.results);
const safe = {sections: [{kind: 'facts', title: '序盤', text: '先に玉の位置を確認しましょう。', refs: ['0:position']}]};
const usage = {input_tokens: 1000, output_tokens: 100, input_tokens_details: {cached_tokens: 100, cache_write_tokens: 200}};
const done = (value = safe) => Response.json({status: 'completed', output: [message(value)], usage});
const message = (value: unknown, phase = 'final_answer') => ({type: 'message', role: 'assistant', phase, content: [{type: 'output_text', text: JSON.stringify(value)}]});
const call = (id: string, name = 'knowledge', args = '{"query":"入玉"}') => ({type: 'function_call', call_id: id, name, arguments: args});
const reason = (id: string) => ({type: 'reasoning', id, summary: [], encrypted_content: `encrypted-${id}`});
const turn = (...output: unknown[]) => Response.json({status: 'completed', output, usage});
const bodyOf = (init?: RequestInit) => JSON.parse(init!.body as string);
const completeWith = (transport: typeof fetch, runTools: RunTools, signal?: AbortSignal, evidence = facts(), env = config) =>
  complete(env, parseCoach(payload), refs, signal ?? new AbortController().signal, transport, evidence, runTools);
const device = () => (env as unknown as {DEVICES: DurableObjectNamespace<Device>}).DEVICES.getByName(crypto.randomUUID());
const url = 'https://device/v1/coach';
async function post(id = 'device', prefer?: string) {
  const {results, ...input} = analysis;
  const proof = await signAnalysis('signature', id, 'job', input, results);
  return new Request(url, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Dev-Paid': '1', ...(prefer ? {Prefer: prefer} : {})},
    body: JSON.stringify({...payload, proof})});
}

describe('Responsesの道具ループ', () => {
  it('複数ターンを再生し、同一ターンの道具を一括で実行し下書きはWorkerで点検する', async () => {
    const evidence = facts();
    const r1 = reason('rs_1'), r2 = reason('rs_2');
    const commentary = message('確認中', 'commentary');
    const board = call('p', 'position', '{"position":{"ply":1}}');
    const draft = {sections: [{...safe.sections[0], text: 'あなたの玉が9三にいます。', refs: ['1:position']}]};
    const verify = call('draft', 'check_draft', JSON.stringify({draft: JSON.stringify(draft)}));
    const bad = call('bad', 'position', 'not-json');
    const knowledge = call('k');
    const run = vi.fn<RunTools>().mockResolvedValueOnce([{'本譜の参照': '1:position', 盤面: {あなた: {玉: '5九', 盤上: {}, 持駒: {}}}}, {知識: []}])
      .mockResolvedValueOnce([{エラー: '不明な道具です'}]);
    const requests: any[] = [];
    const transport: typeof fetch = async (url, init) => {
      expect(String(url)).toBe('https://api.openai.com/v1/responses');
      expect(init!.redirect).toBe('manual');
      expect(new Headers(init!.headers).get('Authorization')).toBe('Bearer test-key');
      const b = bodyOf(init);
      requests.push(b);
      expect(b).toMatchObject({store: false, include: ['reasoning.encrypted_content'], reasoning: {effort: 'high'}, model: 'gpt-6.1-terra', max_output_tokens: 4200});
      expect(b).not.toHaveProperty('previous_response_id');
      expect(b.tools).toHaveLength(18);
      expect(b.tools).toContainEqual(expect.objectContaining({name: 'book', parameters: {
        type: 'object', properties: {}, required: [], additionalProperties: false,
      }}));
      if (requests.length === 1) {
        expect(b.input.map((i: {role: string}) => i.role)).toEqual(['system', 'user']);
        const first = JSON.parse(b.input[1].content);
        expect(first).toMatchObject({視点: evidence.視点, 終局: evidence.終局, 対局手数: 1, 要所: [{手数: 1, 実戦手: '▲7六歩(77)'}],
          profile: payload.profile, style: payload.style, question: payload.question, history: [{role: 'assistant', content: '参考文 （指し手は参照で確認）'}]});
        expect(b.input[1].content).not.toMatch(/実戦の続き|省略する詳細|盤面|7g7f/);
        return turn(r1, commentary, verify, board, bad, knowledge);
      }
      expect(b.input.slice(2, 8)).toEqual([r1, commentary, verify, board, bad, knowledge]);
      const outputs = b.input.filter((i: any) => i.type === 'function_call_output');
      expect(outputs.slice(0, 4).map((i: any) => i.call_id)).toEqual(['draft', 'p', 'bad', 'k']);
      expect(JSON.parse(outputs[0].output)).toEqual({accepted: false, issues: [{section: 0, field: 'text', code: 'contradicts'}]});
      expect(JSON.parse(outputs[2].output)).toHaveProperty('エラー');
      if (requests.length === 2) return turn(r2, call('next', 'unknown_tool'));
      expect(b.input.slice(-3, -1)).toEqual([r2, call('next', 'unknown_tool')]);
      expect(JSON.parse(outputs.at(-1).output)).toEqual({エラー: '不明な道具です'});
      return turn(message('途中経過', 'commentary'), message({...safe, claims: []}));
    };
    const value = await completeWith(transport, run, undefined, evidence);
    expect(validateOutput(value, refs, evidence).sections[0].references).toEqual([refs[0]]);
    expect(run.mock.calls.map(([calls]) => calls.map(c => c.name))).toEqual([['position', 'knowledge'], ['unknown_tool']]);
  });

  it('複数呼び出しで30回を超えたら実行せず、未実行IDにも応答して道具なしで最終回答を得る', async () => {
    let turns = 0;
    const run = vi.fn<RunTools>().mockImplementation(async calls => calls.map(() => ({知識: []})));
    const out = await completeWith(async (_, init) => {
      const b = bodyOf(init);
      turns++;
      if (turns <= 2) {
        expect(b.tool_choice).toBe('auto');
        return turn(...Array.from({length: 16}, (_, i) => call(`${turns}-${i}`)));
      }
      expect(b.tool_choice).toBe('none');
      expect(b.max_output_tokens).toBe(5400);
      expect(b.input.at(-1).content).toContain('最終のJSON回答');
      const outputs = b.input.filter((i: any) => i.type === 'function_call_output');
      expect(outputs).toHaveLength(32);
      expect(JSON.parse(outputs[30].output).エラー).toContain('調査上限');
      expect(outputs[31].call_id).toBe('2-15');
      return done();
    }, run);
    expect(out).toEqual(safe);
    expect(turns).toBe(3);
    expect(run.mock.calls.map(([calls]) => calls.length)).toEqual([16, 14]);
  });

  it('未完了ターンの推論・途中の道具を全部破棄し、完全な履歴から最終回答を一度だけ求める', async () => {
    let attempts = 0;
    const run = vi.fn<RunTools>().mockResolvedValue([{知識: []}]);
    const ok = [reason('complete'), call('good')];
    const result = await completeWith(async (_, init) => {
      const b = bodyOf(init);
      if (++attempts === 1) return turn(...ok);
      if (attempts === 2) return Response.json({status: 'incomplete', incomplete_details: {reason: 'max_output_tokens'}, output: [reason('discard'), message('途中'), call('partial')], usage});
      expect(b.tool_choice).toBe('none');
      expect(b.input.slice(2, -2)).toEqual(ok);
      expect(b.input.at(-2)).toMatchObject({type: 'function_call_output', call_id: 'good'});
      return done();
    }, run);
    expect(result).toEqual(safe);
    expect(attempts).toBe(3);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('累積出力枠が迫ると最終回答用の5400トークンを残して調査を止める', async () => {
    let attempts = 0;
    const run = vi.fn<RunTools>().mockResolvedValue([{知識: []}]);
    await expect(completeWith(async (_, init) => {
      const b = bodyOf(init);
      if (++attempts <= 4) return Response.json({status: 'completed', output: [call('out' + attempts)], usage: {input_tokens: 3000, output_tokens: 4200}});
      expect(b.tool_choice).toBe('none');
      expect(b.max_output_tokens).toBe(5400);
      return done();
    }, run)).resolves.toEqual(safe);
    expect(attempts).toBe(5);
  });

  it('同じ履歴の入力の再送も累積枠に算入し、最終回答を残す', async () => {
    let attempts = 0;
    const run = vi.fn<RunTools>().mockResolvedValue([{資料: 'あ'.repeat(7800)}]);
    await expect(completeWith(async (_, init) => {
      const b = bodyOf(init);
      if (++attempts <= 3) return Response.json({status: 'completed', output: [call('in' + attempts)], usage: {input_tokens: Buffer.byteLength(init!.body as string) + 4096 + (attempts - 1) * 300, output_tokens: 300}});
      expect(b.tool_choice).toBe('none');
      return done();
    }, run)).resolves.toEqual(safe);
    expect(attempts).toBe(4);
  });

  it('初回の入力枠を超える参考履歴は古いものだけ省き、質問と新しい履歴を残す', async () => {
    const history = Array.from({length: 20}, (_, i) => ({role: 'user', content: String(i) + 'あ'.repeat(4000 - String(i).length)}));
    const run = vi.fn<RunTools>();
    const send = vi.fn<typeof fetch>().mockImplementation(async (_, init) => {
      const b = bodyOf(init), user = JSON.parse(b.input[1].content);
      expect(b.input[1].role).toBe('user');
      expect(b.tool_choice).toBe('none');
      expect(user.question).toBe(payload.question);
      expect(user.history.length).toBeGreaterThan(0);
      expect(user.history.length).toBeLessThan(20);
      expect(user.history).toEqual(history.slice(-user.history.length));
      return done();
    });
    await expect(complete(config, parseCoach({...payload, history}), refs, new AbortController().signal, send, facts(), run)).resolves.toEqual(safe);
    expect(send).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('出力上限32768でも初回は調査し、最終ターンだけ残りの出力枠まで使える', async () => {
    const run = vi.fn<RunTools>().mockResolvedValue([{知識: []}]);
    let attempts = 0;
    await expect(completeWith(async (_, init) => {
      const b = bodyOf(init);
      if (++attempts === 1) {
        expect(b.tool_choice).toBe('auto');
        return Response.json({status: 'completed', output: [call('first')], usage: {input_tokens: 1000, output_tokens: 100}});
      }
      if (attempts === 2) return Response.json({status: 'incomplete', incomplete_details: {reason: 'max_output_tokens'}, usage: {input_tokens: 2000, output_tokens: 4200}});
      expect(b.tool_choice).toBe('none');
      expect(b.max_output_tokens).toBe(24_000 - 4200 - 100);
      return done();
    }, run, undefined, facts(), {...config, COACH_MAX_TOKENS: '32768'})).resolves.toEqual(safe);
    expect(attempts).toBe(3);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('提供元異常・拒否・応答サイズ上限を拒否し、ログに本文・引数・鍵を出さない', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (const [response, code] of [
        [new Response('private-body', {status: 429}), 'provider_failed'],
        [new Response(null, {status: 302, headers: {Location: 'https://another.example'}}), 'provider_failed'],
        [new Response('x'.repeat(2_097_153)), 'invalid_output'],
        [turn({type: 'message', content: [{type: 'refusal', refusal: 'private-refusal'}]}), 'invalid_output'],
        [turn(call('same'), call('same')), 'invalid_output'],
        [Response.json({status: 'completed', output: [message(safe)]}), 'invalid_usage'],
      ] as const) await expect(completeWith(async () => response, vi.fn())).rejects.toThrow(code);
      expect(logs).toHaveBeenCalledTimes(6);
      expect(JSON.parse(logs.mock.calls[0][0])).toMatchObject({event: 'coach_responses_tools', stage: 'provider_http', status: 429, failure: 'provider_failed', calls: 0, turns: 1});
      expect(JSON.stringify(logs.mock.calls)).not.toMatch(/private-|test-key|四間飛車|入玉/);
    } finally { logs.mockRestore(); }
  });

  it('参照不合格は診断を返して道具なしで一度だけ修正し、正しい参照の回答を検査する', async () => {
    const bad = {sections: [{...safe.sections[0], refs: ['0:line:missing']}]};
    const first = message(bad);
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(turn(first)).mockImplementationOnce(async (_, init) => {
      const b = bodyOf(init);
      expect(b.tool_choice).toBe('none');
      expect(b.input.at(-2)).toEqual(first);
      expect(b.input.at(-1).content).toContain('"code":"invalid_reference"');
      return done();
    });
    const run = vi.fn<RunTools>();
    await expect(completeWith(send, run)).resolves.toEqual(safe);
    expect(send).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });

  it('修正しても符号が不合格なら一度で打ち切る', async () => {
    const bad = {sections: [{...safe.sections[0], text: '▲1六歩と指しました。'}]};
    const send = vi.fn<typeof fetch>().mockImplementation(async () => done(bad));
    await expect(completeWith(send, vi.fn())).rejects.toThrow('invalid_output');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('最終回答後に出力枠が5,400トークン未満なら修正を送らない', async () => {
    let turns = 0;
    const send: typeof fetch = async (_, init) => {
      const b = bodyOf(init);
      if (++turns <= 4) return Response.json({status: 'completed', output: [call('pre' + turns)], usage: {input_tokens: 3000, output_tokens: 4200}});
      expect(b.tool_choice).toBe('none');
      return Response.json({status: 'completed', output: [message({sections: []})], usage: {input_tokens: 3000, output_tokens: 5400}});
    };
    await expect(completeWith(send, async () => [{知識: []}])).rejects.toThrow('invalid_output');
    expect(turns).toBe(5);
  });

  it('組み込みfetchをレシーバーなしで呼ぶ（WorkersのIllegal invocation対策）', async () => {
    const transport = vi.fn(function (this: unknown) {
      if (this !== undefined) throw new TypeError('Illegal invocation');
      return Promise.resolve(turn(call('p')));
    }) as unknown as typeof fetch;
    await expect(completeWith(transport, async () => [])).rejects.toThrow('provider_failed');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transport).mock.results[0].type).toBe('return');
  });

  it('精密コンテナの応答が欠けたら、追加の提供元ターンは実行しない', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(turn(call('p')));
    await expect(completeWith(transport, async () => [])).rejects.toThrow('provider_failed');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('期限間近では道具を呼ばない最終ターンに切り替える', async () => {
    const run = vi.fn<RunTools>();
    const send: typeof fetch = async (_, init) => {
      expect(bodyOf(init).tool_choice).toBe('none');
      return done();
    };
    await expect(complete(config, parseCoach(payload), refs, new AbortController().signal, send, facts(), run, Date.now() + 10_000))
      .resolves.toEqual(safe);
    expect(run).not.toHaveBeenCalled();
  });

  it('読み取り中の中止で応答ストリームを解放し、追加ターンを送らない', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({pull() { reading(); }, cancel})));
    const result = completeWith(transport, vi.fn(), controller.signal);
    await started;
    controller.abort();
    await expect(result).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('仮の読み筋は符号照合に利用するが、公開参照は署名済みの形を維持する', async () => {
    const evidence = facts();
    const line = {id: '0:line:abc', 手数: 0, '仮の読み筋（実戦とは別）': [{表記: '▲2六歩(27)', 移動: '前進'}]};
    const wanted = {sections: [{...safe.sections[0], text: '仮に▲2六歩と指す手もあります。'}]};
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(turn(call('line', 'play_line', '{"position":{"ply":0},"moves":["▲2六歩"]}'))).mockResolvedValueOnce(done(wanted));
    const value = await completeWith(transport, async () => [{参照: line}], undefined, evidence);
    expect(validateOutput(value, refs, evidence).sections[0].references).toEqual([refs[0]]);
    expect(validateOutput({sections: [{...wanted.sections[0], refs: [line.id, refs[0].id]}]}, refs, evidence).sections[0].references).toEqual([refs[0]]);
    expect(validateOutput({sections: [{...wanted.sections[0], refs: Array(11).fill(line.id)}]}, refs, evidence).sections[0].references).toEqual([refs[0]]);
    expect(() => validateOutput({sections: [{...wanted.sections[0], refs: ['0:line:fake']}]}, refs, evidence)).toThrow('invalid_output');
  });

  it('仮の符号は起点局面または対応候補のある節に限る', async () => {
    const evidence = facts();
    const wanted = {sections: [{...safe.sections[0], text: '仮に▲2六歩と指す手もあります。'}]};
    const pv = '仮の読み筋（実戦とは別）';
    const line = {id: '0:line:abc', 手数: 0, [pv]: [{表記: '▲2六歩(27)'}, {表記: '△8四歩(83)'}]};
    const matching = {id: '0:candidate:1', [pv]: [{表記: '▲2六歩(27)'}]};
    const unrelated = {id: '0:candidate:2', [pv]: [{表記: '▲5六歩(57)'}]};
    const deepPosition = {id: '0:deep:position'};
    evidence.参照.push(matching, unrelated, deepPosition);
    const signed = [...refs, ...[matching, unrelated, deepPosition].map(r => ({...refs[0], id: r.id}))];
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(turn(call('line', 'play_line', '{"position":{"ply":0},"moves":["▲2六歩","△8四歩"]}'))).mockResolvedValueOnce(done(wanted));
    await completeWith(send, async () => [{参照: line}], undefined, evidence);
    const quote = (id: string) => ({sections: [{...wanted.sections[0], text: '仮の応手は△8四歩です。', refs: [id]}]});
    expect(() => validateOutput(quote('1:position'), signed, evidence)).toThrow('invalid_output');
    expect(() => validateOutput(quote(unrelated.id), signed, evidence)).toThrow('invalid_output');
    expect(() => validateOutput(quote(matching.id), signed, evidence)).not.toThrow();
    expect(() => validateOutput(quote('0:position'), signed, evidence)).not.toThrow();
    expect(validateOutput(quote(deepPosition.id), signed, evidence).sections[0].references.map(r => r.id)).toEqual([deepPosition.id]);
  });

  it('本の手と手筋は各起点の facts でだけ使え、資料外の符号は拒否する', async () => {
    const evidence = facts();
    const section = (text: string, id: string) => ({sections: [{...safe.sections[0], text, refs: [id]}]});
    const wanted = section('本では▲2六歩や▲5六歩が候補です。', '0:position');
    const result = {状態: '一致あり',
      最初に外れた手: {手数: 1, 参照: '0:position', 実戦手: '▲7六歩(77)', 本の手: [
        {表記: '▲2六歩(27)', 移動: '前進'}, {表記: '▲5六歩(57)', 移動: '前進'},
      ]},
      手筋: [{手数: 1, 参照: '1:position', 正解: {表記: '△3四歩(33)', 移動: '前進'}, 別解: [{表記: '△8四歩(83)', 移動: '前進'}]}]};
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(turn(call('b', 'book', '{}'))).mockResolvedValueOnce(done(wanted));
    await expect(completeWith(send, async () => [result], undefined, evidence)).resolves.toEqual(wanted);
    expect(validateOutput(wanted, refs, evidence).sections[0].references).toEqual([refs[0]]);
    expect(() => validateOutput(section('別解は△8四歩です。', '1:position'), refs, evidence)).not.toThrow();
    expect(() => validateOutput(section('別解は△8四歩です。', '0:position'), refs, evidence)).toThrow();
    expect(() => validateOutput(section('定跡では△8四歩です。', '1:position'), refs, evidence)).not.toThrow();
    expect(() => validateOutput(section('定跡では△8四歩です。', '0:position'), refs, evidence)).toThrow();
    expect(() => validateOutput(section('手筋の正解は△3四歩です。', '1:position'), refs, evidence)).not.toThrow();
    expect(() => validateOutput(section('手筋の正解は△3四歩です。', '0:position'), refs, evidence)).toThrow('invalid_output');
    expect(() => validateOutput(section('本では▲2六歩が候補です。', '1:position'), refs, evidence)).toThrow('invalid_output');
    expect(() => validateOutput(section('本では▲9六歩が候補です。', '0:position'), refs, evidence)).toThrow('invalid_output');
  });

  it('bookの本の手や手筋が既知の移動方向の矛盾を隠さない', async () => {
    const moves = ['2g2f', '3c3d', '7g7f'];
    const game = {...analysis, moves, results: [...analysis.results, ...[2, 3].map(ply => ({...analysis.results[0], ply}))]};
    const signed = references(game.results);
    const evidence = {...facts(), 実戦手: ['▲2六歩(27)', '△3四歩(33)', '▲7六歩(77)'].map((表記, i): CoachFacts['実戦手'][number] =>
      [i + 1, 表記, '判定なし', '不明', '前進'])};
    const bad = ['▲7六歩と引きます。', '実戦では▲7六歩と引いた手が敗着でした。',
      'ここで▲7六歩と引いたと分かります。', '▲7六歩と引いた歩'];
    const section = (text: string) => ({sections: [{...safe.sections[0], text}]});
    for (const text of bad) expect(() => validateOutput(section(text), signed, evidence), text).toThrow('invalid_output');

    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(turn(call('b', 'book', '{}'))).mockResolvedValueOnce(done());
    const pawn = {表記: '▲7六歩(77)', 移動: '前進'};
    const runTools = async () => [{状態: '一致あり', 最初に外れた手: {手数: 1, 参照: '0:position', 本の手: [pawn]},
      手筋: [{手数: 0, 参照: '0:position', 正解: pawn}]}];
    await complete(config, parseCoach({...payload, analysis: game}), signed, new AbortController().signal, send, evidence, runTools);
    expect(evidence.仮の手順?.map(line => !!line.定跡)).toEqual([true, false]);
    for (const text of bad) expect(() => validateOutput(section(text), signed, evidence), text).toThrow('invalid_output');
    expect(() => validateOutput(section('▲7六歩と前進します。'), signed, evidence)).not.toThrow();
    expect(() => validateOutput(section('▲7六歩と引いた金の手を比較します。'), signed, evidence)).not.toThrow();
    expect(() => validateOutput(section('▲7六歩と引いたと金の手を比較します。'), signed, evidence)).not.toThrow();
  });

  it('反転手筋の符号と別の駒を比較しても方向の矛盾としない', async () => {
    const evidence = facts();
    const section = (text: string) => ({sections: [{...safe.sections[0], text}]});
    const wanted = section('△8五桂と後退する銀の手を比較します。');
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(turn(call('b', 'book', '{}'))).mockResolvedValueOnce(done(wanted));
    const book = async () => [{状態: '一致あり', 手筋: [{手数: 0, 参照: '0:position', 先後反転: true,
      正解: {表記: '△8五桂(73)', 移動: '前進'}}]}];
    await expect(completeWith(send, book, undefined, evidence)).resolves.toEqual(wanted);
    expect(() => validateOutput(section('△8五桂と引いた手を比較します。'), refs, evidence)).toThrow('invalid_output');
    expect(() => validateOutput(section('△8五桂と後退します。'), refs, evidence)).toThrow('invalid_output');
  });

  it('mateが証明した手順を起点局面で照合し、公開mate参照は増やさない', async () => {
    const evidence = facts();
    const wanted = {sections: [{...safe.sections[0], text: '▲7一飛打が詰みの手です。'}]};
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(turn(call('m', 'mate', '{"position":{"ply":0}}'))).mockResolvedValueOnce(done(wanted));
    const value = await completeWith(send, async () => [{状態: '詰みを証明', 手順: ['▲7一飛打']}], undefined, evidence);
    expect(validateOutput(value, refs, evidence).sections[0].references).toEqual([refs[0]]);
    expect(() => validateOutput({sections: [{...wanted.sections[0], refs: ['0:mate']}]}, refs, evidence)).toThrow('invalid_output');
  });
});

describe('非同期・期限・精密コンテナ', () => {
  it('実Device経由で同じ精密slotを使い、alarmの成功だけを計上する', async () => {
    const stub = device();
    await stub.fetch('https://device/register?hash=' + 'a'.repeat(64), {method: 'POST'});
    await runInDurableObject(stub, async (instance: any) => {
      Object.assign(instance.env, config);
      const container = vi.fn(async (path: string, init: RequestInit) => {
        const body = bodyOf(init);
        expect(init.signal).toBeInstanceOf(AbortSignal);
        if (path.endsWith('/coach-facts')) {
          expect(body.tags).toMatchObject({対局側: {先手: {大分類: '未分類'}}});
          return Response.json(facts());
        }
        expect(path).toBe('http://container/coach-tools');
        expect(body.calls).toEqual([{name: 'book', arguments: '{}'}]);
        expect(body.game).toMatchObject({initial: analysis.initial, moves: analysis.moves, question: payload.question, tags: {対局側: {先手: {大分類: '未分類'}}}});
        expect(JSON.stringify(body)).not.toMatch(/test-key|四間飛車|参考文/);
        return Response.json({results: [{状態: '一致なし'}]});
      });
      const getByName = vi.fn(() => ({fetch: container}));
      instance.env.PRECISE = {getByName};
      const send = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(turn(call('book', 'book', '{}')))
        .mockResolvedValueOnce(Response.json({status: 'incomplete', incomplete_details: {reason: 'max_output_tokens'}, usage}))
        .mockResolvedValueOnce(done());
      try {
        expect((await instance.fetch(await post(instance.ctx.id.toString(), 'respond-async'))).status).toBe(202);
        expect(send).not.toHaveBeenCalled();
        expect(instance.coach.quota().remainingRatio).toBe(1);
        await instance.alarm(); await instance.alarm();
        const current = await instance.fetch(new Request(url + '/' + payload.requestId, {headers: {'X-Dev-Paid': '1'}}));
        expect(await current.json()).toMatchObject({status: 'completed', sections: [{references: [refs[0]]}], quota: {remainingRatio: (500_000_000 - 5_115_000) / 500_000_000}});
        const slot = 'slot-' + parseInt(instance.ctx.id.toString().slice(0, 8), 16) % 2;
        expect(getByName.mock.calls).toEqual([[slot], [slot]]);
        expect(container).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenCalledTimes(3);
      } finally { send.mockRestore(); }
    });
  });

  it.each(['DELETE', 'deadline'] as const)('%sで応答しない道具通信を打ち切り、枠から差し引かない', async mode => {
    await runInDurableObject(device(), async (_instance, state) => {
      let entered!: () => void;
      const toolStarted = new Promise<void>(resolve => { entered = resolve; });
      const run = vi.fn((_input, _calls, signal: AbortSignal) => new Promise<unknown[]>(resolve => {
        // Containerがsignalを無視してもループはここで待ち続けない。
        signal.addEventListener('abort', () => { setTimeout(() => resolve([]), 1); }, {once: true});
        entered();
      }));
      const c = new Coach(state.storage, {...config, COACH_TIMEOUT_MS: mode === 'deadline' ? '250' : '20000'}, 'device', () => true,
        async () => facts(), undefined, run);
      const send = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(turn(call('p')));
      try {
        const generation = c.fetch(await post());
        if (mode === 'DELETE') {
          await toolStarted;
          expect((await c.fetch(new Request(url + '/' + payload.requestId, {method: 'DELETE'}))).status).toBe(200);
        }
        expect((await generation).status).toBe(mode === 'DELETE' ? 409 : 504);
        expect(c.quota()).toMatchObject({remainingRatio: 1, exhausted: false});
        expect(send).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0][2].aborted).toBe(true);
      } finally { send.mockRestore(); }
    });
  });

  it('最終出力を既存検査で拒否し、枠から差し引かない', async () => {
    await runInDurableObject(device(), async (_instance, state) => {
      const coach = new Coach(state.storage, config, 'device', () => true, async () => facts(), undefined, async () => []);
      const send = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => done({sections: [{...safe.sections[0], refs: ['0:line:fake']}]}));
      try {
        const out = await coach.fetch(await post());
        expect(out.status, await out.clone().text()).toBe(502);
        expect(await out.json()).toMatchObject({error: 'invalid_output', quota: {remainingRatio: 1, exhausted: false}});
      } finally { send.mockRestore(); }
    });
  });
});
