const rates = {input: 1, cacheRead: 0.05, cacheWrite: 2.5, output: 5};
export const prices = JSON.stringify(Object.fromEntries([
  'openai-responses-tools/gpt-6.1-terra',
  ...['deepseek-flash', 'model', 'gpt-6-luna'].map(model => 'openai-compatible/' + model),
].map(key => [key, rates])));
export const chatUsage = {prompt_tokens: 1000, completion_tokens: 200,
  prompt_cache_hit_tokens: 400, completion_tokens_details: {reasoning_tokens: 150}};
