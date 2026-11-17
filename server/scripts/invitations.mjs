#!/usr/bin/env node
// コード・管理鍵を標準出力、引数、例外本文に出さない。
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export function codeHash(code) { return createHash('sha256').update(code).digest('hex'); }
export async function privateRead(path) {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077)) throw new Error('秘密ファイルは所有者だけが読める権限（0600）にしてください');
  return (await readFile(path, 'utf8')).trim();
}
export async function main(args = process.argv.slice(2)) {
  const {values, positionals} = parseArgs({args, allowPositionals: true, options: {
    env: {type: 'string'}, 'key-file': {type: 'string'}, out: {type: 'string'},
    'max-devices': {type: 'string'}, 'expires-at': {type: 'string'}, hash: {type: 'string'},
  }});
  const environment = values.env;
  if (!['staging', 'production'].includes(environment) || !['issue', 'revoke'].includes(positionals[0]) || positionals.length !== 1) throw new Error('issue|revoke と --env staging|production が必要です');
  const key = await privateRead(values['key-file'] ?? `.local/invite-admin-${environment}.key`);
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('管理鍵の形式が不正です');
  const url = environment === 'staging' ? 'https://kifumate-analysis-staging.yuki-nakano-1020.workers.dev' : 'https://kifumate-api.quarterlambda.com';
  let hash = values.hash, body;
  if (positionals[0] === 'issue') {
    const maxDevices = Number(values['max-devices']);
    const expiresAt = values['expires-at'] ? Date.parse(values['expires-at']) : null;
    if (!values.out || !Number.isSafeInteger(maxDevices) || maxDevices < 1 || maxDevices > 100 || (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()))) throw new Error('--out と --max-devices 1〜100、将来の --expires-at（任意）が必要です');
    if (!resolve(values.out).startsWith(resolve('.local') + sep)) throw new Error('コードの保存先はgit管理外の .local/ 配下にしてください');
    const code = randomBytes(32).toString('hex');
    hash = codeHash(code);
    await mkdir(dirname(values.out), {recursive: true, mode: 0o700});
    // 通信断でも取り消せるよう、送信前にハッシュを保存する。既存ファイルは上書きしない。
    body = {hash, maxDevices, expiresAt};
    await writeFile(values.out + '.json', JSON.stringify(body) + '\n', {mode: 0o600, flag: 'wx'});
    await writeFile(values.out, code + '\n', {mode: 0o600, flag: 'wx'});
  }
  if (!/^[a-f0-9]{64}$/.test(hash ?? '')) throw new Error('取り消すコードの --hash が必要です（コード原文ではありません）');
  const response = await fetch(url + '/admin/invitations' + (body ? '' : '/' + hash), {
    method: body ? 'POST' : 'DELETE', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  if (!response.ok) throw new Error(`管理APIが失敗しました（HTTP ${response.status}）。応答消失時は保存済みハッシュで取り消してください`);
  console.log(body ? `発行しました。コードは ${values.out}、取り消し用ハッシュは ${values.out}.json（安全な経路で配布してください）` : '取り消しました');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('処理に失敗しました。引数・秘密ファイルの権限・管理鍵・HTTP接続を確認してください。発行途中のファイルがあればハッシュで取り消してください'); process.exitCode = 1; });
}
