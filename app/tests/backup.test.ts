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
  const shallow = doc.saved.results[0];
  shallow.deep = { ...shallow, score: { kind: "cp", value: 123 } };
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
              references: [
                {
                  id: "0:deep:candidate:1",
                  ply: 0,
                  score: shallow.deep.score,
                  pv: ["7g7f"],
                  provenMate: false,
                },
              ],
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
test("全対象の往復：深読み・署名・手動の先後/結果/分類・回答/質問・名前・プロフィール・設定が空DBで一致", async () => {
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
test("不正な深読み局面のバックアップは復元前に拒否する", async () => {
  const { db, sql } = await database();
  try {
    await seed(db);
    const backup = await text(db);
    const bad = backup.replace('"deep":{"ply":0', '"deep":{"ply":1');
    assert.notEqual(bad, backup);
    await assert.rejects(prepare(db, bad), /バックアップが壊れているか/);
    assert.equal(
      await text(db).then((s) => s.split("\n")[2]),
      backup.split("\n")[2],
    );
  } finally {
    sql.close();
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
    duplicate.game.id = randomUUID();
    duplicate.game.black = "日付/名前は重複判定に使わない";
    duplicate.analysis.gameId = duplicate.game.id;
    duplicate.coach.gameId = duplicate.game.id;
    lines.splice(3, 0, JSON.stringify(duplicate));
    lines[4] = JSON.stringify({ type: "end", games: 2 });
    const p = await prepare(target.db, lines.join("\n"));
    assert.equal(p.duplicates, 1);
    const result = await restoreBackup(target.db, p, "replace", randomUUID);
    assert.deepEqual(result, { added: 1, skipped: 1 });
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
    assert.equal(doc.saved.partial, true);
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

test("空の旧DBにも紹介を割り込ませず、完全な新規DBだけ未完了になる", async () => {
  const s = await database();
  try {
    assert.equal(
      await s.db.getFirstAsync(
        "SELECT * FROM settings WHERE key='onboardingCompleted'",
      ),
      null,
    );
    s.sql.exec(
      "DROP TABLE settings;ALTER TABLE games DROP COLUMN is_sample;PRAGMA user_version=5",
    );
    await migrate(s.db);
    assert.equal(
      (await s.db.getFirstAsync<{ value: string }>(
        "SELECT * FROM settings WHERE key='onboardingCompleted'",
      ))!.value,
      "true",
    );
  } finally {
    s.sql.close();
  }
});

test("長い1行を小さいチャンクで渡しても、行の途中と末尾を欠かさず分割する", async () => {
  const long = "棋譜と質問".repeat(200000);
  const lines: string[] = [];
  for await (const line of textLines(chunks(`\n${long}\n次の行\n末尾`)))
    lines.push(line);
  assert.deepEqual(lines, ["", long, "次の行", "末尾"]);
});

test("登録名が複数あっても、復元後の再出力で順序が変わらない", async () => {
  const source = await database(),
    target = await database();
  try {
    await source.db.runAsync(
      "INSERT INTO aliases VALUES ('first','先の名前','先の名前','2026-11-01')",
    );
    await source.db.runAsync(
      "INSERT INTO aliases VALUES ('second','後の名前','後の名前','2026-11-02')",
    );
    const p = await prepare(target.db, await text(source.db));
    let n = 0;
    await restoreBackup(target.db, p, "replace", () => (n++ ? "a" : "z"));
    const rows = await target.db.getAllAsync<{
      name: string;
      created_at: string;
    }>("SELECT * FROM aliases ORDER BY created_at,id");
    assert.deepEqual(
      rows.map((r) => r.name),
      ["先の名前", "後の名前"],
    );
    assert(rows[0]!.created_at < rows[1]!.created_at);
    const exported = JSON.parse((await text(target.db)).split("\n")[1]!);
    assert.deepEqual(exported.aliases, p.aliases);
  } finally {
    source.sql.close();
    target.sql.close();
  }
});

test("同じUUIDの同一棋譜が重なっていても、指し手の重複として1局にまとめる", async () => {
  const source = await database(),
    target = await database();
  try {
    await seed(source.db);
    const lines = (await text(source.db)).trimEnd().split("\n");
    lines.splice(3, 0, lines[2]!);
    lines[4] = JSON.stringify({ type: "end", games: 2 });
    const p = await prepare(target.db, lines.join("\n"));
    assert.equal(p.duplicates, 1);
    assert.deepEqual(await restoreBackup(target.db, p, "replace", randomUUID), {
      added: 1,
      skipped: 1,
    });
  } finally {
    source.sql.close();
    target.sql.close();
  }
});

test("復元の上限を超えるファイルを、書き出し成功として渡さない", async () => {
  const s = await database();
  try {
    await s.db.runAsync(
      "INSERT INTO aliases VALUES ('large',?,'large','2026-11-18')",
      "x".repeat(32 * 1024 * 1024),
    );
    await assert.rejects(text(s.db), /バックアップが大きすぎます/);
    assert.equal(
      (await s.db.getFirstAsync<{ n: number }>(
        "SELECT count(*) AS n FROM aliases",
      ))!.n,
      1,
    );
  } finally {
    s.sql.close();
  }
});

test("長い登録名も往復でき、同時刻の登録名は画面と同じ挿入順を保つ", async () => {
  const { db, sql } = await database();
  try {
    const names = ["名前".repeat(101), "後の名前"];
    for (const [i, name] of names.entries())
      await db.runAsync(
        "INSERT INTO aliases VALUES (?,?,?,?)",
        i ? "a" : "z",
        name,
        name,
        "same-time",
      );
    const p = await prepare(db, await text(db));
    assert.deepEqual(p.aliases, names);
    await restoreBackup(db, p, "replace", randomUUID);
    assert.deepEqual((await prepare(db, await text(db))).aliases, names);
  } finally {
    sql.close();
  }
});
test("書き出しも読み込みと同じ条件を検証し、復元不能なプロフィールを成功扱いにしない", async () => {
  const { db, sql } = await database();
  try {
    await db.runAsync(
      "INSERT INTO coach_meta VALUES ('profile',?)",
      JSON.stringify({ ...defaultProfile, goal: "a".repeat(201) }),
    );
    await assert.rejects(text(db), /バックアップ/);
  } finally {
    sql.close();
  }
});
test("経路に使えないゲームIDと正規化増分を超えた本文は復元前に拒否する", async () => {
  const { db, sql } = await database();
  try {
    await seed(db);
    const rows = (await text(db))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    for (const change of [
      (g: any) => {
        g.id = "unsafe/path";
      },
      (g: any) => {
        g.kif = "*\n".repeat(2 * 1024 * 1024 + 65536);
      },
    ]) {
      const broken = structuredClone(rows);
      change(broken[2].game);
      broken[2].analysis.gameId = broken[2].game.id;
      broken[2].coach.gameId = broken[2].game.id;
      await assert.rejects(
        prepare(db, broken.map((r) => JSON.stringify(r)).join("\n")),
        /バックアップ/,
      );
      assert.equal(sql.prepare("SELECT count(*) AS n FROM games").get()!.n, 1);
    }
  } finally {
    sql.close();
  }
});
test("統合後の名前で既存・追加の自動先後を再照合し、手動先後と勝ち側は保持する", async () => {
  const source = await database(),
    target = await database();
  try {
    await seed(source.db);
    await source.db.runAsync(
      "UPDATE games SET side_manual=0, result_manual=0, self_side='white'",
    );
    await source.db.runAsync("DELETE FROM aliases");
    const game = source.sql.prepare("SELECT black,white FROM games").get()!;
    await source.db.runAsync(
      "INSERT INTO aliases VALUES ('b',?,?, '')",
      game.white as string,
      game.white as string,
    );
    const backup = await text(source.db);
    await target.db.runAsync(
      "INSERT INTO aliases VALUES ('a',?,?, '')",
      game.black as string,
      game.black as string,
    );
    await restoreBackup(
      target.db,
      await prepare(target.db, backup),
      "merge",
      randomUUID,
    );
    let row = target.sql.prepare("SELECT * FROM games").get()!;
    assert.equal(row.self_side, null);
    assert.equal(row.result, "unknown");
    await target.db.runAsync(
      "UPDATE games SET self_side='black',result='win',side_manual=0",
    );
    await restoreBackup(
      target.db,
      await prepare(target.db, backup),
      "merge",
      randomUUID,
    );
    row = target.sql.prepare("SELECT * FROM games").get()!;
    assert.equal(row.self_side, null);
    await target.db.runAsync(
      "UPDATE games SET self_side='white',result='loss',side_manual=1",
    );
    await restoreBackup(
      target.db,
      await prepare(target.db, backup),
      "merge",
      randomUUID,
    );
    row = target.sql.prepare("SELECT * FROM games").get()!;
    assert.equal(row.self_side, "white");
    assert.equal(row.result, "loss");
    assert.equal(row.winner, "black");
  } finally {
    source.sql.close();
    target.sql.close();
  }
});

test("同時刻の登録名はUUID順ではなく挿入順で書き出す", async () => {
  const { db, sql } = await database();
  try {
    await db.runAsync(
      "INSERT INTO aliases VALUES ('z','先の名前','先の名前','same'),('a','後の名前','後の名前','same')",
    );
    assert.deepEqual((await prepare(db, await text(db))).aliases, [
      "先の名前",
      "後の名前",
    ]);
  } finally {
    sql.close();
  }
});

test("統合して名前を再照合しても、旧版の先後不明・手動引き分けを保持する", async () => {
  const { db, sql } = await database();
  try {
    await seed(db);
    await db.runAsync(
      "UPDATE games SET self_side=NULL,side_manual=0,result='draw',result_manual=1,winner=NULL",
    );
    const p = await prepare(db, await text(db));
    await restoreBackup(db, p, "merge", randomUUID);
    const game = sql
      .prepare("SELECT result,result_manual,winner FROM games")
      .get()!;
    assert.equal(game.result, "draw");
    assert.equal(game.result_manual, 1);
    assert.equal(game.winner, null);
  } finally {
    sql.close();
  }
});

test("完了結果は保持し、途中結果同士の再解析では多く受信したほうを書き出す", async () => {
  const { db, sql } = await database();
  try {
    const id = await seed(db);
    const full = JSON.parse(
      (await db.getFirstAsync<{ document: string }>(
        "SELECT document FROM analyses WHERE game_id=?",
        id,
      ))!.document,
    );
    for (const [oldCount, freshCount, expected] of [
      [3, 20, 20],
      [20, 3, 20],
      [86, 20, 86],
    ] as const) {
      const a = structuredClone(full);
      a.saved.results = full.saved.results.slice(0, oldCount);
      a.saved.partial = oldCount < 86;
      a.attempt = {
        ...full.saved,
        results: full.saved.results.slice(0, freshCount),
        job: null,
        cancel: false,
      };
      await db.runAsync(
        "UPDATE analyses SET document=? WHERE game_id=?",
        JSON.stringify(a),
        id,
      );
      const exported = JSON.parse((await text(db)).split("\n")[2]!).analysis;
      assert.equal(exported.saved.results.length, expected);
      assert.equal(exported.attempt, null);
      if (expected < 86) assert.equal(exported.saved.partial, true);
    }
  } finally {
    sql.close();
  }
});

test("手動の勝ち側がある局は、名前変更後の先後から勝敗を再計算する", async () => {
  const { db, sql } = await database();
  try {
    await seed(db);
    await db.runAsync(
      "UPDATE games SET self_side='black',side_manual=0,result='win',result_manual=1,winner='black'",
    );
    const g = sql.prepare("SELECT white FROM games").get()!;
    const { reconcileAliases } = await import("../src/storage/aliases");
    await reconcileAliases(db, [g.white as string]);
    const updated = sql
      .prepare("SELECT self_side,result,winner FROM games")
      .get()!;
    assert.equal(updated.self_side, "white");
    assert.equal(updated.result, "loss");
    assert.equal(updated.winner, "black");
  } finally {
    sql.close();
  }
});

test("途中結果は同モードの進捗増だけを採用し、異モードなら精密を優先する", async () => {
  const { db, sql } = await database();
  try {
    const id = await seed(db);
    const full = JSON.parse(
      (await db.getFirstAsync<{ document: string }>(
        "SELECT document FROM analyses WHERE game_id=?",
        id,
      ))!.document,
    );
    for (const [
      oldMode,
      oldCount,
      newMode,
      newCount,
      expectedMode,
      expectedCount,
    ] of [
      ["precise", 3, "std", 4, "precise", 3],
      ["std", 20, "precise", 3, "precise", 3],
      ["std", 3, "std", 4, "std", 4],
      ["precise", 4, "precise", 3, "precise", 4],
      ["std", 86, "precise", 20, "std", 86],
      ["precise", 86, "std", 20, "precise", 86],
    ] as const) {
      const a = structuredClone(full);
      a.saved = {
        ...full.saved,
        mode: oldMode,
        results: full.saved.results.slice(0, oldCount),
        partial: oldCount < 86,
      };
      a.attempt = {
        ...full.saved,
        mode: newMode,
        results: full.saved.results.slice(0, newCount),
        job: null,
        cancel: false,
      };
      await db.runAsync(
        "UPDATE analyses SET document=? WHERE game_id=?",
        JSON.stringify(a),
        id,
      );
      const saved = JSON.parse((await text(db)).split("\n")[2]!).analysis.saved;
      assert.equal(saved.mode, expectedMode);
      assert.equal(saved.results.length, expectedCount);
    }
  } finally {
    sql.close();
  }
});
