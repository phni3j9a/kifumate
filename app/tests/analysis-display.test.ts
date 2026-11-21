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
  turningPoints,
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
// 見本データの指し手（▲２四歩）を、画面の書き方（▲2四歩）にそろえる
const toHalf = (text: string) =>
  text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, "");
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

test("悪手・疑問手は同じ深さの組で判定し、グラフは局面単位で深読みを優先する", () => {
  const r = record();
  const prev = { ...result(32, 0), deep: result(32, 1000) };
  const current = { ...result(33, -1000), deep: result(33, 750) };
  const points = (a: AnalysisResult, b: AnalysisResult) =>
    pointsFor(r, [a, b], Color.BLACK)[33]!;
  assert.equal(points(prev, current).mark, undefined);
  assert.equal(points(prev, current).value, 750);
  assert.equal(points({ ...prev, deep: undefined }, current).mark, "悪手");
  assert.equal(points({ ...prev, deep: undefined }, current).value, 750);
  assert.equal(points(prev, { ...current, deep: undefined }).mark, "悪手");
  assert.equal(
    points(prev, { ...current, deep: result(33, 450) }).mark,
    "疑問手",
  );
  const best = {
    rank: 1,
    depth: 20,
    move: (r.moves[33]!.move as Move).usi,
    pv: [],
    score: null,
  };
  assert.equal(
    points(
      { ...prev, deep: { ...prev.deep, candidates: [best] } },
      { ...current, deep: result(33, -1000) },
    ).mark,
    undefined,
  );
});

test("深読みの証明済み詰みと好手も前後がそろったときだけ判定に使う", () => {
  const r = record();
  const ply = r.moves.findIndex(
    (n, i) =>
      i > 30 &&
      n.move instanceof Move &&
      n.move.color === Color.BLACK &&
      !n.move.capturedPieceType &&
      !n.move.to.equals((r.moves[i - 1]!.move as Move).to),
  );
  assert(ply > 30);
  const move = (r.moves[ply]!.move as Move).usi;
  const prev = result(ply - 1, 0),
    current = result(ply, 0);
  const pts = (deep: AnalysisResult) =>
    pointsFor(
      r,
      [
        { ...prev, deep },
        { ...current, deep: current },
      ],
      Color.BLACK,
    )[ply];
  const mate = { plies: 1 as const, pv: ["7g7f"], branches: [] };
  assert.notEqual(move, mate.pv[0]);
  assert.equal(pts({ ...prev, mate })?.mark, "詰み逃し");
  assert.equal(
    pointsFor(r, [{ ...prev, deep: { ...prev, mate } }, current], Color.BLACK)[
      ply
    ]?.mark,
    undefined,
  );
  const good = {
    ...prev,
    candidates: [
      { rank: 1, depth: 20, move, pv: [move], score: prev.score },
      {
        rank: 2,
        depth: 20,
        pv: [],
        score: { kind: "cp" as const, value: -400 },
      },
    ],
  };
  assert.equal(pts(good)?.mark, "好手");
  assert.equal(
    pointsFor(r, [{ ...prev, deep: good }, current], Color.BLACK)[ply]?.mark,
    undefined,
  );
});

test("勝負所は印の付いた手と前後とも深読みの手を手数順に並べ、どちらもなければ空", () => {
  const r = record();
  const results: AnalysisResult[] = sample.positions.map((p: any) =>
    result(p.ply, p.ply >= 36 ? 1000 : p.ply >= 33 ? -1000 : 0),
  );
  // 41手目は印なしで前後とも深読み、50手目は片側だけ深読み
  for (const ply of [40, 41, 50])
    results[ply] = { ...results[ply]!, deep: result(ply, 1000) };
  const list = turningPoints(
    r,
    results,
    pointsFor(r, results, Color.WHITE),
    Color.WHITE,
  );
  assert.deepEqual(
    list.map((t) => [t.ply, t.mark, t.self, t.before, t.after, !!t.deep]),
    [
      [33, "悪手", false, 50, 84, false],
      [36, "悪手", true, 84, 16, false],
      [41, undefined, false, 16, 16, true],
    ],
  );
  assert.equal(list[0]?.text, toHalf(sample.positions[33].move.ja));
  assert.deepEqual(
    turningPoints(r, [], pointsFor(r, [], Color.BLACK), Color.BLACK),
    [],
  );
  const unmarked = results.map((x) => result(x.ply, 0));
  assert.deepEqual(
    turningPoints(
      r,
      unmarked,
      pointsFor(r, unmarked, Color.BLACK),
      Color.BLACK,
    ),
    [],
  );
});

test("勝負所のおすすめは判定に使った段階から出し、深読みの評価と読み筋・逃した詰みを添える", () => {
  const r = record();
  const candidate = (ply: number, n: number, value: number) => {
    const c = sample.positions[ply].cands[n];
    return {
      rank: 1,
      depth: 20,
      move: c.usi as string,
      pv: c.pvUsi as string[],
      score: { kind: "cp" as const, value },
    };
  };
  const played = (ply: number) => sample.positions[ply].move.usi as string;
  const other = (ply: number) =>
    sample.positions[ply - 1].cands.findIndex(
      (c: any) => c.usi !== played(ply),
    );
  const results: AnalysisResult[] = sample.positions.map((p: any) =>
    result(p.ply, p.ply >= 36 ? 1000 : 0),
  );
  // 36手目：1段目のおすすめだけ。40手目：前後とも深読みで、深読みのおすすめ・評価・読み筋を出す
  const shallow = candidate(35, other(36), 0);
  results[35] = { ...results[35]!, candidates: [shallow] };
  const deep = candidate(39, other(40), 800);
  results[39] = {
    ...results[39]!,
    candidates: [candidate(39, 0, 1000)],
    deep: { ...result(39, 800), candidates: [deep] },
  };
  results[40] = { ...results[40]!, deep: result(40, 1000) };
  // 44手目：深読みで見つかった詰みを逃した
  const mate = {
    plies: 3 as const,
    pv: [sample.positions[43].cands[other(44)].usi as string],
    branches: [],
  };
  results[43] = { ...results[43]!, deep: { ...result(43, 1000), mate } };
  results[44] = { ...results[44]!, deep: result(44, 1000) };
  const list = turningPoints(
    r,
    results,
    pointsFor(r, results, Color.WHITE),
    Color.WHITE,
  );
  assert.deepEqual(
    list.map((t) => t.ply),
    [36, 40, 44],
  );
  r.goto(35);
  assert.equal(list[0]?.mark, "悪手");
  assert.equal(list[0]?.best, readingText(r.position, [shallow.move])[0]);
  assert.equal(list[0]?.deep, undefined);
  r.goto(39);
  const line = readingText(r.position, deep.pv);
  assert(line.length > 1);
  assert.equal(list[1]?.mark, undefined);
  assert.equal(list[1]?.best, line[0]);
  assert.deepEqual(list[1]?.deep, { score: "−800", reading: line.slice(1) });
  r.goto(43);
  assert.equal(list[2]?.mark, "詰み逃し");
  assert.equal(list[2]?.mate, 3);
  assert.equal(list[2]?.best, readingText(r.position, mate.pv)[0]);
  assert.equal(list[2]?.deep?.score, "3手詰め");
  // 本譜がおすすめと同じなら、おすすめは出さない
  results[39]!.deep!.candidates = [
    { ...deep, move: played(40), pv: [played(40)] },
  ];
  assert.equal(
    turningPoints(
      r,
      results,
      pointsFor(r, results, Color.WHITE),
      Color.WHITE,
    )[1]?.best,
    undefined,
  );
});

test("候補と読み筋は深読みを優先し、深読みなしなら従来の候補を出す", () => {
  const r = record();
  const base = result(0, 0);
  const withCandidate = (move: string) => ({
    ...base,
    candidates: [
      { rank: 1, depth: 20, move, pv: [move, "3c3d"], score: base.score },
    ],
  });
  const shallow = withCandidate("7g7f");
  const deep = withCandidate("2g2f");
  r.goto(0);
  const rows = (a: AnalysisResult) =>
    candidateRows(r.position, a, undefined, Color.BLACK, true);
  assert.deepEqual(rows({ ...shallow, deep })[0]?.pv, ["2g2f", "3c3d"]);
  assert.deepEqual(rows(shallow)[0]?.pv, ["7g7f", "3c3d"]);
});

test("復元した途中結果は解析済み扱いにせず、結果のない局面は未解析と分かる", async () => {
  const { partialSaved } = await import("../src/analysis/types");
  const saved = {
    initial: "startpos",
    moves: ["7g7f"],
    mode: "precise" as const,
    results: [result(0, 0)],
    coachProof: null,
    jobId: "",
    partial: true,
  };
  assert.equal(partialSaved(saved), true);
  assert.equal(
    partialSaved({
      ...saved,
      partial: undefined,
      results: [result(0, 0), result(1, 0)],
    }),
    false,
  );
});
