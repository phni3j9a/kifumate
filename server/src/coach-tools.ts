import schema from '../container/coach_tools_schema.json';
import { ApiError } from './model';
import { classifyUsiAsync } from '../../app/src/core/classify';
import { rememberToolEvidence, type CoachFacts } from './coach-facts';

const tools = schema.map(tool => ({...tool, type: 'function', strict: false}));
const TOOL_LIMIT = 30;
const MAX_ARGS_BYTES = 16_000;
const MAX_RESULT_BYTES = 24_000;
const INPUT_BUDGET = 240_000;
const OUTPUT_BUDGET = 24_000;
const FINAL_RESERVE_TOKENS = 5_400;
const MAX_RESPONSE_BYTES = 2_097_152;
const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).byteLength;
const error = (message: string) => ({エラー: message});
export const RESPONSES_TOOLS = 'openai-responses-tools';
export interface ToolCall { name: string; arguments: string }
export type RunTools = (calls: ToolCall[], signal: AbortSignal) => Promise<unknown[]>;

// DOとコンテナをまたぐ通信や応答ストリームが中止に追従しなくても、待機を終える。
export async function abortable<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); });
  signal.addEventListener('abort', abort, {once: true});
  try { return await Promise.race([stopped, run()]); }
  finally { signal.removeEventListener('abort', abort); }
}

export async function readCoachResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError(502, 'invalid_output');
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    for (;;) {
      const {done, value} = await abortable(signal, () => reader.read());
      if (done) {
        try { return JSON.parse(text + decoder.decode()); }
        catch { throw new ApiError(502, 'invalid_output'); }
      }
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new ApiError(502, 'invalid_output');
      text += decoder.decode(value, {stream: true});
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export async function coachTags(initial: string, moves: string[]) {
  const start = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
  const c = await classifyUsiAsync(initial === 'startpos' ? start : initial, moves);
  const list = (xs: {name: string; ply: number}[]) => xs.map(x => ({名前: x.name, 確認手数: x.ply}));
  return {'居飛車・振り飛車の組合せ': list(c.relationships), 対局側: Object.fromEntries(Object.entries(c.sides).map(([key, side]) =>
    [key === 'black' ? '先手' : '後手', {大分類: side.family, 戦法: list(side.strategies), 囲い: list(side.castles)}]))};
}

function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export async function responsesWithTools(options: {
  url: string; key: string; model: string; effort: string; maxTokens: number; deadline: number; reserveMs: number;
  prompt: string; userContext: {history: unknown[]; [field: string]: unknown}; facts: CoachFacts; signal: AbortSignal;
  transport: typeof fetch; runTools: RunTools; inspect: (draft: string, facts: CoachFacts) => unknown;
}): Promise<unknown> {
  const {signal, facts} = options;
  const prior = [...options.userContext.history];
  const initialHistory = () => [{role: 'system', content: options.prompt},
    {role: 'user', content: JSON.stringify({...options.userContext, history: prior})}];
  let history: unknown[] = initialHistory();
  const seen = new Set<string>();
  const started = Date.now();
  let turns = 0, calls = 0, stage = 'provider_fetch', status: number | undefined, failure: string | undefined;
  let force = false, inputUsed = 0, outputUsed = 0, replayTokens = 0;
  const finalReserve = Math.min(options.maxTokens, FINAL_RESERVE_TOKENS);
  const researchTokens = Math.min(4200, options.maxTokens);
  const request = (items: unknown[], final: boolean) => JSON.stringify({model: options.model,
    input: final ? [...items, {role: 'user', content: '道具調査はここまでです。確認できた事実だけで最終のJSON回答を書いてください。'}] : items,
    store: false, include: ['reasoning.encrypted_content'], service_tier: 'default', reasoning: {effort: options.effort},
    max_output_tokens: final ? Math.min(options.maxTokens, OUTPUT_BUDGET - outputUsed) : researchTokens, text: {format: {type: 'json_object'}}, tools, tool_choice: final ? 'none' : 'auto'});
  // shortcut: UTF-8バイト数＋APIの整形余裕＋再生する応答トークンで安全側に予約。実測とずれる場合は提供元のカウントAPIを検討する。
  const inputEstimate = (body: string, replay: number) => bytes(body) + 4096 + replay;
  try {
    // 初回の最終回答すら収まらないときだけ、参考履歴の最古の項目を落とす。
    while (prior.length && inputEstimate(request(history, true), 0) > INPUT_BUDGET) {
      prior.shift();
      history = initialHistory();
    }
    for (;;) {
      signal.throwIfAborted();
      const remaining = options.deadline - Date.now();
      if (remaining <= 0) throw new ApiError(504, 'coach_timeout');
      const finalBody = request(history, true);
      const finalInput = inputEstimate(finalBody, replayTokens);
      const researchBody = request(history, false);
      const researchInput = inputEstimate(researchBody, replayTokens);
      const final = force || calls >= TOOL_LIMIT || remaining <= options.reserveMs ||
        inputUsed + researchInput + finalInput > INPUT_BUDGET || outputUsed + researchTokens + finalReserve > OUTPUT_BUDGET;
      const body = final ? finalBody : researchBody;
      const reservedInput = final ? finalInput : researchInput;
      const reservedOutput = final ? Math.min(options.maxTokens, OUTPUT_BUDGET - outputUsed) : researchTokens;
      stage = 'provider_fetch'; status = undefined;
      if (inputUsed + reservedInput > INPUT_BUDGET || outputUsed + reservedOutput > OUTPUT_BUDGET) throw new ApiError(502, 'provider_failed');
      turns++;
      const response = await abortable(signal, () => options.transport(options.url, {method: 'POST', signal, redirect: 'manual',
        headers: {'Authorization': `Bearer ${options.key}`, 'Content-Type': 'application/json'}, body}));
      stage = 'provider_http'; status = response.status;
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new ApiError(502, 'provider_failed');
      }
      stage = 'provider_read';
      const data = await readCoachResponse(response, signal);
      signal.throwIfAborted();
      if (Date.now() >= options.deadline) throw new ApiError(504, 'coach_timeout');
      stage = 'provider_output';
      if (!object(data)) throw new ApiError(502, 'invalid_output');
      const usage = (key: string, reserved: number): number => {
        const value = data.usage?.[key];
        if (!Number.isSafeInteger(value) || value < 0) return reserved;
        if (value > reserved) throw new ApiError(502, 'provider_failed');
        return value;
      };
      inputUsed += usage('input_tokens', reservedInput);
      const generated = usage('output_tokens', reservedOutput);
      outputUsed += generated;
      if (data.status === 'incomplete') {
        if (final || data.incomplete_details?.reason !== 'max_output_tokens') throw new ApiError(502, 'invalid_output');
        force = true;
        continue;
      }
      if (data.status !== 'completed') throw new ApiError(502, 'provider_failed');
      if (!Array.isArray(data.output) || !data.output.every(object)) throw new ApiError(502, 'invalid_output');
      const pending = data.output.filter(item => item.type === 'function_call');
      if (!pending.length) {
        const messages = data.output.filter(item => item.type === 'message');
        const content = (messages.filter(item => item.phase === 'final_answer').at(-1) ?? messages.at(-1))?.content;
        if (!Array.isArray(content) || !content.length || !content.every(part => object(part) && part.type === 'output_text' && typeof part.text === 'string')) {
          throw new ApiError(502, 'invalid_output');
        }
        try { return JSON.parse(content.map(part => part.text).join('')); }
        catch { throw new ApiError(502, 'invalid_output'); }
      }
      if (final) throw new ApiError(502, 'invalid_output');
      for (const item of pending) {
        if (typeof item.call_id !== 'string' || !item.call_id || seen.has(item.call_id)) throw new ApiError(502, 'invalid_output');
        seen.add(item.call_id);
      }
      // 暗号化推論を含むAPIの項目列を、そのまま元の順序で再送する。
      const nextHistory = [...history, ...data.output];
      // 予算に収まる完全な履歴と、その履歴で確認できた根拠だけを確定する。
      const nextFacts = {...facts, 参照: [...facts.参照], 仮の手順: [...(facts.仮の手順 ?? [])]};
      stage = 'tools';
      const batch: {index: number; call: ToolCall; args: Record<string, any>}[] = [];
      const results: unknown[] = [];
      for (const [index, item] of pending.entries()) {
        if (calls >= TOOL_LIMIT || options.deadline - Date.now() <= options.reserveMs) {
          results[index] = error('調査上限。既に確認した資料のみで回答してください');
          force = true;
          continue;
        }
        calls++;
        try {
          if (typeof item.name !== 'string' || typeof item.arguments !== 'string' || bytes(item.arguments) > MAX_ARGS_BYTES) throw new Error();
          const args: unknown = JSON.parse(item.arguments);
          if (!object(args)) throw new Error();
          if (item.name === 'check_draft') {
            if (typeof args.draft !== 'string' || Object.keys(args).length !== 1) throw new Error();
            continue;
          }
          batch.push({index, call: {name: item.name, arguments: item.arguments}, args});
        } catch { results[index] = error('道具の引数が不正です'); }
      }
      if (batch.length) {
        const values = await abortable(signal, () => options.runTools(batch.map(item => item.call), signal));
        if (!Array.isArray(values) || values.length !== batch.length) throw new ApiError(502, 'provider_failed');
        for (const [i, {index, call, args}] of batch.entries()) {
          const result = values[i];
          if (!object(result)) results[index] = error('道具を実行できませんでした');
          else if (bytes(JSON.stringify(result)) > MAX_RESULT_BYTES) results[index] = error('結果が大きすぎます。対象を絞って確認してください');
          else {
            results[index] = result;
            rememberToolEvidence(nextFacts, call.name, args, result);
          }
        }
      }
      signal.throwIfAborted();
      if (Date.now() >= options.deadline) throw new ApiError(504, 'coach_timeout');
      for (const [index, item] of pending.entries()) {
        // 下書き点検は同じターンの盤面照会が返した証拠も使う。
        const result = results[index] ?? options.inspect(JSON.parse(item.arguments).draft, nextFacts);
        nextHistory.push({type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(result)});
      }
      if (inputUsed + inputEstimate(request(nextHistory, true), replayTokens + generated) > INPUT_BUDGET) {
        force = true;
      } else {
        history = nextHistory;
        replayTokens += generated;
        Object.assign(facts, nextFacts);
      }
    }
  } catch (e) {
    failure = signal.aborted ? 'aborted' : e instanceof ApiError && ['provider_failed', 'invalid_output', 'coach_timeout'].includes(e.code) ? e.code : 'provider_failed';
    if (failure === 'aborted' || e instanceof ApiError && ['invalid_output', 'coach_timeout'].includes(e.code)) throw e;
    throw new ApiError(502, 'provider_failed');
  } finally {
    console.log(JSON.stringify({event: 'coach_responses_tools', stage, status, failure, turns, calls, inputTokens: inputUsed, outputTokens: outputUsed, elapsedMs: Date.now() - started}));
  }
}
