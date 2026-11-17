import type { SQLiteDatabase } from "expo-sqlite";
import type { Saved } from "../analysis/types";
import sample from "../assets/sample-game.json";
import { describe, identity, readStoredKif } from "../core/kif";
import { classifyForStorage, saveAutomatic } from "./classifications";
/** 同梱した結果だけを登録する。通信・解析依頼・利用回数の更新は行わない。 */
export async function addSampleGame(db: SQLiteDatabase, uuid: () => string) {
  const record = readStoredKif(sample.kif),
    key = identity(record);
  const duplicate = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM games WHERE identity=?",
    key,
  );
  if (duplicate) return duplicate.id;
  const id = uuid(),
    now = new Date().toISOString(),
    info = describe(record),
    classification = await classifyForStorage(record);
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      "INSERT INTO games (id,identity,kif,black,white,played_at,plies,self_side,result,side_manual,is_sample,created_at,updated_at) VALUES (?,?,?,?,?,?,?,NULL,'unknown',1,1,?,?)",
      id,
      key,
      sample.kif,
      info.black,
      info.white,
      info.date,
      info.plies,
      now,
      now,
    );
    await saveAutomatic(db, id, classification);
    await db.runAsync(
      "INSERT INTO analyses VALUES (?,?)",
      id,
      JSON.stringify({
        gameId: id,
        attempt: null,
        saved: sample.saved as Saved,
        error: null,
      }),
    );
  });
  return id;
}
