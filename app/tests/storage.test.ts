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
