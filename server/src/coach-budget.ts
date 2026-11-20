import { ApiError } from './model';

export const RESPONSES_TOOLS = 'openai-responses-tools';
const COMPATIBLE = 'openai-compatible';
const NANO_USD = 1_000_000_000;

export function weeklyBudget(value = '0.5') {
  const budget = Math.round(Number(value) * NANO_USD);
  return Number.isSafeInteger(budget) && budget > 0 ? budget : NANO_USD / 2;
}

export function coachModel(env: {COACH_PROVIDER?: string; COACH_MODEL?: string}) {
  const provider = env.COACH_PROVIDER ?? COMPATIBLE;
  return {provider, model: env.COACH_MODEL ?? (provider === RESPONSES_TOOLS ? 'gpt-6.1-terra' : 'deepseek-flash')};
}

const categories = ['input', 'cacheRead', 'cacheWrite', 'output'] as const;
export function coachRates(env: Parameters<typeof coachModel>[0] & {ENVIRONMENT: string; COACH_PRICES_USD_PER_MILLION?: string}) {
  const {provider, model} = coachModel(env);
  if (provider === 'fake' && ['local', 'staging'].includes(env.ENVIRONMENT)) return null;
  if (provider === RESPONSES_TOOLS || provider === COMPATIBLE) {
    try {
      const price = JSON.parse(env.COACH_PRICES_USD_PER_MILLION ?? '{}')[`${provider}/${model}`];
      // 100万トークン当たりのUSDを、1トークン当たりの整数ナノドルへ変換する。
      const rates = categories.map(key => {
        const usd = price?.[key];
        const rate = Math.round(usd * 1000);
        if (typeof usd !== 'number' || usd < 0 || !Number.isSafeInteger(rate) || (usd > 0 && rate === 0)) throw new Error();
        return rate;
      });
      if (rates[0] > 0 && rates[3] > 0) return rates;
    } catch { /* 設定値やモデル名を応答やログに出さない */ }
  }
  throw new ApiError(503, 'provider_unavailable');
}

export function usageCost(usage: any, withTools: boolean, rates: number[]) {
  const tokens = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ApiError(502, 'invalid_usage');
    return value;
  };
  const input = tokens(withTools ? usage?.input_tokens : usage?.prompt_tokens);
  // どちらのAPIも出力合計に推論を含むので、推論の内訳を足さない。
  const output = tokens(withTools ? usage?.output_tokens : usage?.completion_tokens);
  const details = (withTools ? usage?.input_tokens_details : usage?.prompt_tokens_details) ?? {};
  const read = tokens((withTools ? details.cached_tokens : usage.prompt_cache_hit_tokens ?? details.cached_tokens) ?? 0);
  const written = details.cache_write_tokens_details;
  const write = tokens(details.cache_write_tokens ?? (
    tokens(written?.ttl_30m_tokens ?? details.cache_write_30m_tokens ?? 0) +
    tokens(written?.ttl_12h_tokens ?? details.cache_write_12h_tokens ?? 0)
  ));
  const uncached = input - read - write;
  const cost = uncached * rates[0] + read * rates[1] + write * rates[2] + output * rates[3];
  if (uncached < 0 || !Number.isSafeInteger(cost)) throw new ApiError(502, 'invalid_usage');
  return cost;
}
