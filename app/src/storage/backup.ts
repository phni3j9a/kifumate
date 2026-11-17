import type { SQLiteDatabase, SQLiteBindValue } from "expo-sqlite";
import { identity, normalizeName, readStoredKif } from "../core/kif";
import { migrations } from "./schema";
import {
  defaultProfile,
  details,
  focuses,
  practices,
  type Profile,
  type CoachRecord,
} from "../coach/types";
import type { Analysis, Saved } from "../analysis/types";

export const backupVersion = 1;
export const backupLimit = 256 * 1024 * 1024;
const columns = [
  "id",
  "identity",
  "kif",
  "black",
  "white",
  "played_at",
  "plies",
  "self_side",
  "result",
  "side_manual",
  "result_manual",
  "favorite",
  "created_at",
  "updated_at",
  "winner",
  "is_sample",
] as const;
type Row = Record<(typeof columns)[number], SQLiteBindValue>;
type Item = {
  game: Row;
  analysis: Analysis | null;
  coach: CoachRecord | null;
  classification: {
    rules_version: number;
    automatic: string | null;
    manual: string;
    error: string | null;
  } | null;
};
export interface BackupPreview {
  createdAt: string;
  games: number;
  duplicates: number;
  aliases: string[];
  profile: Profile;
  settings: Record<string, string>;
}
const invalid = () =>
  new Error(
    "バックアップが壊れているか、対応していない内容です。端末のデータは変更していません。",
  );
function check(ok: unknown): asserts ok {
  if (!ok) throw invalid();
}
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);
const nullable = (v: unknown) => v === null || str(v);
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
export function validateProfile(p: unknown): asserts p is Profile {
  check(
    object(p) &&
      strings(p.practice) &&
      p.practice.length <= 10 &&
      p.practice.every((n) => (practices as readonly string[]).includes(n)) &&
      str(p.goal) &&
      p.goal.length <= 200 &&
      object(p.style) &&
      focuses.includes(p.style.focus) &&
      details.includes(p.style.detail),
  );
}
function score(v: any) {
  check(
    v === null ||
      (object(v) &&
        ["cp", "mate", "declaration"].includes(v.kind) &&
        (v.value === null || Number.isFinite(v.value)) &&
        (v.winner === undefined || ["sente", "gote"].includes(v.winner))),
  );
}
function results(saved: any, key: string) {
  check(
    object(saved) &&
      ["std", "precise"].includes(saved.mode) &&
      str(saved.initial) &&
      strings(saved.moves) &&
      saved.moves.length <= 10000 &&
      Array.isArray(saved.results) &&
      saved.results.length <= saved.moves.length + 1 &&
      str(saved.jobId),
  );
  const initial =
    saved.initial === "startpos"
      ? "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b -"
      : saved.initial.split(" ").slice(0, 3).join(" ");
  check(JSON.stringify([initial, saved.moves]) === key);
  let last = -1;
  for (const r of saved.results) {
    check(
      object(r) &&
        Number.isInteger(r.ply) &&
        r.ply > last &&
        r.ply <= saved.moves.length &&
        Array.isArray(r.candidates) &&
        r.candidates.length <= 3,
    );
    last = r.ply;
    score(r.score);
    for (const c of r.candidates) {
      check(
        object(c) &&
          Number.isInteger(c.rank) &&
          c.rank >= 1 &&
          c.rank <= 3 &&
          Number.isFinite(c.depth) &&
          strings(c.pv) &&
          c.pv.length <= 128 &&
          (c.move === undefined || str(c.move)),
      );
      score(c.score);
    }
    check(
      r.mate === null ||
        (object(r.mate) &&
          [1, 3].includes(r.mate.plies) &&
          strings(r.mate.pv) &&
          Array.isArray(r.mate.branches) &&
          r.mate.branches.every(
            (b: any) => object(b) && str(b.reply) && str(b.mate),
          )),
    );
  }
}
function validateItem(v: unknown): asserts v is Item {
  check(object(v) && object(v.game));
  const g = v.game;
  for (const c of [
    "id",
    "identity",
    "kif",
    "black",
    "white",
    "played_at",
    "created_at",
    "updated_at",
  ])
    check(str(g[c]));
  check(
    g.id.length > 0 &&
      [null, "black", "white"].includes(g.self_side) &&
      ["win", "loss", "draw", "unknown"].includes(g.result) &&
      [null, "black", "white", "draw", "unknown"].includes(g.winner),
  );
  for (const c of ["side_manual", "result_manual", "favorite", "is_sample"])
    check(g[c] === 0 || g[c] === 1);
  const record = readStoredKif(g.kif);
  check(
    identity(record) === g.identity &&
      Number.isInteger(g.plies) &&
      g.plies === JSON.parse(g.identity)[1].length,
  );
  if (v.analysis !== null) {
    check(
      object(v.analysis) &&
        v.analysis.gameId === g.id &&
        v.analysis.attempt === null &&
        nullable(v.analysis.error),
    );
    if (v.analysis.saved !== null) results(v.analysis.saved, g.identity);
  }
  if (v.coach !== null) {
    const c = v.coach;
    check(
      object(c) &&
        c.gameId === g.id &&
        c.attempt === null &&
        Array.isArray(c.answers) &&
        nullable(c.error),
    );
    for (const a of c.answers) {
      check(
        object(a) &&
          str(a.requestId) &&
          (a.question === undefined || str(a.question)) &&
          object(a.style) &&
          focuses.includes(a.style.focus) &&
          details.includes(a.style.detail) &&
          Array.isArray(a.sections),
      );
      for (const s of a.sections) {
        check(
          object(s) &&
            ["facts", "advice"].includes(s.kind) &&
            str(s.title) &&
            str(s.text) &&
            Array.isArray(s.references),
        );
        for (const r of s.references) {
          check(
            object(r) &&
              str(r.id) &&
              Number.isInteger(r.ply) &&
              r.ply >= 0 &&
              r.ply <= g.plies &&
              strings(r.pv) &&
              typeof r.provenMate === "boolean",
          );
          score(r.score);
        }
      }
    }
  }
  if (v.classification !== null) {
    const c = v.classification;
    check(
      object(c) &&
        Number.isInteger(c.rules_version) &&
        nullable(c.automatic) &&
        str(c.manual) &&
        nullable(c.error),
    );
    const m = JSON.parse(c.manual);
    check(object(m));
    for (const side of ["black", "white"])
      if (m[side] !== undefined) {
        check(object(m[side]));
        const t = m[side];
        check(
          (t.family === undefined ||
            ["居飛車", "振り飛車", "未分類"].includes(t.family)) &&
            (t.strategies === undefined || strings(t.strategies)) &&
            (t.castles === undefined || strings(t.castles)),
        );
      }
    if (c.automatic !== null) {
      const a = JSON.parse(c.automatic);
      check(object(a) && object(a.sides));
      for (const side of ["black", "white"]) {
        const s = a.sides[side];
        check(
          object(s) &&
            ["居飛車", "振り飛車", "未分類"].includes(s.family) &&
            Array.isArray(s.strategies) &&
            Array.isArray(s.castles),
        );
        for (const f of [...s.strategies, ...s.castles])
          check(object(f) && str(f.id));
      }
    }
  }
}
// 送信中の依頼を別端末で再送しない。受信済みの途中結果は、署名なしの閲覧用結果として残す。
function portableAnalysis(a: Analysis): Analysis {
  const partial: Saved | null = a.attempt?.results.length
    ? {
        initial: a.attempt.initial,
        moves: a.attempt.moves,
        mode: a.attempt.mode,
        results: a.attempt.results,
        coachProof: null,
        jobId: "",
      }
    : null;
  return {
    gameId: a.gameId,
    saved: a.saved ?? partial,
    attempt: null,
    error: a.error,
  };
}
export async function* exportBackup(
  db: SQLiteDatabase,
  progress: (n: number) => void = () => {},
) {
  const header = {
    format: "kifumate-backup",
    version: backupVersion,
    schemaVersion: migrations.length,
    createdAt: new Date().toISOString(),
  };
  yield JSON.stringify(header) + "\n";
  const aliases = (
    await db.getAllAsync<{ name: string }>(
      "SELECT name FROM aliases ORDER BY created_at,id",
    )
  ).map((a) => a.name);
  const profile = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM coach_meta WHERE key='profile'",
  );
  const settings = Object.fromEntries(
    (
      await db.getAllAsync<{ key: string; value: string }>(
        "SELECT key,value FROM settings WHERE key='onboardingCompleted'",
      )
    ).map((r) => [r.key, r.value]),
  );
  yield (
    JSON.stringify({
      type: "preferences",
      aliases,
      profile: profile ? JSON.parse(profile.value) : defaultProfile,
      settings,
    }) + "\n"
  );
  let after = "",
    n = 0;
  while (true) {
    const game = await db.getFirstAsync<Row>(
      "SELECT * FROM games WHERE id>? ORDER BY id LIMIT 1",
      after,
    );
    if (!game) break;
    after = game.id as string;
    const a = await db.getFirstAsync<{ document: string }>(
      "SELECT document FROM analyses WHERE game_id=?",
      after,
    );
    const c = await db.getFirstAsync<{ document: string }>(
      "SELECT document FROM coaches WHERE game_id=?",
      after,
    );
    const classification = await db.getFirstAsync<Item["classification"]>(
      "SELECT rules_version,automatic,manual,error FROM classifications WHERE game_id=?",
      after,
    );
    const coach: CoachRecord | null = c ? JSON.parse(c.document) : null;
    yield (
      JSON.stringify({
        type: "game",
        game: Object.fromEntries(columns.map((c) => [c, game[c]])),
        analysis: a ? portableAnalysis(JSON.parse(a.document)) : null,
        coach: coach
          ? {
              gameId: coach.gameId,
              answers: coach.answers,
              attempt: null,
              error: coach.error,
              ...(coach.failedQuestion === undefined
                ? {}
                : { failedQuestion: coach.failedQuestion }),
            }
          : null,
        classification,
      }) + "\n"
    );
    progress(++n);
    await tick();
  }
  yield JSON.stringify({ type: "end", games: n }) + "\n";
}
/** 改行区切り。全ファイル・全棋譜をメモリに置かず、確認用の一時表へ1局ずつ検証して置く。 */
export async function prepareBackup(
  db: SQLiteDatabase,
  lines: AsyncIterable<string>,
  progress: (n: number) => void = () => {},
): Promise<BackupPreview> {
  await db.execAsync(
    "CREATE TEMP TABLE IF NOT EXISTS backup_stage(identity TEXT PRIMARY KEY,document TEXT NOT NULL); DELETE FROM backup_stage;",
  );
  let header: any,
    preferences: any,
    end = false,
    games = 0,
    duplicates = 0,
    bytes = 0;
  const seenIds = new Set<string>();
  try {
    for await (const line of lines) {
      bytes += line.length;
      check(bytes <= backupLimit && line.length <= 32 * 1024 * 1024);
      if (!line.trim()) continue;
      const v = JSON.parse(line);
      check(object(v) && !end);
      if (!header) {
        check(v.format === "kifumate-backup" && Number.isInteger(v.version));
        if (v.version > backupVersion || v.schemaVersion > migrations.length)
          throw new Error(
            "新しい版のバックアップです。アプリを更新してください。",
          );
        check(
          v.version === backupVersion &&
            Number.isInteger(v.schemaVersion) &&
            str(v.createdAt) &&
            Number.isFinite(Date.parse(v.createdAt)),
        );
        header = v;
        continue;
      }
      if (!preferences) {
        check(
          v.type === "preferences" &&
            strings(v.aliases) &&
            v.aliases.every((n) => n.trim().length > 0 && n.length <= 100) &&
            object(v.settings),
        );
        validateProfile(v.profile);
        check(
          Object.entries(v.settings).every(
            ([k, value]) => k === "onboardingCompleted" && value === "true",
          ),
        );
        preferences = v;
        continue;
      }
      if (v.type === "end") {
        check(Number.isInteger(v.games) && v.games === games);
        end = true;
        continue;
      }
      check(v.type === "game");
      validateItem(v);
      games++;
      check(!seenIds.has(v.game.id as string));
      seenIds.add(v.game.id as string);
      const exists = await db.getFirstAsync(
        "SELECT identity FROM backup_stage WHERE identity=?",
        v.game.identity,
      );
      if (exists) {
        duplicates++;
        continue;
      }
      if (
        await db.getFirstAsync(
          "SELECT id FROM games WHERE identity=?",
          v.game.identity,
        )
      )
        duplicates++;
      await db.runAsync(
        "INSERT INTO backup_stage VALUES (?,?)",
        v.game.identity,
        JSON.stringify(v),
      );
      progress(games);
      await tick();
    }
    check(header && preferences && end);
    return {
      createdAt: header.createdAt,
      games,
      duplicates,
      aliases: [
        ...new Map(
          preferences.aliases.map((n: string) => [normalizeName(n), n]),
        ).values(),
      ] as string[],
      profile: preferences.profile,
      settings: preferences.settings,
    };
  } catch (e) {
    await clearPreparedBackup(db);
    if (e instanceof Error && /新しい版/.test(e.message)) throw e;
    throw invalid();
  }
}
export const clearPreparedBackup = (db: SQLiteDatabase) =>
  db.execAsync("DROP TABLE IF EXISTS temp.backup_stage");
export async function restoreBackup(
  db: SQLiteDatabase,
  preview: BackupPreview,
  mode: "merge" | "replace",
  uuid: () => string,
  progress: (n: number) => void = () => {},
) {
  let added = 0,
    skipped = 0;
  await db.withTransactionAsync(async () => {
    if (mode === "replace") {
      await db.runAsync("DELETE FROM games");
      await db.runAsync("DELETE FROM aliases");
      await db.runAsync("DELETE FROM settings");
      await db.runAsync("DELETE FROM coach_meta WHERE key='profile'");
    }
    let after = "";
    while (true) {
      const row = await db.getFirstAsync<{
        identity: string;
        document: string;
      }>(
        "SELECT * FROM backup_stage WHERE identity>? ORDER BY identity LIMIT 1",
        after,
      );
      if (!row) break;
      after = row.identity;
      const item: Item = JSON.parse(row.document),
        g = item.game;
      if (
        await db.getFirstAsync(
          "SELECT id FROM games WHERE identity=?",
          g.identity,
        )
      ) {
        skipped++;
        continue;
      }
      if (await db.getFirstAsync("SELECT id FROM games WHERE id=?", g.id))
        g.id = uuid();
      await db.runAsync(
        `INSERT INTO games (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        ...columns.map((c) => g[c]),
      );
      for (const [table, doc] of [
        ["analyses", item.analysis],
        ["coaches", item.coach],
      ] as const)
        if (doc)
          await db.runAsync(
            `INSERT INTO ${table} VALUES (?,?)`,
            g.id,
            JSON.stringify({ ...doc, gameId: g.id }),
          );
      const c = item.classification;
      if (c)
        await db.runAsync(
          "INSERT INTO classifications VALUES (?,?,?,?,?)",
          g.id,
          c.rules_version,
          c.automatic,
          c.manual,
          c.error,
        );
      progress(++added);
      await tick();
    }
    for (const name of preview.aliases)
      await db.runAsync(
        "INSERT INTO aliases VALUES (?,?,?,?) ON CONFLICT(normalized) DO NOTHING",
        uuid(),
        name,
        normalizeName(name),
        new Date().toISOString(),
      );
    // 統合では既存の設定・プロフィールを保つ。重複棋譜の修正・解析・履歴も上書きしない。
    await db.runAsync(
      `INSERT INTO coach_meta VALUES ('profile',?) ON CONFLICT(key) DO ${mode === "replace" ? "UPDATE SET value=excluded.value" : "NOTHING"}`,
      JSON.stringify(preview.profile),
    );
    await db.runAsync(
      "INSERT INTO settings VALUES ('onboardingCompleted','true') ON CONFLICT(key) DO UPDATE SET value='true'",
    );
  });
  await clearPreparedBackup(db);
  return { added, skipped };
}
export async function* textLines(chunks: AsyncIterable<string>) {
  let pending = "";
  for await (const chunk of chunks) {
    pending += chunk;
    check(pending.length <= 32 * 1024 * 1024);
    let at: number;
    while ((at = pending.indexOf("\n")) >= 0) {
      yield pending.slice(0, at);
      pending = pending.slice(at + 1);
    }
  }
  if (pending) yield pending;
}
