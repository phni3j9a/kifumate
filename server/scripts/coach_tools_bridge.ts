// ローカル比較専用: 本番照合・アプリ分類を重複実装しない。
import {readFileSync} from 'node:fs';
import {contradicts, hasFactReference, notationIssue, type CoachFacts} from '../src/coach-facts';
import {validateOutput, references} from '../src/coach';
import {classifyUsiAsync} from '../../app/src/core/classify';

function inspect(draft: any, facts: CoachFacts, results: any[]) {
  const refs = references(results);
  for (const r of facts.参照) {
    if (!refs.some(ref => ref.id === r.id)) refs.push({id: r.id, ply: r.手数, score: null, pv: [], provenMate: false});
  }
  const issues: {section?: number; field?: string; code: string}[] = [];
  const output = draft && typeof draft === 'object' && !Array.isArray(draft)
    ? Object.fromEntries(Object.entries(draft).filter(([key]) => key !== 'claims')) : draft;
  try { validateOutput(output, refs, facts); return {accepted: true, issues}; } catch { /* 以下は診断のみ */ }
  if (Array.isArray(output?.sections)) output.sections.forEach((s: any, section: number) => {
    try { validateOutput({sections: [s]}, refs, facts); return; } catch { /* 不合格の節だけを検査 */ }
    const count = issues.length;
    if (s && ['facts', 'advice'].includes(s.kind)) {
      for (const field of ['title', 'text']) {
        if (typeof s[field] !== 'string') continue;
        const issue = notationIssue(s[field], facts, s.kind);
        if (issue) issues.push({section, field, code: issue});
        if (Array.isArray(s.refs) && contradicts(s[field], s.refs, facts)) issues.push({section, field, code: 'contradicts'});
      }
      if (!Array.isArray(s.refs) || s.refs.some((r: unknown) => typeof r !== 'string' || !hasFactReference(r, facts))) issues.push({section, field: 'refs', code: 'invalid_reference'});
    }
    if (count === issues.length) issues.push({section, code: 'invalid_output'});
  });
  return {accepted: false, issues: issues.length ? issues : [{code: 'invalid_output'}]};
}

async function main() {
  const args = JSON.parse(readFileSync(0, 'utf8'));
  if (args.task === 'classify') {
    const c = await classifyUsiAsync(args.initial, args.moves);
    const list = (xs: {name: string; ply: number}[]) => xs.map(x => ({名前: x.name, 確認手数: x.ply}));
    return {'居飛車・振り飛車の組合せ': list(c.relationships), 対局側: Object.fromEntries(Object.entries(c.sides).map(([key, side]) =>
      [key === 'black' ? '先手' : '後手', {大分類: side.family, 戦法: list(side.strategies), 囲い: list(side.castles)}]))};
  }
  return inspect(args.draft, args.facts, args.results);
}
main().then(result => process.stdout.write(JSON.stringify(result))).catch(() => { process.exitCode = 1; });
