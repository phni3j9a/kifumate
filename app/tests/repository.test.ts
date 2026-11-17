import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Record as ShogiRecord } from "tsshogi";
import * as kif from "../src/core/kif";
import type * as Repository from "../src/storage/repository";
import { database } from "./helpers/database";
import { loadWithMocks } from "./helpers/load-with-mocks";

const repository = loadWithMocks<typeof Repository>(
  "src/storage/repository.ts",
  {
    "expo-crypto": { randomUUID },
    "../core/kif": kif,
  },
);
test("上限内の入力がCRLF正規化で拡大しても保存・再照合できる", async () => {
  const { sql, db } = await database();
  try {
    const prefix =
      "手合割：平手\n先手：自分\n後手：相手\n1 ７六歩(77)\n" +
      "*x\n".repeat(1000) +
      "*";
    const input =
      prefix + "a".repeat(kif.MAX_BYTES - Buffer.byteLength(prefix) - 1) + "\n";
    assert.equal(Buffer.byteLength(input), kif.MAX_BYTES);
    const record = kif.readKif(input);
    const saved = await repository.importGame(
      db,
      record,
      null,
      "unknown",
      false,
      false,
    );
    const game = (await repository.listGames(db))[0]!;
    assert(game.kif.length > kif.MAX_BYTES);
    assert.throws(() => kif.readKif(game.kif), /2MB/);
    assert.equal(
      kif.identity(kif.readStoredKif(game.kif)),
      kif.identity(record),
    );
    await repository.saveAliases(db, ["自分"]);
    const matched = (await repository.listGames(db))[0]!;
    assert.equal(matched.self_side, "black");
    assert.equal(matched.id, saved.id);
  } finally {
    sql.close();
  }
});
test("正規化後に読み直せない棋譜はINSERT前に拒否する", async () => {
  const { sql, db } = await database();
  try {
    const record = new ShogiRecord();
    record.append(record.position.createMoveByUSI("7g7e")!, {
      ignoreValidation: true,
    });
    await assert.rejects(
      repository.importGame(db, record, null, "unknown", false, false),
    );
    assert.equal((await repository.listGames(db)).length, 0);
  } finally {
    sql.close();
  }
});
test("削除は指定の棋譜だけを消し、games.id を参照する行も CASCADE で消える", async () => {
  const { sql, db } = await database();
  try {
    // 将来の解析結果などのテーブルを模して、外部キーが効いていることを確かめる
    sql.exec(
      "CREATE TABLE analyses (game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE)",
    );
    const save = (moves: string) =>
      repository.importGame(
        db,
        kif.readKif(`手合割：平手\n${moves}`),
        null,
        "unknown",
        false,
        false,
      );
    const a = await save("1 ７六歩(77)\n"),
      b = await save("1 ２六歩(27)\n");
    for (const id of [a.id, b.id])
      sql.prepare("INSERT INTO analyses VALUES (?)").run(id);
    await repository.deleteGame(db, a.id);
    assert.deepEqual(
      (await repository.listGames(db)).map((g) => g.id),
      [b.id],
    );
    assert.deepEqual(
      sql
        .prepare("SELECT game_id FROM analyses")
        .all()
        .map((r) => r.game_id),
      [b.id],
    );
  } finally {
    sql.close();
  }
});
