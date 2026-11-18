import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { database } from "./helpers/database";
import { loadWithMocks } from "./helpers/load-with-mocks";
import * as kif from "../src/core/kif";
import * as backup from "../src/storage/backup";
import { addSampleGame } from "../src/storage/sample";

test("大きすぎるKIFは同期パーサーを呼び出す前に拒否する", async () => {
  const { db, sql } = await database();
  try {
    await addSampleGame(db, randomUUID);
    let data = "";
    for await (const line of backup.exportBackup(db)) data += line;
    const lines = data.trimEnd().split("\n");
    const row = JSON.parse(lines[2]!);
    row.game.kif = "\n".repeat(4 * 1024 * 1024 + 65537);
    lines[2] = JSON.stringify(row);
    let called = false;
    const api = loadWithMocks<typeof backup>("src/storage/backup.ts", {
      "../core/kif": {
        ...kif,
        readStoredKif: (s: string) => {
          called = true;
          return kif.readStoredKif(s);
        },
      },
    });
    async function* input() {
      yield* lines;
    }
    await assert.rejects(api.prepareBackup(db, input()), /バックアップ/);
    assert.equal(called, false);
  } finally {
    sql.close();
  }
});
