import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import configuration from '../wrangler.jsonc?raw';
import worker, { type Env } from '../src/index';
import { complete } from '../src/coach';
import { sha256 } from '../src/model';

const config = JSON.parse(configuration), production = config.env.production;
it('productionは専用Worker・ドメイン・DO・有限Container枠を持ち、stagingと同じTerra道具方式を使う', () => {
  expect(production.name).not.toBe(config.env.staging.name);
  expect(production.workers_dev).toBe(false); expect(production.preview_urls).toBe(false);
  expect(production.routes).toEqual([{pattern: 'kifumate-api.quarterlambda.com', custom_domain: true}]);
  expect(production.vars).toMatchObject({ENVIRONMENT: 'production', ALLOW_DEV_PAID: 'false'});
  for (const vars of [production.vars, config.env.staging.vars]) {
    expect(vars).toMatchObject({COACH_PROVIDER: 'openai-responses-tools', COACH_BASE_URL: 'https://api.openai.com/v1',
      COACH_MODEL: 'gpt-6.1-terra', COACH_REASONING_EFFORT: 'high', COACH_MAX_TOKENS: '5400', COACH_TIMEOUT_MS: '240000'});
    expect(vars).not.toHaveProperty('COACH_API_KEY');
  }
  expect(production.vars).not.toHaveProperty('DEV_PAID_HASHES');
  expect(production.vars).not.toHaveProperty('COACH_SIGNING_KEY');
  expect(production.durable_objects.bindings.map((x: any) => x.class_name).sort()).toEqual(['Device', 'Invitations', 'PreciseContainer', 'RealtimeContainer', 'StandardContainer']);
  expect(production.containers.map((x: any) => x.max_instances)).toEqual([2, 2, 2]);
  expect(config.migrations.at(-1)).toEqual({tag: 'v3', new_sqlite_classes: ['Invitations']});
  expect(new Set([...production.ratelimits, ...config.env.staging.ratelimits].map((x: any) => x.namespace_id)).size).toBe(8);
  expect(production.observability.logs.invocation_logs).toBe(false);
});
it('誤って開発用secretとフラグを入れてもproductionでは有料にならず内部ヘッダーも偽装できない', async () => {
  const bindings = env as unknown as Env;
  const issued = await worker.fetch(new Request('https://api/v1/devices', {method: 'POST'}), bindings);
  const {token} = await issued.json() as {token: string};
  const hash = await sha256(token);
  const response = await worker.fetch(new Request('https://api/v1/entitlements', {headers: {Authorization: 'Bearer ' + token, 'X-Dev-Paid': '1', 'X-Device-Hash': hash}}), {
    ...bindings, ENVIRONMENT: 'production', ALLOW_DEV_PAID: 'true', DEV_PAID_HASHES: hash,
  });
  expect(await response.json()).toEqual({paid: false, source: null, expiresAt: null});
});
it('productionはブラウザの直接接続・プリフライトを処理せず、CORSヘッダーも返さない', async () => {
  for (const [method, origin] of [['POST', 'https://example.com'], ['GET', 'null'], ['OPTIONS', '']]) {
    const response = await worker.fetch(new Request('https://api/v1/devices', {method, ...(origin ? {headers: {Origin: origin}} : {})}), {...env, ENVIRONMENT: 'production'} as Env);
    expect(response.status).toBe(403);
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
  }
});
it('productionで偽提供元が指定されても送信や偽応答をしない', async () => {
  const transport = vi.fn();
  await expect(complete({ENVIRONMENT: 'production', COACH_PROVIDER: 'fake'}, {} as any, [], new AbortController().signal, transport)).rejects.toThrow('provider_unavailable');
  expect(transport).not.toHaveBeenCalled();
});

it('productionでも有効な招待は使え、期限・取消が開発フラグと独立して反映される', async () => {
  const bindings = env as unknown as Env, token = await sha256(crypto.randomUUID()), hash = await sha256(token);
  const registry = bindings.INVITATIONS.getByName('registry');
  const codeHash = await sha256(crypto.randomUUID());
  await registry.create(codeHash, 1, null); await registry.redeem(hash, codeHash);
  await bindings.DEVICES.getByName(hash).fetch('https://device/register?hash=' + hash, {method: 'POST'});
  const request = () => new Request('https://api/v1/entitlements', {headers: {Authorization: 'Bearer ' + token}});
  const configuration = {...bindings, ENVIRONMENT: 'production', ALLOW_DEV_PAID: 'false'};
  expect((await (await worker.fetch(request(), configuration)).json() as any).paid).toBe(true);
  await registry.revoke(codeHash);
  expect((await (await worker.fetch(request(), configuration)).json() as any).paid).toBe(false);
});
