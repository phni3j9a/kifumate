import Encoding from "encoding-japanese";
import {
  Color,
  exportKIF,
  getBlackPlayerName,
  getWhitePlayerName,
  handPieceTypes,
  importKIF,
  Move,
  Position,
  Record as ShogiRecord,
  RecordMetadataKey,
  SpecialMoveType,
  type ImmutablePosition,
  type PieceType,
  Square,
  stringToNumber,
  stringToPieceType,
} from "tsshogi";

export type Side = "black" | "white" | null;
export type Result = "win" | "loss" | "draw" | "unknown";
export const resultLabels: Record<Result, string> = {
  win: "勝ち",
  loss: "負け",
  draw: "引き分け",
  unknown: "わからない",
};
export const sideLabels = {
  black: "先手",
  white: "後手",
  none: "自分以外・未指定",
};
export const MAX_BYTES = 2 * 1024 * 1024;

export function decodeKif(bytes: Uint8Array): string {
  if (bytes.length > MAX_BYTES)
    throw new Error("ファイルは2MB以内にしてください。");
  const encoding = Encoding.detect(bytes);
  if (!encoding || !["UTF8", "SJIS", "ASCII"].includes(encoding)) {
    throw new Error(
      "文字コードを読めません。UTF-8 または Shift_JIS のKIFを選んでください。",
    );
  }
  const text = Encoding.codeToString(
    Encoding.convert(bytes, { to: "UNICODE", from: encoding }),
  );
  if (text.includes("\ufffd") || text.includes("\0"))
    throw new Error("文字が壊れています。文字コードを確認してください。");
  return text.replace(/^\uFEFF/, "");
}

export function readKif(input: string): ShogiRecord {
  if (input.length > MAX_BYTES) throw new Error("KIFは2MB以内にしてください。");
  return readStoredKif(input);
}

// 正規化によるCRLFやヘッダーの増分を、外部入力用のサイズ上限で拒否しない。
export function readStoredKif(input: string): ShogiRecord {
  if (!input.trim()) throw new Error("KIFの本文を貼り付けてください。");
  const text = input
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(
      /^(\s*\d+\s+[▲△▼▽]?)([1-9])(?=[一二三四五六七八九])/gm,
      (_, prefix: string, n: string) =>
        prefix + "０１２３４５６７８９"[Number(n)],
    );
  if (!/^(?:\s*\d+\s+|手合割[：:]|手数[―ー\-\s]|\|)/m.test(text)) {
    throw new Error(
      "KIFの指し手や開始局面が見つかりません。KIF形式の本文を確認してください。",
    );
  }
  const handicap = text.match(/^手合割[：:]\s*(.+)/m)?.[1]?.trim();
  if (
    handicap &&
    ![
      "平手",
      "香落ち",
      "右香落ち",
      "角落ち",
      "飛車落ち",
      "飛香落ち",
      "二枚落ち",
      "四枚落ち",
      "六枚落ち",
      "八枚落ち",
      "十枚落ち",
      "その他",
    ].includes(handicap)
  ) {
    throw new Error(
      "手合割を読めません。平手・駒落ち、または盤面図で指定してください。",
    );
  }
  validateDiagram(text);
  const rows = [...text.matchAll(/^\s*(\d+)\s+(.+)$/gm)];
  if (rows.length > 10000)
    throw new Error("指し手が多すぎます（上限10000手）。");
  let last = 0;
  let branch = false;
  for (const line of text.split("\n")) {
    if (/^\s*\d+\s*$/.test(line))
      throw new Error(
        "指し手が途中で途切れています。KIFの全文を確認してください。",
      );
    if (/^変化[：:]\s*\d+手/.test(line)) branch = true;
    const n = line.match(/^\s*(\d+)\s+/);
    if (!n) continue;
    const ply = Number(n[1]);
    if (ply !== last + 1 && !(branch && ply >= 1 && ply <= last + 1)) {
      throw new Error(
        `${ply}手目：手数が連続していません。途中が欠けていないか確認してください。`,
      );
    }
    last = ply;
    branch = false;
  }
  // 不成は入力の意味を別途検証し、パーサーへは成らない手として渡す。
  const parserText = text
    .split("\n")
    .map((line) =>
      MOVE_NOTATION.exec(line)?.[4] === "不成"
        ? line.replace("不成", "")
        : line,
    )
    .join("\n");
  const record = importKIF(parserText);
  if (record instanceof Error)
    throw new Error(
      `KIFを読めません。指し手・駒・座標を確認してください（${record.message}）。`,
    );
  let count = 0;
  record.forEach((node) => {
    if (!node.prev) return;
    count++;
    if (!(node.move instanceof Move) && node.move.type === "any") {
      throw new Error(
        `${node.ply}手目「${node.displayText}」を読めません。指し手または終局理由を確認してください。`,
      );
    }
    if (node.move instanceof Move) {
      const p = Position.newBySFEN(node.prev.sfen);
      if (!p?.isValidMove(node.move))
        throw new Error(
          `${node.ply}手目「${node.displayText}」は合法手ではありません。`,
        );
    }
  });
  if (count !== rows.length)
    throw new Error(
      "読み取れない指し手があります。手数と指し手の書式を確認してください。",
    );
  validateMoveNotation(record, rows);
  record.goto(0);
  record.resetAllBranchSelection();
  return record;
}

const MOVE_NOTATION =
  /^ *([0-9]+) +[▲△▼▽]?([１２３４５６７８９][一二三四五六七八九]|同\u3000*)(成香|成桂|成銀|[王玉飛龍竜角馬金銀全桂圭香杏歩と])\u3000*(不成|成)?(打|\([1-9][1-9]\))/;

function validateDiagram(text: string): void {
  const lines = text.split("\n");
  const rows = lines.filter((line) => line.trimStart().startsWith("|"));
  if (!rows.length && !/^\+-+\+[ \t]*$/m.test(text)) return;
  const ranks = new Set<number>();
  for (const row of rows) {
    const match = row.match(
      /^\|(.{18})\|([一二三四五六七八九1-9１-９])[ \t]*$/,
    );
    if (!match || ranks.has(stringToNumber(match[2]!))) {
      throw new Error(
        "盤面図のマスや段の書き方が正しくありません。各段を重複なく指定してください。",
      );
    }
    const cells = match[1]!;
    for (let i = 0; i < 18; i += 2) {
      const side = cells[i],
        piece = cells[i + 1]!;
      if (side === " " && piece === "・") continue;
      if ((side !== " " && side !== "v") || !stringToPieceType(piece)) {
        throw new Error(
          "盤面図に読めない駒や向きがあります。空きマスは「 ・」で指定してください。",
        );
      }
    }
    ranks.add(stringToNumber(match[2]!));
  }
  if (rows.length !== 9 || ranks.size !== 9) {
    throw new Error(
      "盤面図は一段目から九段目まで、9段すべてを指定してください。",
    );
  }
}

function validateMoveNotation(
  record: ShogiRecord,
  rows: RegExpMatchArray[],
): void {
  // 入力順に分岐を選び直す。主変化だけでなく、それぞれの移動元の駒を照合する。
  for (const row of rows) {
    const notation = MOVE_NOTATION.exec(row[0]);
    if (!notation) continue;
    const [, ply, destination, piece, promotion, origin] = notation;
    record.goto(Number(ply) - 1);
    const previous = record.current.move;
    const to = destination!.startsWith("同")
      ? previous instanceof Move
        ? previous.to
        : null
      : new Square(
          stringToNumber(destination![0]!),
          stringToNumber(destination![1]!),
        );
    const kind = stringToPieceType(piece!);
    const from =
      origin === "打"
        ? kind
        : new Square(Number(origin![1]), Number(origin![2]));
    const move = to && record.position.createMove(from, to);
    if (
      !move ||
      move.pieceType !== kind ||
      (origin === "打" && !handPieceTypes.includes(kind)) ||
      (promotion === "不成" && !record.position.isValidMove(move.withPromote()))
    ) {
      throw new Error(
        `${ply}手目の駒の種類や成・不成の表記が、局面と一致しません。`,
      );
    }
    if (!record.append(promotion === "成" ? move.withPromote() : move)) {
      throw new Error(
        `${ply}手目の駒の移動・成・不成・打が、合法手ではありません。`,
      );
    }
  }
}

export function identity(record: ShogiRecord): string {
  record.resetAllBranchSelection();
  return JSON.stringify([
    record.initialPosition.sfen.split(" ").slice(0, 3).join(" "),
    record.moves
      .filter((n) => n.move instanceof Move)
      .map((n) => (n.move as Move).usi),
  ]);
}

export function normalizeName(name: string): string {
  return name.normalize("NFKC").trim().toLocaleLowerCase("ja");
}
export function matchNames(
  black: string,
  white: string,
  names: string[],
): { side: Side; ambiguous: boolean } {
  const registered = new Set(names.map(normalizeName).filter(Boolean));
  const b = registered.has(normalizeName(black));
  const w = registered.has(normalizeName(white));
  return { side: b === w ? null : b ? "black" : "white", ambiguous: b && w };
}

export function gameOutcome(record: ShogiRecord): Side | "draw" {
  const nodes = record.moves;
  const end = nodes[nodes.length - 1];
  if (!end || end.move instanceof Move) return null;
  const type = end.move.type;
  if (
    [
      SpecialMoveType.REPETITION_DRAW,
      SpecialMoveType.DRAW,
      SpecialMoveType.IMPASS,
      SpecialMoveType.MAX_MOVES,
    ].includes(type as SpecialMoveType)
  )
    return "draw";
  const loses = [
    SpecialMoveType.RESIGN,
    SpecialMoveType.MATE,
    SpecialMoveType.TIMEOUT,
    SpecialMoveType.FOUL_LOSE,
    SpecialMoveType.LOSE_BY_DEFAULT,
  ];
  const wins = [
    SpecialMoveType.ENTERING_OF_KING,
    SpecialMoveType.FOUL_WIN,
    SpecialMoveType.WIN_BY_DEFAULT,
    SpecialMoveType.TRY,
  ];
  const turn = end.prev?.nextColor;
  if (turn === undefined) return null;
  const winner = loses.includes(type as SpecialMoveType)
    ? turn === Color.BLACK
      ? Color.WHITE
      : Color.BLACK
    : wins.includes(type as SpecialMoveType)
      ? turn
      : null;
  return winner === null ? null : winner === Color.BLACK ? "black" : "white";
}
export function resultFor(side: Side, outcome: Side | "draw"): Result {
  return !side
    ? "unknown"
    : outcome === "draw"
      ? "draw"
      : !outcome
        ? "unknown"
        : outcome === side
          ? "win"
          : "loss";
}
export function describe(record: ShogiRecord) {
  return {
    black: getBlackPlayerName(record.metadata) || "先手（名前なし）",
    white: getWhitePlayerName(record.metadata) || "後手（名前なし）",
    date:
      record.metadata.getStandardMetadata(RecordMetadataKey.START_DATETIME) ||
      record.metadata.getStandardMetadata(RecordMetadataKey.DATE) ||
      "",
    plies: record.moves.filter((n) => n.move instanceof Move).length,
  };
}
export function writeKif(record: ShogiRecord): string {
  return exportKIF(record, { returnCode: "\r\n" });
}

export function legalMoves(
  position: ImmutablePosition,
  from: Square | PieceType,
): Move[] {
  return Square.all.flatMap((to) => {
    const move = position.createMove(from, to);
    return move
      ? [move, move.withPromote()].filter(
          (m, i) => (i === 0 || m.usi !== move.usi) && position.isValidMove(m),
        )
      : [];
  });
}

// 分岐は本譜と独立した局面だけを持ち、永続化しない。
export class Branch {
  readonly positions: Position[];
  readonly moves: Move[] = [];
  at = 0;
  constructor(
    readonly base: number,
    position: ImmutablePosition,
  ) {
    this.positions = [position.clone()];
  }
  get position(): Position {
    return this.positions[this.at]!;
  }
  play(move: Move): void {
    const next = this.position.clone();
    if (!next.doMove(move))
      throw new Error("この手は指せません。合法手を選んでください。");
    this.positions.length = this.at + 1;
    this.moves.length = this.at;
    this.moves.push(move);
    this.positions.push(next);
    this.at++;
  }
  step(at: number): void {
    this.at = Math.max(0, Math.min(this.moves.length, at));
  }
}
