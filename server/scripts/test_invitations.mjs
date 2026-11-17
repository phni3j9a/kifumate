import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeHash, privateRead, main } from './invitations.mjs';

const directory = await mkdtemp(join(tmpdir(), 'kifumate-invites-'));
try {
  const path = join(directory, 'key');
  await writeFile(path, 'a'.repeat(64), {mode: 0o600});
  assert.equal(await privateRead(path), 'a'.repeat(64));
  await chmod(path, 0o644);
  await assert.rejects(privateRead(path));
  assert.equal(codeHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  await assert.rejects(main(['issue', '--env', 'wrong']));
  await chmod(path, 0o600);
  await assert.rejects(main(['issue', '--env', 'staging', '--key-file', path, '--out', 'tracked-code.txt', '--max-devices', '1']));
  console.log('管理スクリプトのハッシュ・権限・保存先検査: 成功');
} finally { await rm(directory, {recursive: true, force: true}); }
