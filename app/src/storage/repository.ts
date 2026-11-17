import { randomUUID } from "expo-crypto";
import type { SQLiteDatabase } from "expo-sqlite";
import type { Record as ShogiRecord } from "tsshogi";
import {
  describe,
  gameOutcome,
  identity,
  matchNames,
  normalizeName,
  readKif,
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
  favorite: number;
}
export interface Alias {
  id: string;
  name: string;
}
export const listGames = (db: SQLiteDatabase) =>
  db.getAllAsync<Game>(
    "SELECT * FROM games ORDER BY played_at DESC, created_at DESC",
  );
export const listAliases = (db: SQLiteDatabase) =>
  db.getAllAsync<Alias>("SELECT id, name FROM aliases ORDER BY created_at");
export async function importGame(
  db: SQLiteDatabase,
  record: ShogiRecord,
  side: Side,
  result: Result,
  sideManual: boolean,
  resultManual: boolean,
): Promise<{ id: string; duplicate: boolean }> {
  const key = identity(record);
  const duplicate = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM games WHERE identity = ?",
    key,
  );
  if (duplicate) return { id: duplicate.id, duplicate: true };
  const id = randomUUID(),
    now = new Date().toISOString(),
    info = describe(record);
  await db.runAsync(
    `INSERT INTO games (id, identity, kif, black, white, played_at, plies, self_side, result, side_manual, result_manual, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    key,
    writeKif(record),
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
  return { id, duplicate: false };
}
export async function updateInfo(
  db: SQLiteDatabase,
  id: string,
  side: Side,
  result: Result,
) {
  await db.runAsync(
    "UPDATE games SET self_side=?, result=?, side_manual=1, result_manual=1, updated_at=? WHERE id=?",
    side,
    result,
    new Date().toISOString(),
    id,
  );
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
      const result = game.result_manual
        ? game.result
        : resultFor(side, gameOutcome(readKif(game.kif)));
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
