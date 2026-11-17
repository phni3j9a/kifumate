// 将来の解析・分類・解説は games.id を参照するテーブルをマイグレーションで追加する。
// 棋譜の削除でいっしょに消えるよう、必ず `REFERENCES games(id) ON DELETE CASCADE` を付ける
// （外部キーは migrate() が接続ごとに有効にしている）。
export const migrations = [
  String.raw`
CREATE TABLE games (
  id TEXT PRIMARY KEY NOT NULL,
  identity TEXT NOT NULL UNIQUE,
  kif TEXT NOT NULL,
  black TEXT NOT NULL,
  white TEXT NOT NULL,
  played_at TEXT NOT NULL,
  plies INTEGER NOT NULL,
  self_side TEXT CHECK(self_side IN ('black','white') OR self_side IS NULL),
  result TEXT NOT NULL CHECK(result IN ('win','loss','draw','unknown')),
  side_manual INTEGER NOT NULL DEFAULT 0,
  result_manual INTEGER NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE aliases (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  normalized TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX games_played_at ON games(played_at DESC);
`,
];

export interface MigrationDatabase {
  execAsync(sql: string): Promise<void>;
  getFirstAsync<T>(sql: string): Promise<T | null>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}
export async function migrate(db: MigrationDatabase): Promise<void> {
  await db.execAsync("PRAGMA foreign_keys = ON;");
  const version =
    (await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version;"))
      ?.user_version ?? 0;
  if (version > migrations.length)
    throw new Error(
      "新しい版で保存されたデータです。アプリを更新してください。",
    );
  await db.withTransactionAsync(async () => {
    for (let i = version; i < migrations.length; i++) {
      await db.execAsync(migrations[i]!);
      await db.execAsync(`PRAGMA user_version = ${i + 1};`);
    }
  });
}
