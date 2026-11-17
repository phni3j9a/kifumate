import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate, migrations } from "../src/storage/schema";
function database() {
  const sql = new DatabaseSync(":memory:");
  const adapter = {
    async execAsync(source: string) {
      sql.exec(source);
    },
    async getFirstAsync<T>(source: string) {
      return (sql.prepare(source).get() as T) ?? null;
    },
    async withTransactionAsync(task: () => Promise<void>) {
      sql.exec("BEGIN");
      try {
        await task();
        sql.exec("COMMIT");
      } catch (e) {
        sql.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { sql, adapter };
}
test("新規DBを作成し、再起動で同じマイグレーションを繰り返さない", async () => {
  const { sql, adapter } = database();
  await migrate(adapter);
  await migrate(adapter);
  assert.equal(
    sql.prepare("PRAGMA user_version").get()?.user_version,
    migrations.length,
  );
  const columns = sql
    .prepare("PRAGMA table_info(games)")
    .all()
    .map((c) => c.name);
  for (const name of [
    "id",
    "identity",
    "kif",
    "side_manual",
    "result_manual",
    "updated_at",
  ])
    assert(columns.includes(name));
  sql.close();
});
test("未来のDBを古いアプリで壊さない", async () => {
  const { sql, adapter } = database();
  sql.exec("PRAGMA user_version=999");
  await assert.rejects(migrate(adapter), /アプリを更新/);
  assert.equal(sql.prepare("PRAGMA user_version").get()?.user_version, 999);
  sql.close();
});
test("失敗した移行はバージョンと作成テーブルをロールバック", async () => {
  const { sql, adapter } = database();
  const original = adapter.execAsync;
  adapter.execAsync = async (source) => {
    await original(source);
    if (source.startsWith("PRAGMA user_version ="))
      throw new Error("失敗を再現");
  };
  await assert.rejects(migrate(adapter), /失敗を再現/);
  assert.equal(sql.prepare("PRAGMA user_version").get()?.user_version, 0);
  assert.equal(
    sql
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='games'")
      .get()?.n,
    0,
  );
  sql.close();
});
test("2版目の移行で、手で直した結果を勝った側として引き継ぐ", async () => {
  const { sql, adapter } = database();
  sql.exec(migrations[0]!);
  sql.exec("PRAGMA user_version = 1");
  const insert = sql.prepare(
    `INSERT INTO games (id, identity, kif, black, white, played_at, plies, self_side, result, side_manual, result_manual, created_at, updated_at)
    VALUES (?, ?, '', '', '', '', 0, ?, ?, 1, ?, '', '')`,
  );
  for (const [id, side, result, manual] of [
    ["a", "black", "win", 1],
    ["b", "white", "win", 1],
    ["c", "black", "loss", 1],
    ["d", "white", "draw", 1],
    ["e", "black", "unknown", 1],
    ["f", "black", "loss", 0], // 棋譜どおり
    ["g", null, "unknown", 1], // 先後が分からないので引き継げない
  ] as const)
    insert.run(id, id, side, result, manual);
  await migrate(adapter);
  assert.deepEqual(
    sql
      .prepare("SELECT id, winner, result FROM games ORDER BY id")
      .all()
      .map((r) => [r.id, r.winner, r.result]),
    [
      ["a", "black", "win"],
      ["b", "white", "win"],
      ["c", "white", "loss"],
      ["d", "draw", "draw"],
      ["e", "unknown", "unknown"],
      ["f", null, "loss"],
      ["g", null, "unknown"],
    ],
  );
  sql.close();
});
