import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AnalysisClient, ApiError } from "../src/analysis/client";
import { AnalysisController } from "../src/analysis/controller";
import { analysisStorage } from "../src/analysis/storage";
import { database } from "./helpers/database";
import { migrate, migrations } from "../src/storage/schema";
import type { Input, Reply, Quota } from "../src/analysis/types";
const quota: Quota = {
  paid: true,
  weekStart: 0,
  resetsAt: 604800000,
  totalRemaining: 99,
  preciseRemaining: 19,
  completed: { total: 0, precise: 0 },
  reserved: { total: 1, precise: 1 },
};
const input: Input = { initial: "startpos", moves: ["7g7f"], mode: "precise" };
const result = (ply: number) => ({
  ply,
  score: { kind: "cp" as const, value: 20 },
  candidates: [],
  mate: null,
});
const reply = (status: Reply["status"] = "running", next = 1): Reply => ({
  id: "job-1",
  mode: "precise",
  status,
  next,
  total: 2,
  createdAt: 0,
  finishedAt: null,
  expiresAt: null,
  error: null,
  coachProof: null,
  results: [result(0)],
  quota,
});
async function setup(api: Partial<AnalysisClient>) {
  const { db, sql } = await database();
  sql
    .prepare(
      "INSERT INTO games(id,identity,kif,black,white,played_at,plies,result,created_at,updated_at) VALUES ('a','a','','','','',1,'unknown','','')",
    )
    .run();
  const notifications: [string, boolean][] = [];
  const storage = analysisStorage(db);
  const controller = new AnalysisController(
    { quota: async () => quota, ...api } as unknown as AnalysisClient,
    storage,
    (id, f) => notifications.push([id, f]),
  );
  await controller.init();
  return { controller, storage, sql, notifications };
}
test("偽HTTPサーバー: 登録一度・安全な保存後に認証・本文は局面と指し手だけ・429/401を維持", async () => {
  let saved: string | null = null,
    registrations = 0;
  const token = "a".repeat(64),
    requests: { url: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url!, body });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/devices") {
      registrations++;
      assert.equal(body, "");
      res.statusCode = 201;
      res.end(JSON.stringify({ token }));
      return;
    }
    assert.equal(saved, token);
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (req.url === "/v1/quota") {
      res.end(JSON.stringify(quota));
      return;
    }
    if (req.method === "POST") {
      assert.deepEqual(JSON.parse(body), input);
      res.end(JSON.stringify(reply()));
      return;
    }
    res.statusCode = req.method === "DELETE" ? 401 : 429;
    res.end(JSON.stringify({ error: "weekly_limit", quota }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  try {
    const api = new AnalysisClient(`http://127.0.0.1:${address.port}`, {
      get: async () => saved,
      set: async (t) => {
        saved = t;
      },
    });
    await Promise.all([api.quota(), api.quota()]);
    await api.create({ ...input, black: "送らない名前" } as Input);
    await assert.rejects(
      api.get("a", 1),
      (e: unknown) =>
        e instanceof ApiError &&
        e.status === 429 &&
        e.quota?.resetsAt === quota.resetsAt,
    );
    await assert.rejects(
      api.cancel("a"),
      (e: unknown) => e instanceof ApiError && e.status === 401,
    );
    assert.equal(registrations, 1);
    assert(requests.some((r) => r.url === "/v1/jobs/a?from=1"));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("送信応答喪失→再起動→重複再送→差分を重複排除して完成・署名をそのまま保存", async () => {
  let lost = true,
    from = -1;
  const api = {
    create: async () => {
      if (lost) throw new TypeError("offline");
      return reply();
    },
    get: async (_id: string, cursor: number) => {
      from = cursor;
      return {
        ...reply("completed", 2),
        results: [result(0), result(1)],
        coachProof: { signature: "opaque", expiresAt: 99 },
      };
    },
  };
  const { controller, storage, sql } = await setup(api);
  await controller.start("a", input);
  assert(controller.snapshot.offline);
  assert(controller.snapshot.records.a?.attempt);
  assert.equal((await storage.load())[0]?.attempt?.job, null);
  lost = false;
  const reopened = new AnalysisController(
    { quota: async () => quota, ...api } as unknown as AnalysisClient,
    storage,
  );
  await reopened.init();
  await reopened.sync();
  await reopened.sync();
  assert.equal(from, 1);
  assert.deepEqual(reopened.snapshot.records.a?.saved?.coachProof, {
    signature: "opaque",
    expiresAt: 99,
  });
  assert.deepEqual(
    reopened.snapshot.records.a?.saved?.results.map((r) => r.ply),
    [0, 1],
  );
  assert.deepEqual(reopened.snapshot.records.a?.saved?.moves, input.moves);
  assert.equal(reopened.snapshot.records.a?.attempt, null);
  sql.close();
});
test("待ち・取り消し・通信断中の中止意思を永続化し再開・失敗は前回の精密結果を残す", async () => {
  let online = true,
    cancelled = 0;
  const api = {
    create: async () => reply("queued"),
    cancel: async () => {
      if (!online) throw new TypeError("offline");
      cancelled++;
      return reply("cancelled");
    },
    get: async () => ({ ...reply("failed"), error: "container_failed" }),
  };
  const { controller, storage, sql, notifications } = await setup(api);
  await controller.start("a", input);
  assert.equal(controller.snapshot.records.a?.attempt?.job?.status, "queued");
  online = false;
  await controller.cancel("a");
  assert.equal((await storage.load())[0]?.attempt?.cancel, true);
  online = true;
  await controller.sync();
  assert.equal(cancelled, 1);
  assert.equal(controller.snapshot.records.a?.attempt, null);
  await storage.save({
    gameId: "a",
    attempt: null,
    error: null,
    saved: {
      ...input,
      results: [result(0), result(1)],
      coachProof: { proof: "keep" },
      jobId: "old",
    },
  });
  await controller.init();
  await controller.start("a", input);
  await controller.sync();
  assert(controller.snapshot.records.a?.error);
  assert.deepEqual(controller.snapshot.records.a?.saved?.coachProof, {
    proof: "keep",
  });
  assert.deepEqual(notifications, [["a", true]]);
  sql.close();
});
test("完了応答に欠けた局面があれば0から取得し直す・上限では再送しない", async () => {
  let calls = 0;
  const { controller, sql } = await setup({
    create: async () => reply("completed", 2),
    get: async (_id, from) => {
      assert.equal(from, 0);
      return { ...reply("completed", 2), results: [result(0), result(1)] };
    },
  });
  await controller.start("a", input);
  assert.equal(controller.snapshot.records.a?.saved, null);
  await controller.sync();
  assert(controller.snapshot.records.a?.saved);
  const second = await setup({
    quota: async () => ({ ...quota, totalRemaining: 0 }),
    create: async () => {
      calls++;
      throw new ApiError(429, "weekly_limit", { ...quota, totalRemaining: 0 });
    },
  });
  await second.controller.start("a", input);
  await second.controller.sync();
  assert.equal(calls, 1);
  assert.equal(second.controller.snapshot.quota?.totalRemaining, 0);
  sql.close();
  second.sql.close();
});
test("3版目移行: 既存棋譜を維持、保存再読み込み・CASCADE・再実行", async () => {
  const { controller, storage, sql } = await setup({
    create: async () => ({
      ...reply("completed", 2),
      results: [result(0), result(1)],
      coachProof: { signature: "same bytes" },
    }),
  });
  await controller.start("a", input);
  assert.equal((await storage.load())[0]?.saved?.results.length, 2);
  sql.exec("DELETE FROM games WHERE id='a'");
  assert.deepEqual(await storage.load(), []);
  sql.close();
  const { sql: old, db } = await database();
  old.exec(
    "DROP TABLE analyses; DROP TABLE analysis_meta; PRAGMA user_version=2",
  );
  old
    .prepare(
      "INSERT INTO games(id,identity,kif,black,white,played_at,plies,result,created_at,updated_at) VALUES ('old','old','大切な棋譜','','','',0,'unknown','','')",
    )
    .run();
  await migrate(db);
  await migrate(db);
  assert.equal(
    old.prepare("PRAGMA user_version").get()?.user_version,
    migrations.length,
  );
  assert.equal(old.prepare("SELECT kif FROM games").get()?.kif, "大切な棋譜");
  old.close();
});

test("7日を過ぎた応答不明POSTは再起動後も自動再送せず、送信時刻を保存する", async (t) => {
  const sentAt = 1794754800000;
  t.mock.timers.enable({ apis: ["Date"], now: sentAt });
  let calls = 0;
  const api = {
    create: async () => {
      calls++;
      throw new TypeError("応答を喪失");
    },
  };
  const { controller, storage, sql } = await setup(api);
  try {
    await controller.start("a", input);
    t.mock.timers.tick(7 * 86400000);
    const reopened = new AnalysisController(
      { quota: async () => quota, ...api } as unknown as AnalysisClient,
      storage,
    );
    await reopened.init();
    await reopened.sync();
    await reopened.sync();
    assert.equal(calls, 1, "期限を過ぎた不明POSTを自動再送してはいけない");
    assert.equal((await storage.load())[0]?.attempt?.firstSentAt, sentAt);
    await assert.rejects(reopened.start("a", input), /確認/);
    assert.equal(calls, 1);
    await reopened.start("a", input, true);
    assert.equal(calls, 2);
    assert.equal(
      (await storage.load())[0]?.attempt?.firstSentAt,
      sentAt + 7 * 86400000,
    );
  } finally {
    sql.close();
  }
});

test("不正な解析接続先でもクライアント生成は失敗せず、依頼だけをHTTPS検証で拒否する", async () => {
  let calls = 0;
  let api: AnalysisClient | undefined;
  assert.doesNotThrow(() => {
    api = new AnalysisClient(
      "http://untrusted.example",
      { get: async () => null, set: async () => {} },
      async () => {
        calls++;
        throw new Error("呼び出さない");
      },
    );
  });
  await assert.rejects(api!.create(input), /HTTPS/);
  assert.equal(calls, 0);
});

test("旧版の送信時刻不明の依頼も自動再送せず、中止でも新しいPOSTを送らない", async () => {
  let calls = 0;
  const { controller, storage, sql } = await setup({
    create: async () => {
      calls++;
      return reply();
    },
  });
  try {
    await storage.save({
      gameId: "a",
      saved: {
        ...input,
        jobId: "saved",
        coachProof: { keep: true },
        results: [result(0), result(1)],
      },
      error: null,
      attempt: { ...input, job: null, results: [], cancel: false },
    });
    await controller.init();
    await controller.sync();
    assert.equal(calls, 0);
    await controller.cancel("a");
    assert.equal(calls, 0);
    assert.equal(controller.snapshot.records.a?.attempt, null);
    assert.deepEqual(controller.snapshot.records.a?.saved?.coachProof, {
      keep: true,
    });
  } finally {
    sql.close();
  }
});
