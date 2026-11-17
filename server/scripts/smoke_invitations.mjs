#!/usr/bin/env node
// staging専用。コードと端末トークンは表示せず、コンテナを起動しない。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { main, privateRead } from './invitations.mjs';

const url = 'https://kifumate-analysis-staging.yuki-nakano-1020.workers.dev';
const out = `.local/invite-smoke-${Date.now()}.txt`;
async function request(path, token, method = 'GET', body) {
  const response = await fetch(url + path, {method, redirect: 'error', signal: AbortSignal.timeout(30_000), headers: {
    'User-Agent': 'kifumate-invite-smoke', 'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {}),
  }, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  return {status: response.status, body: await response.json()};
}
let hash, token;
try {
  await main(['issue', '--env', 'staging', '--max-devices', '1', '--expires-at', new Date(Date.now() + 3600_000).toISOString(), '--out', out]);
  hash = JSON.parse(await readFile(out + '.json', 'utf8')).hash;
  const code = await privateRead(out);
  const first = await request('/v1/devices', undefined, 'POST');
  const second = await request('/v1/devices', undefined, 'POST');
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  token = first.body.token;
  assert.equal((await request('/v1/entitlements', token)).body.paid, false);
  const normalizedInput = code.toLowerCase().replaceAll('0', 'o').replaceAll('1', 'l')
    .replace(/[!-~]/g, char => String.fromCharCode(char.charCodeAt(0) + 0xfee0));
  const redeemed = await request('/v1/invitations/redeem', token, 'POST', {code: `　${normalizedInput}　`});
  assert.equal(redeemed.status, 200); assert.equal(redeemed.body.source, 'invite');
  assert.equal((await request('/v1/quota', token)).body.paid, true);
  const full = await request('/v1/invitations/redeem', second.body.token, 'POST', {code});
  assert.equal(full.status, 409); assert.equal(full.body.error, 'invite_full');
} finally {
  // 発行途中の失敗・応答消失でも、保存済みハッシュを使って取り消す。
  hash ??= await readFile(out + '.json', 'utf8').then(text => JSON.parse(text).hash).catch(() => undefined);
  if (hash) await main(['revoke', '--env', 'staging', '--hash', hash]);
}
assert.equal((await request('/v1/entitlements', token)).body.paid, false);
assert.equal((await request('/v1/quota', token)).body.paid, false);
console.log('staging: 招待入力の正規化・端末上限・取消反映を確認');

// 公式bindingは近似値。閾値ぴったりではなく、有界の連続呼び出しで拒否を確かめる。
let rejected = false;
for (let i = 0; i < 10; i++) {
  const result = await request('/v1/invitations/redeem', token, 'POST', {code: 'bad'});
  if (result.status === 429) { rejected = true; break; }
  assert.equal(result.status, 400);
}
assert.ok(rejected);
console.log('staging: 招待入力の公式レート制限を確認。窓が戻るまで65秒待機');
await new Promise(resolve => setTimeout(resolve, 65_000));
let strict = false;
for (let i = 0; i < 5; i++) {
  const result = await request('/v1/invitations/redeem', token, 'POST', {code: 'bad'});
  if (result.body.error === 'invite_rate_limited') { strict = true; break; }
  assert.equal(result.status, 400);
}
assert.ok(strict);
console.log('staging: 公式bindingの窓を越えてもDOの15分制限が残ることを確認');
let apiRejected = false;
for (let i = 0; i < 800 && !apiRejected; i++) {
  const result = await request('/v1/quota', token);
  assert.ok(result.status === 200 || result.status === 429);
  apiRejected = result.status === 429 && result.body.error === 'rate_limited';
  // 同期される前の短い並列バーストだけでは、近似カウンターの拒否を観測できない。
  await new Promise(resolve => setTimeout(resolve, 35));
}
assert.ok(apiRejected);
let registrationRejected = false;
for (let i = 0; i < 40; i++) {
  const result = await request('/v1/devices', undefined, 'POST');
  if (result.status === 429) { registrationRejected = true; break; }
  assert.equal(result.status, 201);
}
assert.ok(registrationRejected);
console.log('staging: 端末APIの連続取得・IP単位の端末発行制限を確認。確認コードは取消済み、解析の起動なし');
