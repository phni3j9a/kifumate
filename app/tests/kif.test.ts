import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import Encoding from "encoding-japanese";
import {
  Color,
  Move,
  PieceType,
  Position,
  Square,
  Record as ShogiRecord,
} from "tsshogi";
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
  assert.equal(record.moves[1]?.elapsedMs, 1000);
  assert.equal(record.moves[3]?.elapsedMs, 3000);
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
    "手合割：平手\n1",
    "手合割：平手\n1 デタラメ",
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

test("時間のコロン・ASCIIヘッダーを壊さず書き出す", () => {
  const r = readKif(
    kif.replace("先手：", "先手:").replace("開始日時：", "開始日時:"),
  );
  const roundtrip = readKif(writeKif(r));
  assert.equal(describe(roundtrip).date, "2026/11/16 10:00:00");
  assert.equal(roundtrip.moves[1]?.elapsedMs, 1000);
  assert.equal(roundtrip.moves[3]?.elapsedMs, 3000);
});
test("盤面図・持ち駒・後手番の指定と入力内の変化を保持する", () => {
  const p = Position.newBySFEN("4k4/9/9/9/9/9/4P4/9/4K4 w P 1")!;
  const diagram = new ShogiRecord(p);
  const parsed = readKif(writeKif(diagram));
  assert.equal(identity(parsed), identity(diagram));
  const branched = readKif(
    kif + "\n変化：3手\n3 ２六歩(27)\n4 ８四歩(83)\n5 中断\n",
  );
  assert.equal(identity(branched), identity(readKif(kif)));
  let count = 0;
  branched.forEach(() => count++);
  assert.equal(count, 10);
  assert.equal(identity(readKif(writeKif(branched))), identity(branched));
});

test("盤面図の未知の駒・向き・欠落段・重複段・短い行を拒否する", () => {
  const diagram = writeKif(
    new ShogiRecord(Position.newBySFEN("4k4/9/9/9/9/9/9/9/4K4 b - 1")!),
  );
  for (const damaged of [
    diagram.replace(" 玉", " Ｘ"),
    diagram.replace("v玉", "x玉"),
    diagram.replace(" ・", "v・"),
    diagram.replace(/^\|.*\|九\r?\n/m, ""),
    diagram.replace("|九", "|八"),
    diagram.replace(" ・", "・"),
  ])
    assert.throws(() => readKif(damaged), /盤面図/, damaged);
});
test("指し手に書かれた駒種が移動元と違えば黙って修復せず拒否する", () => {
  for (const move of [
    "７六金(77)",
    "７六と(77)",
    "７六成銀(77)",
    "７六馬(77)",
    "７六龍(77)",
  ]) {
    assert.throws(() => readKif(kif.replace("７六歩(77)", move)), /駒/, move);
  }
  assert.throws(() => readKif(kif + "\n変化：3手\n3 ２六金(27)\n"), /駒/);
});
test("成り駒の表記と別名、成・不成・打を局面に照合する", () => {
  for (const [sfenPiece, notation, alias] of [
    ["+L", "成香", "杏"],
    ["+N", "成桂", "圭"],
    ["+S", "成銀", "全"],
    ["+P", "と", "と"],
    ["+B", "馬", "馬"],
    ["+R", "龍", "竜"],
  ]) {
    const record = new ShogiRecord(
      Position.newBySFEN(`k8/9/9/4${sfenPiece}4/9/9/9/9/4K4 b - 1`)!,
    );
    assert(record.append(record.position.createMoveByUSI("5d5c")!));
    const text = writeKif(record);
    assert.equal(
      identity(readKif(text.replace(notation!, alias!))),
      identity(record),
    );
    assert.throws(
      () => readKif(text.replace(`５三${notation}`, "５三金")),
      /駒/,
    );
  }
  const pawn = new ShogiRecord(
    Position.newBySFEN("k8/9/9/4P4/9/9/9/9/4K4 b - 1")!,
  );
  assert(pawn.append(pawn.position.createMoveByUSI("5d5c")!));
  const text = writeKif(pawn);
  assert.equal(
    identity(readKif(text.replace("歩(54)", "歩不成(54)"))),
    identity(pawn),
  );
  assert.notEqual(
    identity(readKif(text.replace("歩(54)", "歩成(54)"))),
    identity(pawn),
  );
  assert.throws(() => readKif(kif.replace("歩(77)", "歩不成(77)")));
  const drop = new ShogiRecord(
    Position.newBySFEN("k8/9/9/9/9/9/9/9/4K4 b P 1")!,
  );
  assert(drop.append(drop.position.createMoveByUSI("P*5e")!));
  const dropText = writeKif(drop);
  assert.equal(identity(readKif(dropText)), identity(drop));
  assert.throws(() => readKif(dropText.replace("歩打", "歩成打")));
  for (const piece of ["と", "成香", "成桂", "成銀", "馬", "龍", "玉"]) {
    assert.throws(() => readKif(dropText.replace("歩打", `${piece}打`)));
  }
});

test("入れ子の変化も入力順の局面で駒種を照合し、本譜とコメントを維持する", () => {
  const variations =
    kif +
    [
      "",
      "変化：3手",
      "3 ２六歩(27)",
      "4 ８四歩(83)",
      "5 ７八金(69)",
      "6 中断",
      "変化：4手",
      "4 ８八角成(22)",
      "5 同　銀(79)",
      "*分岐のコメント 不成(77)",
      "6 中断",
      "変化：2手",
      "2 ８四歩(83)",
      "3 ２六歩(27)",
      "4 中断",
      "",
    ].join("\n");
  const record = readKif(variations);
  assert.equal(identity(record), identity(readKif(kif)));
  assert(writeKif(record).includes("分岐のコメント 不成(77)"));
  assert.equal(writeKif(readKif(writeKif(record))), writeKif(record));
  assert.throws(
    () => readKif(variations.replace("同　銀(79)", "同　金(79)")),
    /駒/,
  );
});
