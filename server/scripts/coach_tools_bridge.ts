// ローカル比較専用: 本番照合・アプリ分類を重複実装しない。
import {readFileSync} from 'node:fs';
import type {CoachFacts} from '../src/coach-facts';
import {inspectDraft, references} from '../src/coach';
import {coachTags} from '../src/coach-tools';

function inspect(draft: any, facts: CoachFacts, results: any[]) {
  const refs = references(results);
  for (const r of facts.参照) {
    if (!refs.some(ref => ref.id === r.id)) refs.push({id: r.id, ply: r.手数, score: null, pv: [], provenMate: false});
  }
  return inspectDraft(draft, refs, facts);
}

async function main() {
  const args = JSON.parse(readFileSync(0, 'utf8'));
  if (args.task === 'classify') return coachTags(args.initial, args.moves);
  return inspect(args.draft, args.facts, args.results);
}
main().then(result => process.stdout.write(JSON.stringify(result))).catch(() => { process.exitCode = 1; });
