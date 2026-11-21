type Score = {kind: 'cp'; value: number} | {kind: 'mate' | 'declaration'; winner: 'sente' | 'gote'};
export interface PositionResult {ply: number; score: Score | null; mate: unknown}

export function deepPositions(initial: string, results: PositionResult[]): number[] {
  const budget = Math.floor(results.length / 10);
  const cp = (s: Score) => s.kind === 'cp' ? s.value : s.winner === 'gote' ? -3000 : 3000;
  const winRate = (value: number) => 100 / (1 + Math.exp(-value / 600));
  const first = initial.split(' ')[1] === 'w' ? -1 : 1;
  const drops: {ply: number; drop: number}[] = [];
  for (let ply = 31; ply < results.length; ply++) {
    const before = results[ply - 1], after = results[ply];
    if (!before.score || !after.score || (before.mate && after.mate)) continue;
    const sign = ply % 2 === 1 ? first : -first;
    let x = sign * cp(before.score), y = sign * cp(after.score);
    // w(x)-w(y) = w(-y)-w(-x) なので、対称な組は同じ向きにそろえて同じ計算にする。
    if (x + y < 0) [x, y] = [-y, -x];
    const drop = winRate(x) - winRate(y);
    // 数学上同点の低下が浮動小数点の誤差だけで前後しないよう、比較用に丸める。
    if (drop > 0) drops.push({ply, drop: Math.round(drop * 1e10)});
  }
  drops.sort((a, b) => b.drop - a.drop || a.ply - b.ply);
  const chosen = new Set<number>();
  for (const {ply} of drops) {
    const pair = [ply - 1, ply].filter(n => !chosen.has(n));
    if (chosen.size + pair.length <= budget) pair.forEach(n => chosen.add(n));
    if (chosen.size === budget) break;
  }
  return [...chosen].sort((a, b) => a - b);
}
