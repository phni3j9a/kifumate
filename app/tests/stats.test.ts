import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { Record as ShogiRecord } from "tsshogi";
import * as kif from "../src/core/kif";
import {
  classifyRecord,
  classifyRecordAsync,
  classifyUsiAsync,
  rulesVersion,
} from "../src/core/classify";
import { matchesGame, statRows, tally, tagsOf } from "../src/core/stats";
import {
  reclassifyGames,
  resetTags,
  setTags,
} from "../src/storage/classifications";
import type * as Repository from "../src/storage/repository";
import { migrate } from "../src/storage/schema";
import { database } from "./helpers/database";
import { loadWithMocks } from "./helpers/load-with-mocks";
const repository = loadWithMocks<typeof Repository>(
  "src/storage/repository.ts",
  { "expo-crypto": { randomUUID }, "../core/kif": kif },
);
const game = (
  id: string,
  side: Repository.Game["self_side"],
  result: Repository.Game["result"],
  tags = {
    family: "振り飛車",
    strategies: ["fourth-file-rook", "bishop-exchange-ranging"],
    castles: ["mino", "high-mino", "mino"],
  },
): Repository.Game => ({
  id,
  kif: "",
  black: "自分",
  white: "相手",
  played_at: "2026/11/16",
  plies: 10,
  self_side: side,
  result,
  side_manual: 0,
  result_manual: 0,
  winner: null,
  favorite: 0,
  classification_manual: JSON.stringify({ [side ?? "black"]: tags }),
});
const fixture = () =>
  kif.readKif(readFileSync("tests/fixtures/standard.kif", "utf8"));
test("勝率は自分だけ・勝敗だけ、同じIDは二重計上しない", () => {
  const a = game("a", "black", "win");
  assert.deepEqual(
    tally([
      a,
      a,
      game("b", "white", "loss"),
      game("c", "black", "draw"),
      game("d", "white", "unknown"),
      game("e", null, "win"),
    ]),
    { n: 4, w: 1, l: 1, d: 1, u: 1, r: 50 },
  );
  assert.equal(tally([game("c", "black", "draw")]).r, 0);
});
test("複数の戦法・囲いの再建があっても大分類・各行に一局ずつ", () => {
  const a = game("a", "black", "win"),
    b = game("b", "white", "loss");
  const strategies = statRows([a, b, game("other", null, "win")], "myst");
  assert.deepEqual(
    strategies.map((r) => [r.id, r.total.n]),
    [
      ["振り飛車", 2],
      ["fourth-file-rook", 2],
      ["bishop-exchange-ranging", 2],
    ],
  );
  const castles = statRows([a, b], "mycs");
  assert.deepEqual(
    castles.map((r) => [r.id, r.depth, r.total.n]),
    [
      ["mino", 0, 2],
      ["high-mino", 1, 2],
    ],
  );
});
test("期間の境界・日付なし・未来日と、自分の先後・相手の戦法を絞る", () => {
  const now = Date.parse("2026-11-16T12:00:00Z"),
    a = game("a", "white", "win");
  a.played_at = "2026/10/17";
  assert(
    matchesGame(a, { period: "30", side: "white", myst: "振り飛車" }, now),
  );
  assert(!matchesGame(a, { side: "black" }, now));
  assert(!matchesGame(a, { opst: "振り飛車" }, now));
  assert(matchesGame(a, { opst: "未分類" }, now));
  for (const date of ["2026/10/16", "", "2026/11/17"]) {
    a.played_at = date;
    assert(!matchesGame(a, { period: "30" }, now));
  }
  assert(!matchesGame(game("o", null, "win"), { myst: "未分類" }, now));
  assert(matchesGame(game("d", "black", "draw"), { result: "draw" }, now));
  assert(!matchesGame(game("d", "black", "draw"), { result: "decided" }, now));
});
test("同期・非同期・保存済みUSIの判定が一致し、長い棋譜でもイベントループに戻る", async () => {
  const r = new ShogiRecord();
  for (let i = 0; i < 80; i++) {
    const move = r.position.createMoveByUSI(
      ["5i5h", "5a5b", "5h5i", "5b5a"][i % 4]!,
    );
    assert(move && r.append(move));
  }
  let yielded = false;
  const timer = setTimeout(() => {
    yielded = true;
  }, 0);
  const asyncResult = await classifyRecordAsync(r);
  clearTimeout(timer);
  assert(yielded);
  assert.deepEqual(asyncResult, classifyRecord(r));
  const [initial, moves] = JSON.parse(kif.identity(r));
  assert.deepEqual(await classifyUsiAsync(`${initial} 1`, moves), asyncResult);
});
test("取り込みで両側の結果と版を保存し、重複取り込みで修正を消さない", async () => {
  const { db, sql } = await database();
  try {
    const r = fixture(),
      saved = await repository.importGame(db, r, "black", "win", true, false);
    const stored = await repository.getGame(db, saved.id);
    assert.deepEqual(
      JSON.parse(stored!.classification_auto!),
      classifyRecord(r),
    );
    assert.equal(
      sql.prepare("SELECT rules_version FROM classifications").get()
        ?.rules_version,
      rulesVersion,
    );
    await setTags(db, saved.id, "black", "strategies", [], "未分類");
    assert(
      (await repository.importGame(db, r, "black", "win", true, false))
        .duplicate,
    );
    assert.equal(
      tagsOf((await repository.getGame(db, saved.id))!, "black").family,
      "未分類",
    );
  } finally {
    sql.close();
  }
});
test("版が上がると自動だけ再判定し、片側・種別ごとの手動と未分類を保持", async () => {
  const { db, sql } = await database();
  try {
    const saved = await repository.importGame(
      db,
      fixture(),
      "white",
      "loss",
      true,
      false,
    );
    await setTags(
      db,
      saved.id,
      "black",
      "strategies",
      ["fourth-file-rook"],
      "振り飛車",
    );
    await setTags(db, saved.id, "black", "castles", ["mino", "high-mino"]);
    await setTags(db, saved.id, "white", "castles", []);
    sql.exec("UPDATE classifications SET rules_version=1, automatic=NULL");
    let changed = 0;
    await reclassifyGames(db, () => changed++);
    assert.equal(changed, 1);
    const g = (await repository.getGame(db, saved.id))!;
    assert.deepEqual(tagsOf(g, "black"), {
      family: "振り飛車",
      strategies: ["fourth-file-rook"],
      castles: ["mino", "high-mino"],
    });
    assert.deepEqual(tagsOf(g, "white").castles, []);
    assert(g.classification_auto);
    await reclassifyGames(db, () => changed++);
    assert.equal(changed, 1);
    await reclassifyGames(
      db,
      () => changed++,
      () => false,
      rulesVersion + 1,
    );
    assert.equal(changed, 2);
    assert.equal(
      (await repository.getGame(db, saved.id))!.classification_manual,
      g.classification_manual,
    );
    await resetTags(db, saved.id, "black");
    const restored = (await repository.getGame(db, saved.id))!;
    assert.deepEqual(
      tagsOf(restored, "black"),
      tagsOf({ ...restored, classification_manual: null }, "black"),
    );
    assert.deepEqual(JSON.parse(restored.classification_manual!).white, {
      castles: [],
    });
  } finally {
    sql.close();
  }
});
test("v3から移行して既存棋譜を逐次分類、再実行とCASCADE", async () => {
  const { db, sql } = await database();
  try {
    const saved = await repository.importGame(
      db,
      fixture(),
      "black",
      "win",
      true,
      false,
    );
    sql.exec("DROP TABLE classifications; PRAGMA user_version=3");
    await migrate(db);
    await migrate(db);
    assert.equal((await repository.listGames(db)).length, 1);
    let changed = 0;
    await reclassifyGames(
      db,
      () => changed++,
      () => true,
    );
    assert.equal(changed, 0);
    await reclassifyGames(db, () => changed++);
    assert.equal(changed, 1);
    assert.deepEqual(
      JSON.parse(
        (await repository.getGame(db, saved.id))!.classification_auto!,
      ),
      classifyRecord(fixture()),
    );
    await repository.deleteGame(db, saved.id);
    assert.equal(
      sql.prepare("SELECT COUNT(*) n FROM classifications").get()?.n,
      0,
    );
  } finally {
    sql.close();
  }
});
test("分類不能な棋譜は消さず未分類とし、失敗を毎起動くり返さない", async () => {
  const { db, sql } = await database();
  try {
    sql.exec(
      "INSERT INTO games (id,identity,kif,black,white,played_at,plies,result,created_at,updated_at) VALUES ('broken','[]','保持する棋譜','','','',0,'unknown','','')",
    );
    let changed = 0;
    await reclassifyGames(db, () => changed++);
    await reclassifyGames(db, () => changed++);
    assert.equal(changed, 1);
    const g = (await repository.getGame(db, "broken"))!;
    assert.equal(g.kif, "保持する棋譜");
    assert(g.classification_error);
    assert.equal(tagsOf(g, "black").family, "未分類");
    await assert.rejects(setTags(db, g.id, "black", "castles", ["unknown-id"]));
  } finally {
    sql.close();
  }
});
