import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { database } from "./helpers/database";
import {
  exportBackup,
  prepareBackup,
  restoreBackup,
  textLines,
} from "../src/storage/backup";
import { addSampleGame } from "../src/storage/sample";
import { defaultProfile } from "../src/coach/types";
import { tally } from "../src/core/stats";
import { migrate, migrations } from "../src/storage/schema";
import type { SQLiteDatabase } from "expo-sqlite";
const text = async (db: SQLiteDatabase) => {
  let s = "";
  for await (const line of exportBackup(db)) s += line;
  return s;
};
async function* chunks(s: string) {
  for (let i = 0; i < s.length; i += 97) yield s.slice(i, i + 97);
}
const prepare = (db: SQLiteDatabase, s: string) =>
  prepareBackup(db, textLines(chunks(s)));
async function seed(db: SQLiteDatabase) {
  const id = await addSampleGame(db, randomUUID);
  await db.runAsync(
    "UPDATE games SET self_side='white',side_manual=1,result='loss',result_manual=1,winner='black',favorite=1,is_sample=0 WHERE id=?",
    id,
  );
  await db.runAsync(
    "UPDATE classifications SET manual=? WHERE game_id=?",
    JSON.stringify({
      white: {
        family: "居飛車",
        strategies: [],
        castles: ["mino", "high-mino"],
      },
    }),
    id,
  );
  const a = await db.getFirstAsync<{ document: string }>(
    "SELECT document FROM analyses WHERE game_id=?",
    id,
  );
  const doc = JSON.parse(a!.document);
  doc.saved.coachProof = {
    version: 1,
    signature: "検証署名",
    device: "移動前の端末",
  };
  await db.runAsync(
    "UPDATE analyses SET document=? WHERE game_id=?",
    JSON.stringify(doc),
    id,
  );
  await db.runAsync(
    "INSERT INTO coaches VALUES (?,?)",
    id,
    JSON.stringify({
      gameId: id,
      answers: [
        {
          requestId: "保存回答",
          question: "何を練習する？",
          style: defaultProfile.style,
          sections: [
            {
              kind: "advice",
              title: "次の練習",
              text: "終盤を振り返りましょう",
              references: [],
            },
          ],
        },
      ],
      attempt: null,
      error: null,
    }),
  );
  await db.runAsync(
    "INSERT INTO aliases VALUES (?,?,?,?)",
    randomUUID(),
    "つばめ",
    "つばめ",
    "2026-11-18",
  );
  await db.runAsync(
    "INSERT INTO coach_meta VALUES ('profile',?)",
    JSON.stringify({
      ...defaultProfile,
      practice: ["矢倉"],
      goal: "初段になる",
    }),
  );
  await db.runAsync(
    "INSERT INTO settings VALUES ('onboardingCompleted','true') ON CONFLICT(key) DO NOTHING",
  );
  await db.runAsync(
    "INSERT INTO analysis_meta VALUES ('quota',?)",
    JSON.stringify({ paid: true, token: "端末トークンではなく除外の確認値" }),
  );
  await db.runAsync(
    "INSERT INTO coach_meta VALUES ('overview',?)",
    JSON.stringify({ paid: true, invite: "招待権利", purchase: "購入情報" }),
  );
  return id;
}
const dump = (sql: any, table: string) =>
  sql
    .prepare(`SELECT * FROM ${table} ORDER BY 1`)
    .all()
    .map((r: any) => ({
      ...r,
      ...(r.document ? { document: JSON.parse(r.document) } : {}),
    }));
test("全対象の往復：署名・手動の先後/結果/分類・回答/質問・名前・プロフィール・設定が空DBで一致", async () => {
  const source = await database(),
    target = await database();
  try {
    await seed(source.db);
    const backup = await text(source.db),
      p = await prepare(target.db, backup);
    assert.equal(p.games, 1);
    assert.equal(p.duplicates, 0);
    await restoreBackup(target.db, p, "replace", randomUUID);
    for (const table of [
      "games",
      "analyses",
      "classifications",
      "coaches",
      "settings",
    ])
      assert.deepEqual(dump(target.sql, table), dump(source.sql, table), table);
    assert.deepEqual(
      dump(target.sql, "aliases").map(({ id, ...r }: any) => ({
        ...r,
        created_at: "",
      })),
      dump(source.sql, "aliases").map(({ id, ...r }: any) => ({
        ...r,
        created_at: "",
      })),
    );
    assert.deepEqual(
      dump(target.sql, "coach_meta"),
      dump(source.sql, "coach_meta").filter((r: any) => r.key === "profile"),
    );
    assert.equal(dump(target.sql, "analysis_meta").length, 0);
    assert(
      !backup.includes("購入情報") &&
        !backup.includes("招待権利") &&
        !backup.includes("端末トークン"),
    );
    await migrate(target.db);
    assert.equal(
      target.sql.prepare("PRAGMA user_version").get()!.user_version,
      migrations.length,
    );
  } finally {
    source.sql.close();
    target.sql.close();
  }
});
test("壊れたJSON・切れた末尾・不正棋譜・子文書・不正プロフィールを拒否して既存を保持", async () => {
  const s = await database();
  try {
    await seed(s.db);
    const original = dump(s.sql, "games"),
      backup = await text(s.db),
      lines = backup.trimEnd().split("\n");
    const corrupt = [
      "{",
      lines.slice(0, -1).join("\n"),
      backup.replace('"ply":0', '"ply":-1'),
      backup.replace('"goal":"初段になる"', '"goal":42'),
      backup.replace("７六歩", "７五歩"),
      backup.replace('"candidates":[', '"candidates":null,"bad":['),
    ];
    for (const bad of corrupt) {
      await assert.rejects(prepare(s.db, bad), /壊れている/);
      assert.deepEqual(dump(s.sql, "games"), original);
    }
  } finally {
    s.sql.close();
  }
});
test("新しすぎる形式版・DB版と未対応の旧版を区別し、読み込まない", async () => {
  const s = await database();
  try {
    const backup = await text(s.db);
    await assert.rejects(
      prepare(s.db, backup.replace('"version":1', '"version":999')),
      /新しい版/,
    );
    await assert.rejects(
      prepare(
        s.db,
        backup.replace(
          `"schemaVersion":${migrations.length}`,
          '"schemaVersion":999',
        ),
      ),
      /新しい版/,
    );
    await assert.rejects(
      prepare(s.db, backup.replace('"version":1', '"version":0')),
      /対応していない/,
    );
  } finally {
    s.sql.close();
  }
});
test("統合は同一指し手の既存修正・解析・履歴・プロフィールを保持、名前だけを追加", async () => {
  const source = await database(),
    target = await database();
  try {
    await seed(source.db);
    await seed(target.db);
    await target.db.runAsync(
      "UPDATE games SET favorite=0,result='draw',winner='draw'",
    );
    await target.db.runAsync(
      "UPDATE coach_meta SET value=? WHERE key='profile'",
      JSON.stringify({ ...defaultProfile, goal: "端末の目標" }),
    );
    const before = dump(target.sql, "games"),
      p = await prepare(target.db, await text(source.db));
    assert.equal(p.duplicates, 1);
    const result = await restoreBackup(target.db, p, "merge", randomUUID);
    assert.deepEqual(result, { added: 0, skipped: 1 });
    assert.deepEqual(dump(target.sql, "games"), before);
    assert.equal(
      JSON.parse(
        dump(target.sql, "coach_meta").find((r: any) => r.key === "profile")!
          .value,
      ).goal,
      "端末の目標",
    );
    assert.equal(dump(target.sql, "aliases").length, 1);
  } finally {
    source.sql.close();
    target.sql.close();
  }
});
test("ファイル内の同一指し手も取り込みと同じキーで重複排除する", async () => {
  const source = await database(),
    target = await database();
  try {
    await seed(source.db);
    const lines = (await text(source.db)).trimEnd().split("\n"),
      duplicate = JSON.parse(lines[2]!);
    duplicate.game.id = "別UUID";
    duplicate.game.black = "日付/名前は重複判定に使わない";
    duplicate.analysis.gameId = duplicate.game.id;
    duplicate.coach.gameId = duplicate.game.id;
    lines.splice(3, 0, JSON.stringify(duplicate));
    lines[4] = JSON.stringify({ type: "end", games: 2 });
    const p = await prepare(target.db, lines.join("\n"));
    assert.equal(p.duplicates, 1);
    await restoreBackup(target.db, p, "replace", randomUUID);
    assert.equal(dump(target.sql, "games").length, 1);
  } finally {
    source.sql.close();
    target.sql.close();
  }
});
test("置換は既存を削除し、書き込み途中で失敗すれば棋譜も設定もロールバック", async () => {
  const source = await database(),
    target = await database();
  try {
    await seed(source.db);
    await seed(target.db);
    const p = await prepare(target.db, await text(source.db)),
      before = dump(target.sql, "games"),
      settings = dump(target.sql, "settings"),
      run = target.db.runAsync.bind(target.db);
    target.db.runAsync = (async (q: string, ...args: any[]) => {
      if (q.startsWith("INSERT INTO games")) throw new Error("書き込み失敗");
      return run(q, ...args);
    }) as typeof run;
    await assert.rejects(
      restoreBackup(target.db, p, "replace", randomUUID),
      /書き込み失敗/,
    );
    assert.deepEqual(dump(target.sql, "games"), before);
    assert.deepEqual(dump(target.sql, "settings"), settings);
    target.db.runAsync = run;
    await restoreBackup(target.db, p, "replace", randomUUID);
    assert.deepEqual(dump(target.sql, "games"), dump(source.sql, "games"));
  } finally {
    source.sql.close();
    target.sql.close();
  }
});
test("未完了の通信依頼と権利は持ち出さず、受信済みの途中結果は閲覧用に残す", async () => {
  const s = await database();
  try {
    const id = await seed(s.db),
      row = await s.db.getFirstAsync<{ document: string }>(
        "SELECT document FROM analyses WHERE game_id=?",
        id,
      ),
      a = JSON.parse(row!.document);
    a.attempt = {
      ...a.saved,
      results: a.saved.results.slice(0, 3),
      firstSentAt: Date.now(),
      job: { id: "再送してはいけない" },
      cancel: false,
    };
    a.saved = null;
    await s.db.runAsync(
      "UPDATE analyses SET document=? WHERE game_id=?",
      JSON.stringify(a),
      id,
    );
    const b = await text(s.db),
      doc = JSON.parse(b.trimEnd().split("\n")[2]!).analysis;
    assert.equal(doc.attempt, null);
    assert.equal(doc.saved.results.length, 3);
    assert.equal(doc.saved.coachProof, null);
    assert(!b.includes("再送してはいけない"));
  } finally {
    s.sql.close();
  }
});
test("見本は同梱した実探索86局面だけで動作し、重複しない・戦績に入らない・削除できる", async () => {
  const s = await database();
  try {
    const id = await addSampleGame(s.db, randomUUID);
    assert.equal(await addSampleGame(s.db, randomUUID), id);
    const g = await s.db.getFirstAsync<any>("SELECT * FROM games");
    assert.equal(g.is_sample, 1);
    assert.equal(tally([{ ...g, self_side: "black", result: "win" }]).n, 0);
    const a = JSON.parse(
      (await s.db.getFirstAsync<{ document: string }>(
        "SELECT document FROM analyses",
      ))!.document,
    );
    assert.equal(a.saved.results.length, 86);
    assert(a.saved.results.some((r: any) => r.mate));
    assert.equal(a.saved.coachProof, null);
    await s.db.runAsync("DELETE FROM games WHERE id=?", id);
    assert.equal(dump(s.sql, "analyses").length, 0);
    assert.equal(dump(s.sql, "classifications").length, 0);
  } finally {
    s.sql.close();
  }
});
test("v5の移行は既存の棋譜・署名を保ち、利用中なら初回紹介を出さない", async () => {
  const s = await database();
  try {
    await seed(s.db);
    s.sql.exec(
      "DROP TABLE settings;ALTER TABLE games DROP COLUMN is_sample;PRAGMA user_version=5",
    );
    const before = dump(s.sql, "analyses");
    await migrate(s.db);
    assert.equal(dump(s.sql, "games")[0]!.is_sample, 0);
    assert.equal(dump(s.sql, "settings")[0]!.value, "true");
    assert.deepEqual(dump(s.sql, "analyses"), before);
  } finally {
    s.sql.close();
  }
});
