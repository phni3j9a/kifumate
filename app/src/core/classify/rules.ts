import { PieceType } from "tsshogi";

export type Family = "居飛車" | "振り飛車";
export type Placement = readonly [PieceType, ...number[]];
export interface ShapeRule {
  id: string;
  name: string;
  family?: Family;
  parentId?: string;
  /** 先手から見た筋・段（28 = ２八）。同じ駒種の行はすべて必要。 */
  pieces: readonly Placement[];
}

const {
  KING: K,
  GOLD: G,
  SILVER: S,
  PAWN: P,
  ROOK: R,
  LANCE: L,
  KNIGHT: N,
  BISHOP: B,
} = PieceType;

/** 完成形の要所をすべて要求する。手順や左右反転の処理は index.ts 側に集約。 */
export const castleRules: readonly ShapeRule[] = [
  {
    id: "mino",
    name: "美濃囲い",
    family: "振り飛車",
    pieces: [
      [K, 28],
      [S, 38],
      [G, 49],
      [G, 58],
      [P, 27],
      [P, 37],
      [P, 47],
    ],
  },
  {
    id: "high-mino",
    name: "高美濃",
    family: "振り飛車",
    parentId: "mino",
    pieces: [
      [K, 28],
      [S, 38],
      [G, 49],
      [G, 47],
      [P, 27],
      [P, 37],
      [P, 46],
    ],
  },
  {
    id: "silver-crown",
    name: "銀冠",
    family: "振り飛車",
    parentId: "high-mino",
    pieces: [
      [K, 28],
      [S, 27],
      [G, 38],
      [G, 47],
      [P, 26],
      [P, 37],
      [P, 46],
    ],
  },
  {
    id: "boat",
    name: "舟囲い",
    family: "居飛車",
    pieces: [
      [K, 78],
      [G, 58],
      [G, 69],
      [S, 79],
    ],
  },
  {
    id: "elmo",
    name: "エルモ囲い",
    family: "居飛車",
    pieces: [
      [K, 78],
      [S, 68],
      [G, 79],
      [G, 59],
    ],
  },
  {
    id: "gold-yagura",
    name: "金矢倉",
    family: "居飛車",
    pieces: [
      [K, 88],
      [G, 78],
      [G, 67],
      [S, 77],
      [P, 76],
      [P, 66],
      [P, 87],
    ],
  },
  {
    id: "gangi",
    name: "雁木囲い",
    family: "居飛車",
    pieces: [
      [K, 69, 79],
      [S, 77],
      [S, 67],
      [G, 78],
      [G, 58],
      [P, 76],
      [P, 66],
    ],
  },
  {
    id: "left-mino",
    name: "左美濃",
    family: "居飛車",
    pieces: [
      [K, 88],
      [S, 78],
      [G, 69],
      [G, 58],
      [P, 87],
    ],
  },
  {
    id: "static-anaguma",
    name: "居飛車穴熊",
    family: "居飛車",
    pieces: [
      [K, 99],
      [L, 98],
      [N, 89],
      [S, 88],
      [G, 78],
      [G, 68],
    ],
  },
  {
    id: "ranging-anaguma",
    name: "振り飛車穴熊",
    family: "振り飛車",
    pieces: [
      [K, 19],
      [L, 18],
      [N, 29],
      [S, 28],
      [G, 39],
      [G, 49],
    ],
  },
  {
    id: "central-king",
    name: "中住まい",
    family: "居飛車",
    pieces: [
      [K, 58],
      [G, 78],
      [G, 38],
      [S, 79],
      [S, 39],
    ],
  },
];

export const strategyRules: readonly ShapeRule[] = [
  {
    id: "fourth-file-rook",
    name: "四間飛車",
    family: "振り飛車",
    pieces: [
      [R, 68],
      [P, 66],
    ],
  },
  {
    id: "third-file-rook",
    name: "三間飛車",
    family: "振り飛車",
    pieces: [
      [R, 78],
      [P, 76],
    ],
  },
  {
    id: "central-rook",
    name: "中飛車",
    family: "振り飛車",
    pieces: [
      [R, 58],
      [P, 56, 55],
    ],
  },
  {
    id: "opposing-rook",
    name: "向かい飛車",
    family: "振り飛車",
    pieces: [
      [R, 88],
      [P, 86],
    ],
  },
  {
    id: "right-fourth-file-rook",
    name: "右四間飛車",
    family: "居飛車",
    pieces: [
      [R, 48],
      [S, 56, 45],
      [P, 46],
    ],
  },
  {
    id: "climbing-silver",
    name: "棒銀",
    family: "居飛車",
    pieces: [
      [R, 28],
      [S, 26],
      [P, 25],
    ],
  },
  {
    id: "sleeve-rook",
    name: "袖飛車",
    family: "居飛車",
    pieces: [
      [R, 38],
      [P, 36],
    ],
  },
];

/** 相手も居飛車と確定したときだけ公開する派生形。 */
export const mutualStaticRules: readonly ShapeRule[] = [
  {
    id: "rapid-silver",
    name: "早繰り銀",
    family: "居飛車",
    pieces: [
      [R, 28],
      [S, 46],
      [S, 79],
      [P, 36],
      [P, 25],
    ],
  },
  {
    id: "reclining-silver",
    name: "腰掛け銀",
    family: "居飛車",
    pieces: [
      [R, 28],
      [S, 56],
      [P, 57],
      [P, 46],
    ],
  },
];

export const fourthFileAttack: ShapeRule = {
  id: "anti-fourth-file-quick-attack",
  name: "対四間飛車急戦",
  family: "居飛車",
  pieces: [
    [K, 78],
    [G, 58],
    [S, 46],
    [P, 36],
    [B, 88],
  ],
};

export const contextualStrategies = [
  { id: "yagura", name: "矢倉" },
  { id: "gangi", name: "雁木" },
  { id: "bishop-exchange", name: "角換わり" },
  { id: "double-wing", name: "相掛かり" },
  { id: "side-pawn", name: "横歩取り" },
  { id: "double-ranging", name: "相振り飛車" },
  { id: "anti-ranging-slow-game", name: "対振り持久戦" },
  { id: "bishop-exchange-ranging", name: "角交換振り飛車" },
] as const;

export const relationshipRules = [
  { id: "mutual-static", name: "相居飛車" },
  { id: "opposed", name: "対抗形" },
  { id: "double-ranging", name: "相振り飛車" },
] as const;

/** 画面の候補・DB のラベル解決用。配列の並びは判定の優先順位ではない。 */
export const classificationCatalog = {
  strategies: [
    ...strategyRules,
    ...mutualStaticRules,
    fourthFileAttack,
    ...contextualStrategies,
  ].map(({ id, name }) => ({ id, name })),
  castles: castleRules.map(({ id, name, parentId }) => ({
    id,
    name,
    ...(parentId ? { parentId } : {}),
  })),
  relationships: relationshipRules,
};
