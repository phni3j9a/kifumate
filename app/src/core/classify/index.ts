import {
  Color,
  Move,
  PieceType,
  Position,
  Square,
  standardPieceName,
  type ImmutablePosition,
  type ImmutableRecord,
} from "tsshogi";
import {
  castleRules,
  contextualStrategies,
  fourthFileAttack,
  mutualStaticRules,
  relationshipRules,
  strategyRules,
  type Family,
  type ShapeRule,
} from "./rules";
export { classificationCatalog } from "./rules";
export type { Family, ShapeRule } from "./rules";

export interface Evidence {
  /** 入力開始局面を0とする半手数。後手番開始でも1ずつ増える。 */
  ply: number;
  sfen: string;
  conditions: string[];
}
export interface Finding extends Evidence {
  id: string;
  name: string;
}
export interface CastleFinding extends Finding {
  parentId?: string;
  /** 親の形を実際に観測した場合だけ付く。 */
  evolvesFromPly?: number;
}
export interface SideClassification {
  family: Family | "未分類";
  familyHistory: (Evidence & { family: Family })[];
  strategies: Finding[];
  strategyStatus: "判定済み" | "未分類";
  castles: CastleFinding[];
  castleStatus: "判定済み" | "未分類";
}
export interface Classification {
  rulesVersion: 1;
  processedPlies: number;
  sides: { black: SideClassification; white: SideClassification };
  relationships: Finding[];
  relationshipStatus: "判定済み" | "未分類";
}

const sides = [Color.BLACK, Color.WHITE] as const;
const key = (side: Color) => (side === Color.BLACK ? "black" : "white");
const other = (side: Color) =>
  side === Color.BLACK ? Color.WHITE : Color.BLACK;
const relative = (n: number, side: Color) =>
  side === Color.BLACK ? n : 110 - n;
function square(n: number): Square {
  return new Square(Math.floor(n / 10), n % 10);
}
function has(
  p: ImmutablePosition,
  side: Color,
  type: PieceType,
  n: number,
): boolean {
  const piece = p.board.at(square(relative(n, side)));
  return piece?.color === side && piece.type === type;
}
function matches(p: ImmutablePosition, side: Color, rule: ShapeRule): boolean {
  return rule.pieces.every(([type, ...places]) =>
    places.some((n) => has(p, side, type, n)),
  );
}
function shapeConditions(
  p: ImmutablePosition,
  side: Color,
  rule: ShapeRule,
): string[] {
  return rule.pieces.map(([type, ...places]) => {
    const n = places.find((n) => has(p, side, type, n))!;
    return `${relative(n, side)}に${key(side) === "black" ? "先手" : "後手"}の${standardPieceName(type)}`;
  });
}

/** 飛車の筋だけでは確定しない。玉が逆側へ移動した形を要求する。 */
function familyAt(
  p: ImmutablePosition,
  side: Color,
  previous?: Evidence & { family: Family },
): { family: Family; conditions: string[] } | null {
  const kings = p.board.findKing(side);
  const rooks = p.board.listNonEmptySquares().filter((s) => {
    const piece = p.board.at(s)!;
    return (
      piece.color === side &&
      (piece.type === PieceType.ROOK || piece.type === PieceType.DRAGON)
    );
  });
  if (!kings || rooks.length !== 1) return null;
  const rook = rooks[0]!;
  const r = relative(rook.file * 10 + rook.rank, side);
  const k = relative(kings.file * 10 + kings.rank, side);
  const rf = Math.floor(r / 10),
    kf = Math.floor(k / 10);
  if (k % 10 < 7) return null;
  if (r % 10 < 6 || p.board.at(rook)!.type === PieceType.DRAGON) {
    return previous
      ? {
          family: previous.family,
          conditions: [
            ...previous.conditions,
            `確認済みの大分類を維持（飛車が${r}へ進出）`,
          ],
        }
      : null;
  }
  let family: Family;
  if (rf >= 5 && rf <= 8 && kf <= 4) family = "振り飛車";
  else if (rf >= 2 && rf <= 4 && kf >= 6) family = "居飛車";
  else if (
    rf === 2 &&
    (k === 58 || k === 59) &&
    has(p, side, PieceType.GOLD, 78) &&
    (has(p, side, PieceType.PAWN, 25) ||
      has(p, side, PieceType.PAWN, 26) ||
      r === 26)
  )
    family = "居飛車";
  else return null;
  return {
    family,
    conditions: [`自分から見て飛車${r}・玉${k}、大分類の確認形に一致`],
  };
}

function emptySide(): SideClassification {
  return {
    family: "未分類",
    familyHistory: [],
    strategies: [],
    strategyStatus: "未分類",
    castles: [],
    castleStatus: "未分類",
  };
}

/** 入力を変更せず、本譜（各分岐の先頭ノード）を終局まで分類する。表示中の分岐は無視。 */
export function classifyRecord(record: ImmutableRecord): Classification {
  const moves: Move[] = [];
  for (let node = record.first.next; node; node = node.next) {
    if (!(node.move instanceof Move)) break;
    moves.push(node.move);
  }
  return classifyMoves(record.initialPosition, moves);
}

/** 開始局面と合法な通常手列。入力局面・指し手は変更しない。不正な手は例外。 */
export function classifyMoves(
  initialPosition: ImmutablePosition,
  moves: readonly Move[],
): Classification {
  const p = Position.newBySFEN(initialPosition.sfen);
  if (!p || !p.board.findKing(Color.BLACK) || !p.board.findKing(Color.WHITE)) {
    throw new Error("分類には両玉のある開始局面が必要です。");
  }
  const result: Classification = {
    rulesVersion: 1,
    processedPlies: moves.length,
    sides: { black: emptySide(), white: emptySide() },
    relationships: [],
    relationshipStatus: "未分類",
  };
  const previousCastles = {
    black: new Set<string>(),
    white: new Set<string>(),
  };
  const rookPawnExchange = { black: false, white: false };
  let bishopExchangePly: number | null = null;
  let sidePawnPly: number | null = null;
  let pendingBishopCapture: Move | null = null;

  function scan(ply: number): void {
    const evidence = (conditions: string[]): Evidence => ({
      ply,
      sfen: p!.sfen,
      conditions,
    });
    const families = {
      black: familyAt(p!, Color.BLACK, result.sides.black.familyHistory.at(-1)),
      white: familyAt(p!, Color.WHITE, result.sides.white.familyHistory.at(-1)),
    };
    const currentCastles = {
      black: new Set<string>(),
      white: new Set<string>(),
    };
    const add = (
      side: Color,
      rule: { id: string; name: string },
      conditions: string[],
    ) => {
      const output = result.sides[key(side)];
      if (!output.strategies.some(({ id }) => id === rule.id)) {
        output.strategies.push({
          id: rule.id,
          name: rule.name,
          ...evidence(conditions),
        });
        output.strategyStatus = "判定済み";
      }
    };
    const context = (
      side: Color,
      id: (typeof contextualStrategies)[number]["id"],
      conditions: string[],
    ) => {
      add(
        side,
        contextualStrategies.find((rule) => rule.id === id)!,
        conditions,
      );
    };
    for (const side of sides) {
      const output = result.sides[key(side)],
        observed = families[key(side)];
      if (observed && output.family !== observed.family) {
        output.family = observed.family;
        output.familyHistory.push({
          family: observed.family,
          ...evidence(observed.conditions),
        });
      }
      for (const rule of castleRules) {
        if (
          !observed ||
          rule.family !== observed.family ||
          !matches(p!, side, rule)
        )
          continue;
        currentCastles[key(side)].add(rule.id);
        if (!previousCastles[key(side)].has(rule.id)) {
          const parent = output.castles
            .filter(({ id }) => id === rule.parentId)
            .at(-1);
          output.castles.push({
            id: rule.id,
            name: rule.name,
            ...evidence([
              ...observed.conditions,
              ...shapeConditions(p!, side, rule),
            ]),
            ...(rule.parentId ? { parentId: rule.parentId } : {}),
            ...(parent ? { evolvesFromPly: parent.ply } : {}),
          });
          output.castleStatus = "判定済み";
        }
      }
      for (const rule of strategyRules) {
        if (
          observed &&
          rule.family === observed.family &&
          matches(p!, side, rule)
        ) {
          add(side, rule, [
            ...observed.conditions,
            ...shapeConditions(p!, side, rule),
          ]);
        }
      }
      if (observed?.family === "居飛車") {
        for (const [castle, strategy] of [
          ["gold-yagura", "yagura"],
          ["gangi", "gangi"],
        ] as const) {
          if (currentCastles[key(side)].has(castle))
            context(side, strategy, [
              `${castle}の完成形`,
              ...observed.conditions,
            ]);
        }
      }
    }
    const black = families.black?.family,
      white = families.white?.family;
    if (black && white) {
      const relationId =
        black === "居飛車" && white === "居飛車"
          ? "mutual-static"
          : black === "振り飛車" && white === "振り飛車"
            ? "double-ranging"
            : "opposed";
      if (result.relationships.at(-1)?.id !== relationId) {
        const rule = relationshipRules.find(({ id }) => id === relationId)!;
        result.relationships.push({
          ...rule,
          ...evidence([
            `先手${black}・後手${white}`,
            ...families.black!.conditions,
            ...families.white!.conditions,
          ]),
        });
        result.relationshipStatus = "判定済み";
      }
      for (const side of sides) {
        const own = families[key(side)]!,
          opponent = families[key(other(side))]!;
        const relationConditions = [
          ...own.conditions,
          `相手は${opponent.family}`,
        ];
        if (relationId === "double-ranging")
          context(side, "double-ranging", relationConditions);
        if (relationId === "mutual-static") {
          for (const rule of mutualStaticRules) {
            if (matches(p!, side, rule))
              add(side, rule, [
                ...relationConditions,
                ...shapeConditions(p!, side, rule),
              ]);
          }
          if (bishopExchangePly !== null)
            context(side, "bishop-exchange", [
              ...relationConditions,
              `${bishopExchangePly}手目までに初期角位置で角を交換`,
            ]);
          if (
            rookPawnExchange.black &&
            rookPawnExchange.white &&
            has(p!, Color.BLACK, PieceType.BISHOP, 88) &&
            has(p!, Color.WHITE, PieceType.BISHOP, 88)
          ) {
            if (sidePawnPly !== null)
              context(side, "side-pawn", [
                ...relationConditions,
                `双方飛車先交換後、${sidePawnPly}手目に飛車で横歩を取った`,
              ]);
            else if (
              has(p!, Color.BLACK, PieceType.PAWN, 77) &&
              has(p!, Color.WHITE, PieceType.PAWN, 77)
            ) {
              context(side, "double-wing", [
                ...relationConditions,
                "双方飛車先の歩を飛車で交換、双方角道を未開通",
              ]);
            }
          }
        }
        if (own.family === "振り飛車" && bishopExchangePly !== null) {
          context(side, "bishop-exchange-ranging", [
            ...relationConditions,
            `${bishopExchangePly}手目までに初期角位置で角を交換`,
          ]);
        }
        if (own.family === "居飛車" && opponent.family === "振り飛車") {
          if (
            strategyRules.some(
              (rule) =>
                rule.id === "fourth-file-rook" &&
                matches(p!, other(side), rule),
            ) &&
            matches(p!, side, fourthFileAttack)
          ) {
            add(side, fourthFileAttack, [
              ...relationConditions,
              "相手は四間飛車の形",
              ...shapeConditions(p!, side, fourthFileAttack),
            ]);
          }
          // 左美濃は急戦でも使うため、囲いだけで持久戦と推測しない。
          if (currentCastles[key(side)].has("static-anaguma"))
            context(side, "anti-ranging-slow-game", [
              ...relationConditions,
              "居飛車穴熊の完成形",
            ]);
        }
      }
    }
    for (const side of sides)
      previousCastles[key(side)] = currentCastles[key(side)];
  }

  scan(0);
  for (let i = 0; i < moves.length; i++) {
    const move = moves[i]!,
      ply = i + 1;
    const canonical = p.createMoveByUSI(move.usi);
    if (!canonical?.equals(move) || !p.isValidMove(move))
      throw new Error(`${ply}手目は合法手ではありません。`);
    // shortcut: 交換系戦型は序盤32手以内の典型手順のみ。別手順を追加する際は専用の反例テストも足す。
    if (ply <= 32) {
      const destination = relative(
        move.to.file * 10 + move.to.rank,
        move.color,
      );
      if (
        move.pieceType === PieceType.ROOK &&
        move.capturedPieceType === PieceType.PAWN &&
        destination === 24
      ) {
        rookPawnExchange[key(move.color)] = true;
      }
      if (
        move.pieceType === PieceType.ROOK &&
        move.capturedPieceType === PieceType.PAWN &&
        destination === 34 &&
        move.from instanceof Square &&
        relative(move.from.file * 10 + move.from.rank, move.color) === 24 &&
        rookPawnExchange.black &&
        rookPawnExchange.white
      )
        sidePawnPly = ply;
      if (
        pendingBishopCapture &&
        move.to.equals(pendingBishopCapture.to) &&
        (move.capturedPieceType === PieceType.BISHOP ||
          move.capturedPieceType === PieceType.HORSE)
      )
        bishopExchangePly = ply;
      pendingBishopCapture =
        move.pieceType === PieceType.BISHOP &&
        move.capturedPieceType === PieceType.BISHOP &&
        (destination === 22 || destination === 88)
          ? move
          : null;
    }
    if (!p.doMove(move)) throw new Error(`${ply}手目を適用できません。`);
    scan(ply);
  }
  return result;
}
