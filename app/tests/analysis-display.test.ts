import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Color, Move, Record as ShogiRecord } from "tsshogi";
import {
  analysisInput,
  candidateRows,
  cp,
  pointsFor,
  readingText,
  scoreText,
  startPly,
} from "../src/analysis/display";
import { readKif } from "../src/core/kif";
import type { AnalysisResult, Score } from "../src/analysis/types";
const sample = JSON.parse(
  readFileSync("../mock/data/sample-game-2.json", "utf8"),
);
function record() {
  const r = new ShogiRecord();
  for (const p of sample.positions.slice(1)) {
    const m = r.position.createMoveByUSI(p.move.usi);
    assert(m);
    r.append(m);
  }
  return r;
}
const result = (ply: number, value: number): AnalysisResult => ({
  ply,
  score: { kind: "cp", value },
  candidates: [],
  mate: null,
});
test("API入力に名前を含めず、開始局面と本譜だけ（現在の手数を変えない）", () => {
  const r = readKif(readFileSync("tests/fixtures/standard.kif", "utf8"));
  r.goto(2);
  const i = analysisInput(r, "precise");
  assert.deepEqual(Object.keys(i), ["initial", "moves", "mode"]);
  assert.equal(i.moves.length, 5);
  assert.equal(r.current.ply, 2);
  assert.equal(i.initial, r.initialPosition.sfen);
});
test("先手評価を自分の側へ変換し、探索のmateスコアを詰み確定とはしない", () => {
  const score: Score = { kind: "mate", value: null, winner: "gote" };
  assert.equal(cp(score), -3000);
  assert.equal(scoreText(score, Color.BLACK), "−3000以上");
  assert.equal(scoreText(score, Color.WHITE), "+3000以上");
  assert.equal(scoreText(null, Color.BLACK), "—");
  const r = record();
  const points = pointsFor(r, [{ ...result(0, 0), score }], Color.BLACK);
  assert.equal(points[0]?.mate, false);
  assert.equal(points[1]?.value, null);
});
test("候補3手・本譜、証明の詰みだけのタブ、読み筋の日本語、入玉宣言を通常手と区別", () => {
  const r = record();
  r.goto(92);
  const p = sample.positions[92];
  const analysis: AnalysisResult = {
    ...result(92, 3000),
    score: { kind: "mate", value: 3, winner: "sente" },
    candidates: p.cands.map((c: any, i: number) => ({
      rank: i + 1,
      depth: 10,
      move: c.usi,
      pv: c.pvUsi,
      score: { kind: "cp", value: c.cp },
    })),
    mate: { plies: 3, pv: p.tsume.line.map((m: any) => m.usi), branches: [] },
  };
  const rows = candidateRows(
    r.position,
    analysis,
    r.moves[93]?.move as Move,
    Color.WHITE,
    true,
  );
  assert.equal(rows[0]?.label, "詰み");
  assert.equal(rows[0]?.mate, 3);
  assert(readingText(r.position, rows[0]!.pv).join(" ").includes("銀"));
  const unproven = candidateRows(
    r.position,
    { ...analysis, mate: null },
    undefined,
    Color.WHITE,
    true,
  );
  assert(unproven.every((r) => !r.mate && r.label !== "詰み"));
  const declaration = candidateRows(
    r.position,
    {
      ...result(92, 0),
      candidates: [
        {
          rank: 1,
          depth: 10,
          declarationWin: true,
          pv: [],
          score: { kind: "declaration", value: null, winner: "sente" },
        },
      ],
    },
    undefined,
    Color.BLACK,
    false,
  );
  assert.equal(declaration[0]?.text, "入玉宣言");
  assert.equal(declaration[0]?.move, null);
});
test("悪手は指した側の勝率低下で判定し、初めて開くと自分の最初の悪手へ", () => {
  const r = record();
  const results = sample.positions.map((p: any) =>
    result(p.ply, p.ply >= 36 ? 1000 : p.ply >= 33 ? -1000 : 0),
  );
  const points = pointsFor(r, results, Color.WHITE);
  assert.equal(points[33]?.mark, "悪手");
  assert.equal(points[33]?.self, false);
  assert.equal(points[36]?.mark, "悪手");
  assert.equal(points[36]?.self, true);
  assert.equal(startPly(points), 36);
  const noSelf = pointsFor(r, results, Color.BLACK);
  assert.equal(startPly(noSelf), 33);
  assert.equal(startPly(pointsFor(r, [], Color.BLACK)), 0);
});
