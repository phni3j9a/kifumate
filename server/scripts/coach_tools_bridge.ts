// ローカル比較専用: 本番照合・アプリ分類を重複実装しない。
import {readFileSync} from 'node:fs';
import {rememberToolEvidence} from '../src/coach-facts';
import {inspectDraft, references} from '../src/coach';
import {coachTags} from '../src/coach-tools';

async function main() {
  const args = JSON.parse(readFileSync(0, 'utf8'));
  if (args.task === 'classify') return coachTags(args.initial, args.moves);
  for (const {name, args: input, result} of args.evidence ?? []) rememberToolEvidence(args.facts, name, input, result);
  return inspectDraft(args.draft, references(args.results), args.facts, args.task === 'revalidate');
}
main().then(result => process.stdout.write(JSON.stringify(result))).catch(() => { process.exitCode = 1; });
