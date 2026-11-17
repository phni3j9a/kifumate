import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SQLiteDatabase } from "expo-sqlite";
import { migrate } from "../../src/storage/schema";

// expo-sqlite の非同期APIを node:sqlite で置き換えた、移行済みのメモリ上のDB。
export async function database() {
  const sql = new DatabaseSync(":memory:");
  const adapter = {
    async execAsync(query: string) {
      sql.exec(query);
    },
    async getFirstAsync<T>(query: string, ...params: SQLInputValue[]) {
      return (sql.prepare(query).get(...params) as T) ?? null;
    },
    async getAllAsync<T>(query: string, ...params: SQLInputValue[]) {
      return sql.prepare(query).all(...params) as T[];
    },
    async runAsync(query: string, ...params: SQLInputValue[]) {
      return sql.prepare(query).run(...params);
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
  await migrate(adapter);
  return { sql, db: adapter as unknown as SQLiteDatabase };
}
