// モデル固有の設定。依頼の検証や送信の共通処理には置かない。既定モデルはここから選ばない。
// gpt-6.1-terra は 2026-11-20 に公式資料で確認した。
// https://developers.openai.com/api/docs/models/gpt-6.1-terra
// https://developers.openai.com/api/docs/pricing
// 下の料金は標準・272K入力以下。それを超えると入力とキャッシュは2倍、出力は1.5倍。12時間のキャッシュ書込は $2.50 / 1M。
// Chat Completions に対応し、reasoning_effort は none / low / medium / high / xhigh / max。ツール呼び出しは Responses が必要だが、このサーバーは使わない。

export interface ModelProfile {
  id: string;
  /** Chat Completions の出力上限フィールド。 */
  tokenParameter: 'max_completion_tokens';
  /** 公式が受理する値のうち、このサーバーが送る推論量。 */
  reasoningEffort: 'max';
  /** 公式の最大出力トークン。COACH_MAX_TOKENS の上限に使う。 */
  maxOutputTokens: number;
  /** 100万トークンあたりUSD。 */
  pricePerMillion: {input: number; cachedInput: number; output: number; cacheWrite30m: number};
}

export const MODEL_PROFILES: Record<string, ModelProfile> = {
  'gpt-6.1-terra': {
    id: 'gpt-6.1-terra',
    tokenParameter: 'max_completion_tokens',
    reasoningEffort: 'max',
    maxOutputTokens: 128_000,
    pricePerMillion: {input: 1, cachedInput: 0.05, output: 5, cacheWrite30m: 1.25},
  },
};

export function modelProfile(model: string | undefined): ModelProfile | undefined {
  return model ? MODEL_PROFILES[model] : undefined;
}
