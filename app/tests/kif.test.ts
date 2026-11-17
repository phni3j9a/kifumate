import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import Encoding from "encoding-japanese";
import { Color, Move, PieceType, Position, Square } from "tsshogi";
import {
  Branch,
  decodeKif,
  describe,
  gameOutcome,
  identity,
  legalMoves,
  matchNames,
  readKif,
  resultFor,
  writeKif,
} from "../src/core/kif";
const kif = readFileSync("tests/fixtures/standard.kif", "utf8");
test("実書式：全角座標・同・成・時刻・コメント・CRLF・BOM", () => {
  const record = readKif("\ufeff" + kif.replace(/\n/g, "\r\n"));
  assert.equal(describe(record).plies, 5);
  assert.equal(gameOutcome(record), "black");
  assert.equal(record.moves[3]?.comment.trim(), "角を交換する");
});
test("UTF-8 と Shift_JIS を拡張子に頼らず読む", () => {
  for (const from of ["UTF8", "SJIS"] as const) {
    const bytes = new Uint8Array(
      Encoding.convert(Encoding.stringToCode(kif), {
        from: "UNICODE",
        to: from,
      }),
    );
    assert.equal(describe(readKif(decodeKif(bytes))).black, "つばめ");
  }
  assert.throws(() => decodeKif(new Uint8Array([0, 0, 0])));
});
test("表記揺れ：半角数字、玉、駒落ちと盤面図の往復", () => {
  assert.equal(
    identity(readKif(kif.replace("７六歩", "7六歩"))),
    identity(readKif(kif)),
  );
  const r = readKif(
    "手合割：角落ち\n下手：下手さん\n上手：上手さん\n手数----指手\n1 ３四歩(33)\n2 ７六歩(77)\n3 中断",
  );
  assert.equal(describe(r).black, "下手さん");
  assert.equal(identity(r), identity(readKif(writeKif(r))));
});
test("重複は開始局面＋本譜の通常手のみ（名前・日付・結果・コメントは無視）", () => {
  assert.equal(
    identity(readKif(kif)),
    identity(readKif(kif.replace("つばめ", "別名").replace("投了", "中断"))),
  );
  assert.notEqual(
    identity(readKif(kif)),
    identity(readKif(kif.replace("７八金(69)", "６八金(69)"))),
  );
  assert.notEqual(
    identity(readKif("手合割：平手")),
    identity(readKif("手合割：角落ち")),
  );
});
test("曖昧な名前照合・全角英数と空白・大文字小文字", () => {
  assert.deepEqual(matchNames(" ＡＢＣ ", "相手", ["abc"]), {
    side: "black",
    ambiguous: false,
  });
  assert.deepEqual(matchNames("つばめ", "こまどり", ["つばめ", "こまどり"]), {
    side: null,
    ambiguous: true,
  });
  assert.equal(matchNames("つばめ", "こまどり", []).side, null);
  assert.equal(resultFor("white", gameOutcome(readKif(kif))), "loss");
  assert.equal(resultFor(null, "black"), "unknown");
});
test("終局理由：引き分け・中断・反則負け・入玉勝ち", () => {
  for (const [end, outcome] of [
    ["千日手", "draw"],
    ["持将棋", "draw"],
    ["中断", null],
    ["反則負け", "black"],
    ["入玉勝ち", "white"],
  ] as const) {
    assert.equal(gameOutcome(readKif(kif.replace("投了", end))), outcome);
  }
});
test("空・異形式・手数欠落・不正な座標・非合法手・未知の手合割を拒否", () => {
  for (const text of [
    "",
    "将棋のメモです",
    "先手：名前だけ",
    kif.replace("   2 ", "   4 "),
    kif.replace("７六歩(77)", "７五歩(77)"),
    kif.replace("７六歩(77)", "０六歩(77)"),
    "手合割：謎",
  ]) {
    assert.throws(() => readKif(text), text);
  }
});
test("KIF書き出しの往復で本譜・コメント・メタデータ・開始局面を維持", () => {
  const r = readKif(kif),
    roundtrip = readKif(writeKif(r));
  assert.equal(identity(r), identity(roundtrip));
  assert.deepEqual(describe(r), describe(roundtrip));
  assert.equal(gameOutcome(r), gameOutcome(roundtrip));
});
test("分岐は本譜を変更せず、巻き戻して別の手を指せる", () => {
  const r = readKif(kif);
  r.goto(2);
  const original = writeKif(r),
    b = new Branch(2, r.position);
  b.play(b.position.createMoveByUSI("2g2f")!);
  b.play(b.position.createMoveByUSI("8c8d")!);
  b.step(0);
  b.play(b.position.createMoveByUSI("6i7h")!);
  assert.equal(b.moves.length, 1);
  assert.equal(b.at, 1);
  assert.equal(writeKif(r), original);
  assert.equal(gameOutcome(r), "black");
  assert.throws(() =>
    b.play(
      new Move(
        new Square(7, 8),
        new Square(7, 1),
        false,
        Color.WHITE,
        PieceType.GOLD,
        null,
      ),
    ),
  );
});
test("合法手は二歩・行き所なし・自玉放置・打ち歩詰めを除く、強制成り", () => {
  const initial = new Position();
  assert.equal(legalMoves(initial, new Square(7, 7)).length, 1);
  const force = Position.newBySFEN("4k4/P8/9/9/9/9/9/9/4K4 b - 1")!;
  assert.deepEqual(
    legalMoves(force, new Square(9, 2)).map((m) => m.usi),
    ["9b9a+"],
  );
  const drops = Position.newBySFEN("4k4/9/9/9/9/9/P8/9/4K4 b P 1")!;
  assert(
    !legalMoves(drops, PieceType.PAWN).some(
      (m) => m.to.file === 9 || m.to.rank === 1,
    ),
  );
  const mate = Position.newBySFEN("3lkl3/3p1p3/4G4/9/9/9/9/9/4K4 b P 1")!;
  assert(
    !legalMoves(mate, PieceType.PAWN).some((m) =>
      m.to.equals(new Square(5, 2)),
    ),
  );
});
