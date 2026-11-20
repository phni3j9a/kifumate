import { describe, expect, it } from 'vitest';
import { coachRates, usageCost } from '../src/coach-budget';
import { chatUsage, prices } from './coach-provider-fixtures';

const config = {ENVIRONMENT: 'production', COACH_PRICES_USD_PER_MILLION: prices};
const terra = coachRates({...config, COACH_PROVIDER: 'openai-responses-tools'})!;
const base = {input_tokens: 1000, output_tokens: 200, output_tokens_details: {reasoning_tokens: 150}};

describe('モデルごとの費用（ナノドル）', () => {
  it('入力内訳は重複させず、キャッシュ書込の内訳を12時間単価で数え、推論は出力合計の一部とする', () => {
    const cached = {cached_tokens: 400, cache_write_tokens_details: {ttl_30m_tokens: 50, ttl_12h_tokens: 50}};
    expect(usageCost({...base, input_tokens_details: cached}, true, terra)).toBe(1_770_000);
    expect(usageCost({...base, input_tokens_details: {...cached, cache_write_tokens: 100}}, true, terra)).toBe(1_770_000);
    expect(usageCost(base, true, terra)).toBe(2_000_000);
  });
  it('DeepSeekのprompt_cache_hit_tokensとOpenAI互換のキャッシュ内訳を扱う', () => {
    const rates = coachRates(config)!;
    expect(usageCost(chatUsage, false, rates)).toBe(1_620_000);
    const openAI = {...chatUsage, prompt_cache_hit_tokens: undefined, prompt_tokens_details: {cached_tokens: 400, cache_write_tokens: 100}};
    expect(usageCost(openAI, false, rates)).toBe(1_770_000);
  });
  it('usageが欠落・不正なら推測で差し引かない', () => {
    for (const invalid of [undefined, {...base, output_tokens: -1}, {...base, input_tokens_details: {cached_tokens: 1000, cache_write_tokens: 1}}]) {
      expect(() => usageCost(invalid, true, terra)).toThrow('invalid_usage');
    }
    expect(() => coachRates({...config, COACH_PRICES_USD_PER_MILLION: 'invalid'})).toThrow('provider_unavailable');
  });
});
