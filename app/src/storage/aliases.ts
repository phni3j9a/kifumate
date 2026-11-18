import type { SQLiteDatabase } from "expo-sqlite";
import { gameOutcome, matchNames, readStoredKif, resultFor } from "../core/kif";
import type { Game } from "./repository";

// 名前の編集とバックアップ統合で、同じ自動判定を使う。呼出元のトランザクション内で実行する。
export async function reconcileAliases(db: SQLiteDatabase, names: string[]) {
  let after = "";
  while (true) {
    const game = await db.getFirstAsync<Game>(
      "SELECT id,kif,black,white,self_side,result,side_manual,result_manual,winner FROM games WHERE id>? ORDER BY id LIMIT 1",
      after,
    );
    if (!game) break;
    after = game.id;
    const side = game.side_manual
      ? game.self_side
      : matchNames(game.black, game.white, names).side;
    const winner = game.result_manual
      ? null
      : (game.winner ?? gameOutcome(readStoredKif(game.kif)));
    const result = game.result_manual
      ? game.result
      : resultFor(side, winner === "unknown" ? null : winner);
    if (side !== game.self_side || result !== game.result)
      await db.runAsync(
        "UPDATE games SET self_side=?, result=?, updated_at=? WHERE id=?",
        side,
        result,
        new Date().toISOString(),
        game.id,
      );
  }
}
