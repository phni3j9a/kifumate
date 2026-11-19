import assert from "node:assert/strict";
import { test } from "node:test";
import { claimFirstReview, firstReviewKey } from "../src/analysis/first-review";
import { ensureVisibleY } from "../src/core/scroll";
import { database } from "./helpers/database";

test("棋譜の現在手が見えていれば維持し、はみ出す側だけ40pxの余白を取る", () => {
  assert.equal(ensureVisibleY(110, 36, 80, 224), 80);
  assert.equal(ensureVisibleY(70, 36, 80, 224), 30);
  assert.equal(ensureVisibleY(282, 36, 80, 224), 134);
  assert.equal(ensureVisibleY(2, 36, 0, 224), 0);
});

test("初回の解析完了案内は端末設定で1回だけ取得できる", async () => {
  const { db, sql } = await database();
  assert.deepEqual(
    await Promise.all([claimFirstReview(db), claimFirstReview(db)]),
    [true, false],
  );
  assert.equal(
    (
      await db.getFirstAsync<{ value: string }>(
        "SELECT value FROM settings WHERE key=?",
        firstReviewKey,
      )
    )?.value,
    "true",
  );
  sql.close();
});
