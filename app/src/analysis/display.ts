import { moveText } from "../core/format";
import type { Branch } from "../core/kif";
import {
  Color,
  formatMove,
  Move,
  Position,
  type ImmutablePosition,
  type Record as ShogiRecord,
} from "tsshogi";
import type { RealtimeInput } from "./realtime-types";
import type { AnalysisResult, Input, Mode, Score } from "./types";
export const cp = (s?: Score | null): number | null =>
  !s ? null : s.kind === "cp" ? s.value : s.winner === "gote" ? -3000 : 3000;
export const winRate = (value: number) => 100 / (1 + Math.exp(-value / 600));
export const percent = (value: number) =>
  Math.max(1, Math.min(99, Math.round(winRate(value))));
export const signed = (n: number) =>
  n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "±0";
export function scoreText(s: Score | null | undefined, self: Color) {
  const value = cp(s);
  if (value === null) return "—";
  const v = (self === Color.BLACK ? 1 : -1) * value;
  return Math.abs(v) >= 3000 ? `${v < 0 ? "−" : "+"}3000以上` : signed(v);
}
export function analysisInput(record: ShogiRecord, mode: Mode): Input {
  return {
    initial: record.initialPosition.sfen,
    moves: record.moves
      .filter((n) => n.move instanceof Move)
      .map((n) => (n.move as Move).usi),
    mode,
  };
}
export function realtimeInput(
  record: ShogiRecord,
  ply: number,
  branch: Branch | null,
): RealtimeInput {
  const main = record.moves
    .filter((n) => n.move instanceof Move)
    .slice(0, branch?.base ?? ply);
  const variation = branch?.moves.slice(0, branch.at) ?? [];
  // shortcut: 512手より前の履歴は送らないため千日手を判定できない。長手数の千日手が問題になったらサーバーの上限か送り方を見直す
  const skip = Math.max(0, main.length + variation.length - 512);
  return {
    initial:
      (skip > main.length
        ? branch?.positions[skip - main.length]?.sfen
        : main[skip - 1]?.sfen) ?? record.initialPosition.sfen,
    moves: [
      ...main.slice(skip).map((n) => (n.move as Move).usi),
      ...variation.slice(Math.max(0, skip - main.length)).map((m) => m.usi),
    ],
  };
}
export type Mark = "悪手" | "疑問手" | "好手" | "詰み逃し";
export interface Point {
  value: number | null;
  mark?: Mark;
  mate: boolean;
  self: boolean;
}
/** モックの勝率低下（20/10ポイント）と候補差による印。序盤30手は印を付けない。 */
export function pointsFor(
  record: ShogiRecord,
  results: AnalysisResult[],
  self: Color,
): Point[] {
  const by = new Map(results.map((r) => [r.ply, r]));
  const moves = record.moves
    .filter((n) => n.move instanceof Move)
    .map((n) => n.move as Move);
  const pos = new Position();
  pos.resetBySFEN(record.initialPosition.sfen);
  const points: Point[] = [];
  let previousChecked = false;
  const good: { i: number; gap: number; color: Color }[] = [];
  for (let i = 0; i <= moves.length; i++) {
    const r = by.get(i),
      prev = by.get(i - 1),
      before = cp(prev?.score),
      after = cp(r?.score);
    const mover = i ? moves[i - 1]!.color : pos.color;
    const point: Point = {
      value: after,
      mate: !!r?.mate,
      self: (r?.mate ? pos.color : mover) === self,
    };
    if (i > 30 && prev && r && before !== null && after !== null) {
      const sign = mover === Color.BLACK ? 1 : -1;
      const best = prev.candidates[0],
        isBest = best?.move === moves[i - 1]!.usi;
      const drop = winRate(sign * before) - winRate(sign * after);
      if (!isBest && drop >= 20) point.mark = "悪手";
      else if (!isBest && drop >= 10) point.mark = "疑問手";
      const second = cp(prev.candidates[1]?.score);
      if (
        isBest &&
        second !== null &&
        before * sign - second * sign >= 250 &&
        before * sign >= -1000 &&
        before * sign < 2000 &&
        prev.score?.kind === "cp" &&
        !moves[i - 1]!.capturedPieceType
      ) {
        if (
          !previousChecked &&
          !(i > 1 && moves[i - 2]!.to.equals(moves[i - 1]!.to))
        )
          good.push({ i, gap: before * sign - second * sign, color: mover });
      }
      if (prev.mate && prev.mate.pv[0] !== moves[i - 1]!.usi)
        point.mark = "詰み逃し";
    }
    points.push(point);
    if (i < moves.length) {
      previousChecked = pos.checked;
      pos.doMove(moves[i]!);
    }
  }
  good.sort((a, b) => b.gap - a.gap);
  const chosen = new Set<number>();
  for (const color of [Color.BLACK, Color.WHITE]) {
    const g = good.find((g) => g.color === color);
    if (g) chosen.add(g.i);
  }
  for (const g of good) {
    if (chosen.size >= 3) break;
    chosen.add(g.i);
  }
  chosen.forEach((i) => {
    if (!points[i]!.mark) points[i]!.mark = "好手";
  });
  return points;
}
export function startPly(points: Point[]) {
  let i = points.findIndex((p, i) => i > 30 && p.mark === "悪手" && p.self);
  if (i < 0) i = points.findIndex((p, i) => i > 30 && p.mark === "悪手");
  return Math.max(0, i);
}
export function phaseRanges(record: ShogiRecord) {
  const moves = record.moves
      .filter((n) => n.move instanceof Move)
      .map((n) => n.move as Move),
    n = moves.length;
  const capture = moves.findIndex((m) => m.capturedPieceType);
  const opening = Math.min(n, Math.max(1, capture < 0 ? n : capture));
  const pos = new Position();
  pos.resetBySFEN(record.initialPosition.sfen);
  let consecutive = 0,
    end = n + 1;
  moves.forEach((m, i) => {
    pos.doMove(m);
    if (i + 1 < opening + 8) return;
    const major = pos.board
      .listNonEmptySquares()
      .some((sq) => ["dragon", "horse"].includes(pos.board.at(sq)!.type));
    consecutive = major ? consecutive + 1 : 0;
    if (consecutive >= 4 && end > n) end = i - 2;
  });
  if (opening >= n) return [{ name: "序盤", a: 0, b: n }];
  return [
    { name: "序盤", a: 0, b: opening },
    { name: "中盤", a: opening + 1, b: Math.min(n, end - 1) },
    ...(end <= n ? [{ name: "終盤", a: end, b: n }] : []),
  ];
}

export interface CandidateRow {
  label: string;
  text: string;
  pv: string[];
  reading?: string[];
  move: Move | null;
  score: Score | null;
  mate?: number;
  game: boolean;
}
export function candidateRows(
  position: ImmutablePosition,
  result: AnalysisResult | undefined,
  next: Move | undefined,
  self: Color,
  own: boolean,
): CandidateRow[] {
  if (!result) return [];
  const candidates = result.candidates.map((c) => ({
    ...c,
    mate:
      result.mate && result.mate.pv[0] === c.move
        ? result.mate.plies
        : undefined,
    pv: result.mate && result.mate.pv[0] === c.move ? result.mate.pv : c.pv,
  }));
  if (result.mate && !candidates.some((c) => c.move === result.mate!.pv[0]))
    candidates.unshift({
      rank: 1,
      depth: 0,
      score: result.score,
      move: result.mate.pv[0],
      pv: result.mate.pv,
      mate: result.mate.plies,
    });
  const rows: CandidateRow[] = [];
  candidates.forEach((c) => {
    const move = c.move ? position.createMoveByUSI(c.move) : null;
    if (move && !position.isValidMove(move)) return;
    if (!move && !c.declarationWin) return;
    const game = !!move && !!next?.equals(move);
    const label = c.mate
      ? "詰み"
      : c.rank === 1
        ? !own
          ? "最善"
          : position.color === self
            ? "おすすめ"
            : "相手の最善"
        : `${c.rank}位`;
    rows.push({
      label,
      text: move ? moveText(formatMove(position, move)) : "入玉宣言",
      pv: c.pv,
      move: move || null,
      score: c.score,
      mate: c.mate,
      game,
    });
  });
  if (next && !rows.some((r) => r.game))
    rows.push({
      label: "本譜",
      text: moveText(formatMove(position, next)),
      move: next,
      pv: [next.usi],
      score: null,
      game: true,
    });
  return rows;
}
export function readingText(position: ImmutablePosition, pv: string[]) {
  const p = new Position();
  p.resetBySFEN(position.sfen);
  const words: string[] = [];
  let last: Move | undefined;
  for (const usi of pv) {
    const m = p.createMoveByUSI(usi);
    if (!m || !p.isValidMove(m)) break;
    words.push(moveText(formatMove(p, m, { lastMove: last })));
    p.doMove(m);
    last = m;
  }
  return words;
}
