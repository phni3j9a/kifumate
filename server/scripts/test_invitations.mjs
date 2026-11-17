import { createHash } from 'node:crypto';
import { generateInviteCode, normalizeInviteCode } from '../src/invite-code.mjs';
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
  const canonical = '01101234ABCDEFGH';
  const expectedHash = createHash('sha256').update(canonical).digest('hex');
  for (const code of ['OIL0-1234-ABCD-EFGH', 'oil0 1234 abcd efgh', 'ｏｉｌ０　－１２３４‐ａｂｃｄ \nｅｆｇｈ', canonical]) {
    assert.equal(codeHash(code), expectedHash);
  }
  for (let i = 0; i < 100; i++) {
    const code = generateInviteCode();
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    assert.equal(codeHash(code), createHash('sha256').update(normalizeInviteCode(code)).digest('hex'));
  }
  assert.throws(() => codeHash('abc'));
  assert.throws(() => codeHash('a'.repeat(64)));
  await assert.rejects(main(['issue', '--env', 'wrong']));
  await chmod(path, 0o600);
  await assert.rejects(main(['issue', '--env', 'staging', '--key-file', path, '--out', 'tracked-code.txt', '--max-devices', '1']));
  console.log('管理スクリプトのCrockford生成・正規化・ハッシュ・権限・保存先検査: 成功');
} finally { await rm(directory, {recursive: true, force: true}); }
