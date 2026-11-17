import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Color,
  Move,
  PieceType,
  Position,
  Record as ShogiRecord,
  SpecialMoveType,
  Square,
} from "tsshogi";
import {
  classificationCatalog,
  classifyMoves,
  classifyRecord,
} from "../src/core/classify";

// docs/classify.md「基本形の総点検」の定義・通常手順を先に確認し、規則とは独立に組み立てる。
// 囲いの片側手順は相手の玉の往復で手番だけを調整する。合法性は生成時と分類時に確認。
function record(usi: readonly string[]): ShogiRecord {
  const r = new ShogiRecord();
  for (const [i, text] of usi.entries()) {
    const move = r.position.createMoveByUSI(text);
    assert(
      move && r.position.isValidMove(move),
      `${i + 1}手目 ${text}\n${r.position.sfen}`,
    );
    assert(r.append(move));
  }
  return r;
}
const rotate = (usi: string) =>
  usi.replace(
    /[1-9][a-i]/g,
    (s) => `${10 - Number(s[0])}${String.fromCharCode(202 - s.charCodeAt(1))}`,
  );
function build(
  black: readonly string[],
  white?: readonly string[],
): ShogiRecord {
  const length = Math.max(black.length, white?.length ?? 0);
  const moves: string[] = [];
  for (let i = 0; i < length; i++) {
    const padding = [
      "9g9f",
      "9f9e",
      "1g1f",
      "1f1e",
      "3g3f",
      "3f3e",
      "4g4f",
      "4f4e",
    ];
    moves.push(
      black[i] ??
        (black.length ? padding[i - black.length]! : i % 2 ? "5h5i" : "5i5h"),
    );
    moves.push(
      white?.[i] ??
        (white?.length
          ? rotate(padding[i - white.length]!)
          : i % 2
            ? "5b5a"
            : "5a5b"),
    );
  }
  return record(moves);
}
const names = (r: ShogiRecord, side: "black" | "white" = "black") =>
  classifyRecord(r).sides[side].strategies.map((s) => s.name);
const castleNames = (r: ShogiRecord, side: "black" | "white" = "black") =>
  classifyRecord(r).sides[side].castles.map((s) => s.name);
const ranging = ["7g7f", "6g6f", "2h6h", "8h7g", "5i4h", "4h3h", "3h2h"];
const mino = [...ranging, "3i3h", "6i5h"];
// 高美濃は58金→47金と直接上がり、36歩・37桂まで組む。
const highMino = [...mino, "4g4f", "5h4g", "3g3f", "2i3g"];
const silverCrown = [...highMino, "2g2f", "3h2g", "4i3h"];
const boat = ["7g7f", "2g2f", "3i4h", "5g5f", "5i6h", "6h7h", "4i5h"];
// 舟囲いから金を引き直さず、左銀68・左金79で基本エルモ（右金49）を作る。
const elmo = [
  "7g7f",
  "2g2f",
  "3i4h",
  "5g5f",
  "5i6h",
  "6h7h",
  "4h5g",
  "7i6h",
  "6i7i",
];
const yagura = [
  "7g7f",
  "6g6f",
  "7i6h",
  "6h7g",
  "6i7h",
  "4i5h",
  "5h6g",
  "8h7i",
  "7i6h",
  "5i6i",
  "6i7i",
  "7i8h",
];
const gangi = [
  "7g7f",
  "6g6f",
  "7i6h",
  "6h6g",
  "5g5f",
  "3i4h",
  "4h5g",
  "6i7h",
  "4i5h",
  "5i6i",
];
const leftMino = [...boat, "8h7g", "7h8h", "7i7h", "9g9f"];
const staticAnaguma = [
  "7g7f",
  "2g2f",
  "3i4h",
  "5g5f",
  "5i6h",
  "6h7h",
  "4h5g",
  "8h7g",
  "7h8h",
  "9i9h",
  "8h9i",
  "7i8h",
  "6i7i",
  "4i5h",
  "5h6h",
  "6h7h",
];
const rangingAnaguma = [
  ...ranging,
  "1i1h",
  "2h1i",
  "3i2h",
  "4i3i",
  "6i5h",
  "5h4h",
  "4h3h",
];
const centralKing = ["2g2f", "6i7h", "3i4h", "4i3h", "5i5h"];
const castles = [
  ["美濃囲い", mino],
  ["高美濃", highMino],
  ["銀冠", silverCrown],
  ["舟囲い", boat],
  ["エルモ囲い", elmo],
  ["金矢倉", yagura],
  ["雁木囲い", gangi],
  ["左美濃", leftMino],
  ["居飛車穴熊", staticAnaguma],
  ["振り飛車穴熊", rangingAnaguma],
  ["中住まい", centralKing],
] as const;

for (const [name, line] of castles) {
  test(`資料の基本手順で完成した${name}を先手・後手で判定する`, () => {
    for (const [r, side] of [
      [build(line), "black"],
      [build([], line.map(rotate)), "white"],
    ] as const) {
      assert(castleNames(r, side).includes(name));
      // 履歴途中の別形で偶然拾っていないことも、完成図だけを入力して確認する。
      assert(
        classifyMoves(r.position, []).sides[side].castles.some(
          (c) => c.name === name,
        ),
      );
    }
  });
}

test("美濃→高美濃→銀冠の実際の順序・根拠・親を記録し、同じ形の継続は重複させない", () => {
  const r = build(silverCrown);
  const output = classifyRecord(r).sides.black;
  assert.deepEqual(
    output.castles.map((s) => s.name),
    ["美濃囲い", "高美濃", "銀冠"],
  );
  assert.deepEqual(
    output.castles.map((s) => s.ply),
    [17, 21, 31],
  );
  assert.equal(output.castles[1]!.parentId, "mino");
  assert.equal(output.castles[1]!.evolvesFromPly, 17);
  assert.equal(output.castles[2]!.parentId, "high-mino");
  assert.equal(output.castles[2]!.evolvesFromPly, 21);
  for (const event of output.castles) {
    assert(event.conditions.length >= 5);
    assert(Position.newBySFEN(event.sfen));
  }
});

test("途中局面入力では観測していない親囲いを捏造しない", () => {
  const r = build(silverCrown);
  const output = classifyMoves(r.position, []).sides.black;
  assert.deepEqual(
    output.castles.map((s) => s.name),
    ["銀冠"],
  );
  assert.equal(output.castles[0]!.ply, 0);
  assert.equal(output.castles[0]!.parentId, "high-mino");
  assert.equal(output.castles[0]!.evolvesFromPly, undefined);
});

const strategies = [
  ["四間飛車", ranging],
  [
    "三間飛車",
    ["7g7f", "2h7h", "8h7g", "6g6f", "7i6h", "5i4h", "4h3h", "3h2h"],
  ],
  [
    "中飛車",
    [
      "7g7f",
      "6g6f",
      "7i6h",
      "8h7g",
      "5g5f",
      "2h5h",
      "5i4h",
      "4h3h",
      "3h2h",
      "3i3h",
    ],
  ],
  [
    "向かい飛車",
    [
      "7g7f",
      "6g6f",
      "7i6h",
      "8h7g",
      "6h6g",
      "2h8h",
      "5i4h",
      "4h3h",
      "3h2h",
      "3i3h",
      "6i7h",
    ],
  ],
  [
    "右四間飛車",
    ["7g7f", "4g4f", "3i4h", "4h4g", "4g5f", "2h4h", "5i6h", "6h7h", "4i5h"],
  ],
  ["棒銀", ["7g7f", "2g2f", "2f2e", "3i3h", "5i6h", "3h2g", "2g2f"]],
  ["袖飛車", ["3g3f", "2h3h", "6i7h", "5i6h"]],
  ["矢倉", yagura],
  ["雁木", gangi],
] as const;
for (const [name, line] of strategies) {
  test(`戦法${name}を先手・後手で判定する`, () => {
    assert(names(build(line)).includes(name));
    assert(names(build([], line.map(rotate)), "white").includes(name));
  });
}

test("紛らわしい飛車位置を区別し、未完成の構えを推測しない", () => {
  assert(!names(build(strategies[4][1])).includes("四間飛車"));
  assert(!names(build(strategies[6][1])).includes("三間飛車"));
  const uncertain = classifyRecord(build(["7g7f", "6g6f", "8h7g", "2h6h"]));
  assert.equal(uncertain.sides.black.family, "未分類");
  assert.equal(uncertain.sides.black.strategyStatus, "未分類");
  assert.deepEqual(uncertain.sides.black.strategies, []);
  assert(!names(build(["7g7f", "2h4h", "5i6h"])).includes("右四間飛車"));
  assert(!castleNames(build(mino.slice(0, -1))).includes("美濃囲い"));
});

test("平手開始・短い棋譜・駒不足は未分類。入力の局面を変更しない", () => {
  const p = new Position(),
    sfen = p.sfen;
  const output = classifyMoves(p, []);
  assert.equal(output.rulesVersion, 2);
  assert.equal(p.sfen, sfen);
  for (const s of Object.values(output.sides)) {
    assert.equal(s.family, "未分類");
    assert.equal(s.castleStatus, "未分類");
    assert.equal(s.strategyStatus, "未分類");
  }
  assert.equal(output.relationshipStatus, "未分類");
  assert.throws(() =>
    classifyMoves(Position.newBySFEN("9/9/9/9/9/9/9/9/4K4 b - 1")!, []),
  );
  const illegal = p.createMoveByUSI("7g7e")!;
  assert.throws(() => classifyMoves(p, [illegal]), /1手目/);
  assert.equal(p.sfen, sfen);
  const wrongColor = p.createMoveByUSI("7g7f")!;
  wrongColor.color = Color.WHITE;
  assert.throws(() => classifyMoves(p, [wrongColor]), /1手目/);
  const wrongPiece = p.createMoveByUSI("7g7f")!;
  wrongPiece.pieceType = PieceType.ROOK;
  assert.throws(() => classifyMoves(p, [wrongPiece]), /1手目/);
});

// 相居飛車の典型的な交換手順。相掛かりは角道を開けず、横歩取りでは開ける。
const doubleWing = [
  "2g2f",
  "8c8d",
  "2f2e",
  "8d8e",
  "6i7h",
  "4a3b",
  "2e2d",
  "2c2d",
  "2h2d",
  "8e8f",
  "8g8f",
  "8b8f",
  "2d2f",
  "8f8d",
];
const sidePawn = [
  "7g7f",
  "3c3d",
  "2g2f",
  "8c8d",
  "2f2e",
  "8d8e",
  "6i7h",
  "4a3b",
  "2e2d",
  "2c2d",
  "2h2d",
  "8e8f",
  "8g8f",
  "8b8f",
  "2d3d",
];
// 通常の角換わり：77角で飛車先を受け、88銀を用意して77で交換する。
const bishopExchange = [
  "7g7f",
  "8c8d",
  "2g2f",
  "8d8e",
  "8h7g",
  "3c3d",
  "7i8h",
  "2b7g+",
  "8h7g",
  "4a3b",
  "6i7h",
  "3a2b",
  "3i3h",
  "7a6b",
  "5i6h",
  "2b3c",
];
const bishopExchangeRanging = [
  "7g7f",
  "3c3d",
  "2h6h",
  "8c8d",
  "5i4h",
  "8d8e",
  "4h3h",
  "5a4b",
  "8h2b+",
  "3a2b",
  "7i8h",
  "2b3c",
  "8h7g",
  "7a6b",
  "3h2h",
  "4b3b",
  "3i3h",
];

test("相掛かりと横歩取りは双方の飛車先交換・角道・横歩捕獲を区別する", () => {
  for (const side of ["black", "white"] as const) {
    assert(names(record(doubleWing), side).includes("相掛かり"));
    assert(!names(record(doubleWing), side).includes("横歩取り"));
    assert(names(record(sidePawn), side).includes("横歩取り"));
    assert(!names(record(sidePawn), side).includes("相掛かり"));
  }
  assert(!names(record(doubleWing.slice(0, 8))).includes("相掛かり"));
  assert(names(record(doubleWing.slice(0, 9))).includes("相掛かり"));
  assert(!names(record(sidePawn.slice(0, -1))).includes("横歩取り"));
});

test("角換わりは実際の序盤角交換と相居飛車の組み合わせを要求する", () => {
  const r = record(bishopExchange);
  assert(names(r).includes("角換わり"));
  assert(names(r, "white").includes("角換わり"));
  assert(!names(record(bishopExchange.slice(0, 8))).includes("角換わり"));
  const noHistory = classifyMoves(r.position, []);
  assert(
    !noHistory.sides.black.strategies.some(({ name }) => name === "角換わり"),
  );
});

test("双方の関係による相振り飛車・対抗形・相居飛車を記録する", () => {
  const both = build(mino, mino.map(rotate));
  assert(names(both).includes("相振り飛車"));
  assert(names(both, "white").includes("相振り飛車"));
  assert.equal(classifyRecord(both).relationships.at(-1)!.name, "相振り飛車");
  const opposed = build(leftMino, mino.map(rotate));
  assert.equal(classifyRecord(opposed).relationships.at(-1)!.name, "対抗形");
  assert(!names(opposed).includes("対振り持久戦"));
  assert(castleNames(opposed).includes("左美濃"));
  assert.equal(
    classifyRecord(record(doubleWing)).relationships.at(-1)!.name,
    "相居飛車",
  );
});

test("対四間飛車急戦と持久戦は自陣の形と相手の形の両方を要求する", () => {
  const quick = [...boat, "2f2e", "7i6h", "6h5g", "3g3f", "5g4f"];
  assert(names(build(quick, mino.map(rotate))).includes("対四間飛車急戦"));
  assert(!names(build(quick)).includes("対四間飛車急戦"));
  const thirdFile = mino.map((s) => (s === "2h6h" ? "2h7h" : s));
  assert(
    !names(build(quick, thirdFile.map(rotate))).includes("対四間飛車急戦"),
  );
  assert(
    names(build(mino, quick.map(rotate)), "white").includes("対四間飛車急戦"),
  );
  assert(!names(build(leftMino)).includes("対振り持久戦"));
  assert(
    !names(build(mino, leftMino.map(rotate)), "white").includes("対振り持久戦"),
  );
  assert(
    names(build(mino, staticAnaguma.map(rotate)), "white").includes(
      "対振り持久戦",
    ),
  );
  assert(
    names(build(staticAnaguma, rangingAnaguma.map(rotate))).includes(
      "対振り持久戦",
    ),
  );
});

test("早繰り銀・腰掛け銀は相居飛車の確認後に公開する", () => {
  const early = [
    "7g7f",
    "2g2f",
    "2f2e",
    "3i3h",
    "3g3f",
    "5i6h",
    "3h3g",
    "3g4f",
  ];
  const waist = ["7g7f", "2g2f", "3i4h", "4g4f", "5i6h", "4h4g", "4g5f"];
  for (const [label, line] of [
    ["早繰り銀", early],
    ["腰掛け銀", waist],
  ] as const) {
    assert(names(build(line, boat.map(rotate))).includes(label));
    assert(!names(build(line)).includes(label));
    assert(names(build(boat, line.map(rotate)), "white").includes(label));
  }
});

test("角交換振り飛車と角換わりは同じ角交換だけで混同しない", () => {
  const r = record(bishopExchangeRanging);
  assert(names(r).includes("角交換振り飛車"));
  assert(!names(r).includes("角換わり"));
  const mirror = record([
    "9g9f",
    ...r.moves
      .map((n) => n.move)
      .filter((m): m is Move => m instanceof Move)
      .map((m) => rotate(m.usi)),
  ]);
  assert(names(mirror, "white").includes("角交換振り飛車"));
  assert(!names(mirror, "white").includes("角換わり"));
});

test("途中の飛車の転換と、囲いを一度崩して築き直した履歴を残す", () => {
  const changed = build([...mino, "6h7h"]);
  assert.deepEqual(
    names(changed).filter((s) => ["四間飛車", "三間飛車"].includes(s)),
    ["四間飛車", "三間飛車"],
  );
  const rebuilt = build([...mino, "2h1h", "1h2h"]);
  assert.deepEqual(castleNames(rebuilt), ["美濃囲い", "美濃囲い"]);
});

test("Recordの選択中の分岐・現在手数・コメントを変えず、主変化だけを走査する", () => {
  const r = build(mino);
  r.goto(4);
  const move = r.position.createMoveByUSI("2h7h")!;
  assert(r.append(move));
  r.current.comment = "分岐は分類対象外";
  const before = r.getUSI({ allMoves: true });
  const current = r.current;
  const output = classifyRecord(r);
  assert(output.sides.black.strategies.some(({ name }) => name === "四間飛車"));
  assert(
    !output.sides.black.strategies.some(({ name }) => name === "三間飛車"),
  );
  assert.equal(r.current, current);
  assert.equal(r.getUSI({ allMoves: true }), before);
  assert.equal(r.current.comment, "分岐は分類対象外");
});

test("終局理由は通常手に数えず、後手番開始も入力からの半手数で返す", () => {
  const r = build(mino);
  assert(r.append(SpecialMoveType.RESIGN));
  assert.equal(classifyRecord(r).processedPlies, mino.length * 2);
  const p = new Position();
  const first = p.createMoveByUSI("7g7f")!;
  assert(p.doMove(first));
  const move = p.createMoveByUSI("3c3d")!;
  assert.equal(move.color, Color.WHITE);
  assert.equal(classifyMoves(p, [move]).processedPlies, 1);
});

test("カタログの全種類は上記の合法手テストで使われ、IDは種別内で一意", () => {
  assert.equal(classificationCatalog.castles.length, castles.length);
  for (const entries of Object.values(classificationCatalog)) {
    assert.equal(new Set(entries.map(({ id }) => id)).size, entries.length);
  }
  // Move列APIもRecord APIと同じ結果を返す。
  const r = build(mino);
  const moves = r.moves
    .map((n) => n.move)
    .filter((m): m is Move => m instanceof Move);
  assert.deepEqual(classifyMoves(r.initialPosition, moves), classifyRecord(r));
  const catalogStrategies = classificationCatalog.strategies
    .map(({ name }) => name)
    .sort();
  const testedStrategies = [
    ...strategies.map(([name]) => name),
    "相掛かり",
    "横歩取り",
    "角換わり",
    "相振り飛車",
    "対振り持久戦",
    "対四間飛車急戦",
    "早繰り銀",
    "腰掛け銀",
    "角交換振り飛車",
  ].sort();
  assert.deepEqual(catalogStrategies, testedStrategies);
});

test("居飛車から振り飛車への転換は大分類と対局全体の履歴にも残る", () => {
  const converted = [
    ...boat,
    "5h5g",
    "6i5i",
    "4h3i",
    "2h6h",
    "6g6f",
    "7h6i",
    "6i5h",
    "5h4h",
    "4h3h",
    "3h2h",
  ];
  const black = [
    ...ranging,
    ...Array.from({ length: converted.length - ranging.length }, (_, i) =>
      i % 2 ? "1h2h" : "2h1h",
    ),
  ];
  const output = classifyRecord(build(black, converted.map(rotate)));
  assert.deepEqual(
    output.sides.white.familyHistory.map(({ family }) => family),
    ["居飛車", "振り飛車"],
  );
  assert.deepEqual(
    output.relationships.map(({ name }) => name),
    ["対抗形", "相振り飛車"],
  );
  assert.equal(output.sides.white.family, "振り飛車");
});

test("32手を超えた角交換を序盤の角換わりと推測しない", () => {
  const waits = Array.from({ length: 16 }, (_, i) => [
    i % 2 ? "5h5i" : "5i5h",
    i % 2 ? "5b5a" : "5a5b",
  ]).flat();
  const r = record([...waits, ...bishopExchange]);
  assert(!names(r).includes("角換わり"));
  assert(!names(r, "white").includes("角換わり"));
});

test("雁木の二枚銀は67・57であり、旧誤配置77・67を雁木とはしない", () => {
  const basic = build(gangi);
  for (const [file, rank] of [
    [6, 7],
    [5, 7],
  ]) {
    const piece = basic.position.board.at(new Square(file!, rank!));
    assert.equal(piece?.color, Color.BLACK);
    assert.equal(piece?.type, PieceType.SILVER);
  }
  assert.equal(basic.position.board.at(new Square(7, 7)), null);
  assert(names(basic).includes("雁木"));
  assert(castleNames(basic).includes("雁木囲い"));
  const wrong = [
    "7g7f",
    "6g6f",
    "7i6h",
    "6h7g",
    "5g5f",
    "3i4h",
    "4h5g",
    "5g6h",
    "6h6g",
    "6i7h",
    "4i5h",
    "5i6i",
  ];
  for (const [r, side] of [
    [build(wrong), "black"],
    [build([], wrong.map(rotate)), "white"],
  ] as const) {
    assert(!names(r, side).includes("雁木"));
    assert(!castleNames(r, side).includes("雁木囲い"));
  }
});

test("基本形と資料で説明された発展形の両方を完成図から判定する", () => {
  const cases = [
    ["高美濃", [...mino, "4g4f", "5h4g"]], // 36歩・37桂の前
    ["銀冠", [...mino, "4g4f", "5h4g", "2g2f", "3h2g", "4i3h"]],
    ["エルモ囲い", [...elmo, "4i5i"]], // 49金→59金で補強
    ["中住まい", ["2g2f", "6i7h", "4i3h", "5i5h"]], // 銀を上げない初期形
  ] as const;
  for (const [name, line] of cases) {
    for (const [r, side] of [
      [build(line), "black"],
      [build([], line.map(rotate)), "white"],
    ] as const) {
      assert(
        classifyMoves(r.position, []).sides[side].castles.some(
          (c) => c.name === name,
        ),
      );
    }
  }
});

test("標準の角換わりから棒銀・早繰り銀・腰掛け銀を組み立てる", () => {
  const continuations = [
    ["棒銀", ["2f2e", "6c6d", "3h2g", "6b6c", "2g2f", "5a4b"]],
    ["早繰り銀", ["3g3f", "6c6d", "3h3g", "6b6c", "2f2e", "5a4b", "3g4f"]],
    ["腰掛け銀", ["4g4f", "6c6d", "3h4g", "6b6c", "4g5f", "5a4b"]],
  ] as const;
  for (const [name, continuation] of continuations) {
    const moves = [...bishopExchange, ...continuation];
    const black = record(moves);
    const white = record(["9g9f", ...moves.map(rotate)]);
    for (const [r, side] of [
      [black, "black"],
      [white, "white"],
    ] as const) {
      assert(names(r, side).includes("角換わり"));
      assert(names(r, side).includes(name));
      assert(
        classifyMoves(r.position, []).sides[side].strategies.some(
          (s) => s.name === name,
        ),
      );
    }
  }
});

test("77・33で交換する通常の角換わりと22・88で交換する形を両方扱う", () => {
  const direct = [
    "7g7f",
    "3c3d",
    "2g2f",
    "8c8d",
    "2f2e",
    "8d8e",
    "8h2b+",
    "3a2b",
    "5i6h",
    "5a4b",
  ];
  for (const moves of [bishopExchange, direct]) {
    for (const [r, side] of [
      [record(moves), "black"],
      [record(["9g9f", ...moves.map(rotate)]), "white"],
    ] as const) {
      assert(names(r, side).includes("角換わり"));
    }
  }
});

test("対四間飛車急戦は斜め棒銀の通常の対抗形手順で検証する", () => {
  // Shogi Lounge「四間飛車対斜め棒銀の定跡」の基本図までの手順。
  const moves = [
    "7g7f",
    "3c3d",
    "2g2f",
    "4c4d",
    "3i4h",
    "8b4b",
    "5i6h",
    "7a7b",
    "6h7h",
    "9c9d",
    "9g9f",
    "3a3b",
    "5g5f",
    "5a6b",
    "4i5h",
    "6b7a",
    "2f2e",
    "2b3c",
    "7i6h",
    "7a8b",
    "6h5g",
    "4a5b",
    "3g3f",
    "3b4c",
    "5g4f",
  ];
  assert(names(record(moves)).includes("対四間飛車急戦"));
  assert(
    names(record(["9g9f", ...moves.map(rotate)]), "white").includes(
      "対四間飛車急戦",
    ),
  );
});

test("横歩取りからの88角成・同銀を角換わりと誤判定しない", () => {
  const moves = [...sidePawn, "2b8h+", "7i8h"];
  for (const r of [record(moves), record(["9g9f", ...moves.map(rotate)])]) {
    for (const side of ["black", "white"] as const) {
      assert(names(r, side).includes("横歩取り"));
      assert(!names(r, side).includes("角換わり"));
    }
  }
});

test("中飛車は中央の位を取る通常の出だしでも判定する", () => {
  // 将棋Webの56歩・76歩・77角・55歩・58飛を双方の自然な応手で進める。
  const moves = [
    "5g5f",
    "8c8d",
    "7g7f",
    "8d8e",
    "8h7g",
    "3c3d",
    "5f5e",
    "7a6b",
    "2h5h",
    "5a4b",
    "5i4h",
  ];
  assert(names(record(moves)).includes("中飛車"));
  assert(
    names(record(["9g9f", ...moves.map(rotate)]), "white").includes("中飛車"),
  );
});
