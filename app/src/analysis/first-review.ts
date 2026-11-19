import type { SQLiteDatabase } from "expo-sqlite";

export const firstReviewKey = "analysisFirstReviewSeen";

export async function claimFirstReview(db: Pick<SQLiteDatabase, "runAsync">) {
  const { changes } = await db.runAsync(
    "INSERT OR IGNORE INTO settings VALUES (?, 'true')",
    firstReviewKey,
  );
  return changes === 1;
}
