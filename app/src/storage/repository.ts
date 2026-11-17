import {
  classificationSelect,
  classifyForStorage,
  saveAutomatic,
} from "./classifications";
import { randomUUID } from "expo-crypto";
import type { SQLiteDatabase } from "expo-sqlite";
import type { Record as ShogiRecord } from "tsshogi";
import {
  describe,
  gameOutcome,
  identity,
  matchNames,
  normalizeName,
  readStoredKif,
  resultFor,
  writeKif,
  type Result,
  type Side,
} from "../core/kif";

export interface Game {
  id: string;
  kif: string;
  black: string;
  white: string;
  played_at: string;
  plies: number;
  self_side: Side;
  result: Result;
  side_manual: number;
  result_manual: number;
  /** 手で直した勝ち側。NULL は棋譜の結果どおり */
  winner: Winner | null;
  favorite: number;
  classification_auto?: string | null;
  classification_manual?: string | null;
  classification_error?: string | null;
}
export type Winner = "black" | "white" | "draw" | "unknown";
// 先後 side と勝ち側 w（SQL の式）から、自分から見た結果を出す SQL。resultFor と同じ規則。
const resultSql = (side: string, w: string) =>
  `CASE WHEN ${side} IS NULL THEN 'unknown' WHEN ${w}='draw' THEN 'draw' WHEN ${w}=${side} THEN 'win' WHEN ${w} IN ('black','white') THEN 'loss' ELSE 'unknown' END`;
export interface Alias {
  id: string;
  name: string;
}
export const listGames = (db: SQLiteDatabase) =>
  db.getAllAsync<Game>(
    `${classificationSelect} ORDER BY played_at DESC, created_at DESC`,
  );
export const getGame = (db: SQLiteDatabase, id: string) =>
  db.getFirstAsync<Game>(`${classificationSelect} WHERE games.id=?`, id);
export const listAliases = (db: SQLiteDatabase) =>
  db.getAllAsync<Alias>("SELECT id, name FROM aliases ORDER BY created_at");
/** 同じ開始局面・同じ指し手の棋譜がすでにあれば、その id */
export async function findDuplicate(
  db: SQLiteDatabase,
  record: ShogiRecord,
): Promise<string | null> {
  const found = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM games WHERE identity = ?",
    identity(record),
  );
  return found?.id ?? null;
}
export async function importGame(
  db: SQLiteDatabase,
  record: ShogiRecord,
  side: Side,
  result: Result,
  sideManual: boolean,
  resultManual: boolean,
): Promise<{ id: string; duplicate: boolean }> {
  const key = identity(record);
  const duplicate = await findDuplicate(db, record);
  if (duplicate) return { id: duplicate, duplicate: true };
  const storedKif = writeKif(record);
  readStoredKif(storedKif);
  const id = randomUUID(),
    now = new Date().toISOString(),
    info = describe(record);
  const classification = await classifyForStorage(record);
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT INTO games (id, identity, kif, black, white, played_at, plies, self_side, result, side_manual, result_manual, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      key,
      storedKif,
      info.black,
      info.white,
      info.date,
      info.plies,
      side,
      result,
      +sideManual,
      +resultManual,
      now,
      now,
    );
    await saveAutomatic(db, id, classification);
  });
  return { id, duplicate: false };
}
// 先後と勝ち側は別々に直す。どちらも1つの UPDATE で今の行のもう一方と合わせて result を決め直すので、
// 続けて操作しても、古い画面の値で先の変更を上書きしない。
export async function setSelfSide(db: SQLiteDatabase, id: string, side: Side) {
  const row = await db.getFirstAsync<{ kif: string }>(
    "SELECT kif FROM games WHERE id=?",
    id,
  );
  if (!row) return;
  await db.runAsync(
    `UPDATE games SET self_side=?1, side_manual=1, result=${resultSql("?1", "COALESCE(winner, ?2)")}, updated_at=?3 WHERE id=?4`,
    side,
    gameOutcome(readStoredKif(row.kif)),
    new Date().toISOString(),
    id,
  );
}
export async function setWinner(
  db: SQLiteDatabase,
  id: string,
  winner: Winner,
) {
  await db.runAsync(
    `UPDATE games SET winner=?1, result_manual=1, result=${resultSql("self_side", "?1")}, updated_at=?2 WHERE id=?3`,
    winner,
    new Date().toISOString(),
    id,
  );
}
// 元に戻せない。games.id を参照する行（解析結果・分類・解説など）は ON DELETE CASCADE でいっしょに消える。
export async function deleteGame(db: SQLiteDatabase, id: string) {
  await db.runAsync("DELETE FROM games WHERE id=?", id);
}
export async function toggleFavorite(db: SQLiteDatabase, game: Game) {
  await db.runAsync(
    "UPDATE games SET favorite=1-favorite, updated_at=? WHERE id=?",
    new Date().toISOString(),
    game.id,
  );
}
export async function saveAliases(db: SQLiteDatabase, names: string[]) {
  const unique = new Map(names.map((n) => [normalizeName(n), n.trim()]));
  unique.delete("");
  await db.withTransactionAsync(async () => {
    const old = await listAliases(db);
    await db.runAsync("DELETE FROM aliases");
    for (const [normalized, name] of unique) {
      const id =
        old.find((a) => normalizeName(a.name) === normalized)?.id ||
        randomUUID();
      await db.runAsync(
        "INSERT INTO aliases (id,name,normalized,created_at) VALUES (?,?,?,?)",
        id,
        name,
        normalized,
        new Date().toISOString(),
      );
    }
    for (const game of await listGames(db)) {
      const side = game.side_manual
        ? game.self_side
        : matchNames(game.black, game.white, [...unique.values()]).side;
      const result = resultFor(
        side,
        !game.winner
          ? gameOutcome(readStoredKif(game.kif))
          : game.winner === "unknown"
            ? null
            : game.winner,
      );
      await db.runAsync(
        "UPDATE games SET self_side=?, result=?, updated_at=? WHERE id=?",
        side,
        result,
        new Date().toISOString(),
        game.id,
      );
    }
  });
}
