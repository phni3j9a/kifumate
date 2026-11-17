import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AnalysisClient, ApiError } from "../src/analysis/client";
import { CoachController } from "../src/coach/controller";
import { coachInput, redact } from "../src/coach/privacy";
import { coachStorage } from "../src/coach/storage";
import {
  defaultProfile,
  quotaNotice,
  type CoachInput,
  type CoachReply,
  type CoachOverview,
} from "../src/coach/types";
import { database } from "./helpers/database";
import { migrate, migrations } from "../src/storage/schema";
const quota = {
  monthStart: 0,
  resetsAt: 1796050800000,
  limit: 100,
  used: 1,
  reserved: 0,
  remaining: 99,
  low: false,
};
const overview: CoachOverview = { paid: true, quota, latest: null };
const saved = {
  initial: "startpos",
  moves: ["7g7f"],
  mode: "precise" as const,
  results: [],
  coachProof: { signature: "proof" },
  jobId: "job",
};
const game = { black: "山田太郎", white: "鈴木", self_side: "black" as const };
const input: CoachInput = coachInput(
  "request-1",
  saved,
  game,
  [],
  defaultProfile,
  defaultProfile.style,
  [],
);
const reply = (status: CoachReply["status"] = "pending"): CoachReply => ({
  requestId: input.requestId,
  status,
  expiresAt: Date.now() + 240000,
  error: status === "failed" ? "invalid_output" : null,
  quota,
  ...(status === "completed"
    ? {
        sections: [
          {
            kind: "facts" as const,
            title: "対局の振り返り",
            text: "落ち着いた駒組みでした。",
            references: [],
          },
        ],
      }
    : {}),
});
async function setup(api: Partial<AnalysisClient> = {}) {
  const { db, sql } = await database();
  sql.exec(
    "INSERT INTO games(id,identity,kif,black,white,played_at,plies,result,created_at,updated_at) VALUES ('a','a','','','','',1,'unknown','',''),('b','b','','','','',1,'unknown','','')",
  );
  const storage = coachStorage(db),
    calls: string[] = [],
    notices: string[] = [];
  const client = {
    coach: async () => overview,
    createCoach: async (i: CoachInput) => {
      calls.push(i.requestId);
      return reply();
    },
    getCoach: async () => reply(),
    cancelCoach: async () => reply("cancelled"),
    ...api,
  };
  const c = new CoachController(client, storage);
  c.onNotify((id) => notices.push(id));
  await c.init();
  return { c, storage, calls, sql, db, client, notices };
}
test("伏せ字：登録名・両対局者・正規化・重複・正規表現記号・長い名前を優先", () => {
  assert.equal(
    redact(
      "山田太郎と山田、鈴木、ＴＳＵＢＡＭＥ、a.b",
      ["山田", "tsubame", "a.b"],
      game,
    ),
    "あなたとあなた、相手、あなた、あなた",
  );
  assert.equal(
    redact("Tsu\u200bbame と 鈴木", ["TSUBAME"], { ...game, self_side: null }),
    "あなた と 後手",
  );
  assert.equal(
    redact("山田太郎 鈴木", [], { ...game, self_side: "white" }),
    "相手 あなた",
  );
  assert.equal(
    redact("何も変えない", ["", "  "], {
      black: "",
      white: "",
      self_side: null,
    }),
    "何も変えない",
  );
});
test("送信境界：目標・質問・利用者とAI双方の履歴を伏せ、名前欄・jobIdは送らない", () => {
  const p = coachInput(
    "id",
    saved,
    game,
    ["hiyodori"],
    { ...defaultProfile, goal: "山田太郎とhiyodoriの練習" },
    defaultProfile.style,
    [
      { role: "user", content: "鈴木" },
      { role: "assistant", content: "山田太郎" },
    ],
    "鈴木のねらいは？",
  );
  assert.equal(p.profile.goal, "あなたとあなたの練習");
  assert.equal(p.question, "相手のねらいは？");
  assert.deepEqual(
    p.history.map((m) => m.content),
    ["相手", "あなた"],
  );
  const json = JSON.stringify(p);
  for (const name of [
    "black",
    "white",
    "山田太郎",
    "鈴木",
    "hiyodori",
    "jobId",
  ])
    assert(!json.includes(name));
  assert.equal(p.proof, saved.coachProof);
  assert.equal(p.analysis.results, saved.results);
  const long = coachInput(
    "id",
    saved,
    game,
    [],
    defaultProfile,
    defaultProfile.style,
    Array.from({ length: 30 }, () => ({
      role: "assistant",
      content: "あ".repeat(5000),
    })),
  );
  assert.equal(long.history.length, 20);
  assert.equal(long.history[0]!.content.length, 4000);
});
test("回数：残り10%以上を知らせず、10%未満とゼロの更新日時だけ案内", () => {
  assert.equal(quotaNotice(null), "");
  assert.equal(quotaNotice({ ...quota, remaining: 10 }), "");
  assert.match(quotaNotice({ ...quota, remaining: 9, low: true }), /あと9回/);
  assert.match(
    quotaNotice({ ...quota, remaining: 0, low: true }),
    /2026\/12\/1 0:00:00（日本時間）/,
  );
});
test("HTTP：共有認証・非同期ヘッダー・POST/GET/DELETEを同じIDで実行", async () => {
  const seen: { method: string; url: string; prefer?: string; body: string }[] =
    [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen.push({
      method: req.method!,
      url: req.url!,
      prefer: req.headers.prefer,
      body,
    });
    assert.equal(req.headers.authorization, `Bearer ${"a".repeat(64)}`);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/v1/coach" && req.method === "GET" ? overview : reply(),
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  try {
    const c = new AnalysisClient(`http://127.0.0.1:${addr.port}`, {
      get: async () => "a".repeat(64),
      set: async () => {},
    });
    await c.coach();
    await c.createCoach(input);
    await c.getCoach(input.requestId);
    await c.cancelCoach(input.requestId);
    assert.equal(seen[1]!.prefer, "respond-async");
    assert.deepEqual(JSON.parse(seen[1]!.body), input);
    assert.deepEqual(
      seen.map((s) => s.method),
      ["GET", "POST", "GET", "DELETE"],
    );
    assert(seen[2]!.url.endsWith(input.requestId));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("IDと本文はPOST前にDBへ保存し、二重タップ・別の棋譜でも二重消費しない", async () => {
  const s = await setup();
  let posts = 0;
  s.client.createCoach = async (i) => {
    const stored = await s.storage.load();
    assert.equal(stored[0]!.attempt!.input.requestId, i.requestId);
    assert(stored[0]!.attempt!.sentAt);
    posts++;
    return reply();
  };
  const first = s.c.start("a", input);
  await assert.rejects(
    s.c.start("b", { ...input, requestId: "other" }),
    /作っています/,
  );
  await first;
  await assert.rejects(
    s.c.start("a", { ...input, requestId: "another" }),
    /作っています/,
  );
  assert.equal(posts, 1);
  s.sql.close();
});
test("保存に失敗したら送らない", async () => {
  const s = await setup();
  s.storage.save = async () => {
    throw Error("disk");
  };
  await assert.rejects(s.c.start("a", input), /disk/);
  assert.equal(s.calls.length, 0);
  s.sql.close();
});
test("非同期：画面離脱では中止せず、再起動で同じIDをGETし完了を原子的に保存", async () => {
  const s = await setup();
  await s.c.start("a", input);
  let gets = 0;
  const c = new CoachController(
    {
      ...s.client,
      createCoach: async () => {
        throw Error("二重POST");
      },
      getCoach: async (id) => {
        assert.equal(id, input.requestId);
        gets++;
        return reply("completed");
      },
    },
    s.storage,
  );
  await c.init();
  await c.sync();
  await c.sync();
  assert.equal(gets, 1);
  assert.equal(c.snapshot.records.a!.answers.length, 1);
  assert.equal(c.snapshot.records.a!.attempt, null);
  const reopened = new CoachController(s.client, s.storage);
  await reopened.init();
  assert.equal(
    reopened.snapshot.records.a!.answers[0]!.sections[0]!.text,
    "落ち着いた駒組みでした。",
  );
  s.sql.close();
});
test("POST応答喪失：同じIDをGETして回収、再POSTしない", async () => {
  const s = await setup({
    createCoach: async () => {
      throw new TypeError("切断");
    },
    getCoach: async () => reply("completed"),
  });
  await s.c.start("a", input);
  assert(s.c.snapshot.records.a!.attempt);
  await s.c.sync();
  assert.equal(s.c.snapshot.records.a!.answers.length, 1);
  s.sql.close();
});
test("送信前に終了したoutboxは再起動で送る、送信後404は同じUUIDだけ再送する", async () => {
  const s = await setup({
    getCoach: async () => {
      throw new ApiError(404, "not_found");
    },
  });
  await s.storage.save({
    gameId: "a",
    answers: [],
    attempt: { input, sentAt: null, cancel: false },
    error: null,
  });
  await s.c.init();
  await s.c.sync();
  await s.c.sync();
  assert.deepEqual(s.calls, [input.requestId, input.requestId]);
  s.sql.close();
});
test("409 request_existsを同じIDのGETへ切り替え、履歴を一度だけ保存", async () => {
  const s = await setup({
    createCoach: async () => {
      throw new ApiError(409, "request_exists");
    },
    getCoach: async () => reply("completed"),
  });
  await s.c.start("a", input);
  await s.c.sync();
  assert.equal(s.c.snapshot.records.a!.answers.length, 1);
  s.sql.close();
});
test("期限切れの404は再POSTせず、手動での新しい依頼を待つ", async () => {
  const s = await setup({
    getCoach: async () => {
      throw new ApiError(404, "not_found");
    },
  });
  await s.storage.save({
    gameId: "a",
    answers: [],
    attempt: { input, sentAt: Date.now() - 8 * 86400000, cancel: false },
    error: null,
  });
  await s.c.init();
  await s.c.sync();
  assert.equal(s.calls.length, 0);
  assert.equal(s.c.snapshot.records.a!.attempt, null);
  assert.match(s.c.snapshot.records.a!.error!, /期限/);
  s.sql.close();
});
test("受理後のGET 503・通信なしではIDを消さず、GET復帰で結果を受け取る", async () => {
  const s = await setup({
    getCoach: async () => {
      throw new ApiError(503, "unavailable");
    },
  });
  await s.c.start("a", input);
  await s.c.sync();
  assert(s.c.snapshot.records.a!.attempt);
  s.client.getCoach = async () => reply("completed");
  await s.c.sync();
  assert.equal(s.c.snapshot.records.a!.answers.length, 1);
  assert.equal(s.calls.length, 1);
  s.sql.close();
});
test("中止の意思を保存してDELETE、通信断でも再起動でDELETEし直す", async () => {
  let fail = true,
    deletes = 0;
  const s = await setup({
    cancelCoach: async (id) => {
      assert.equal(id, input.requestId);
      deletes++;
      if (fail) throw new TypeError("offline");
      return reply("cancelled");
    },
  });
  await s.c.start("a", input);
  await s.c.cancel("a");
  assert(s.c.snapshot.records.a!.attempt!.cancel);
  const c = new CoachController(s.client, s.storage);
  await c.init();
  fail = false;
  await c.sync();
  assert.equal(deletes, 2);
  assert.equal(c.snapshot.records.a!.attempt, null);
  assert.equal(c.snapshot.records.a!.answers.length, 0);
  s.sql.close();
});
test("中止と成功が競合したらサーバーの成功を保存", async () => {
  const s = await setup({ cancelCoach: async () => reply("completed") });
  await s.c.start("a", input);
  await s.c.cancel("a");
  assert.equal(s.c.snapshot.records.a!.answers.length, 1);
  s.sql.close();
});
test("追加質問・作り直し失敗で既存解説を消さず、成功時だけ置き換える", async () => {
  const s = await setup({
    createCoach: async (i) => ({
      ...reply(i.question ? "failed" : "completed"),
      requestId: i.requestId,
    }),
  });
  await s.c.start("a", input);
  await s.c.start("a", {
    ...input,
    requestId: "q",
    question: "次に何を練習するといい？",
  });
  assert.equal(s.c.snapshot.records.a!.answers.length, 1);
  assert.equal(
    s.c.snapshot.records.a!.failedQuestion,
    "次に何を練習するといい？",
  );
  assert.match(s.c.snapshot.records.a!.error!, /回数は減っていません/);
  s.sql.close();
});
test("プロフィールとスタイル保存は順番を守り、無料・オフラインでも読み戻せる", async () => {
  const s = await setup({
    coach: async () => {
      throw TypeError("offline");
    },
  });
  const p = {
    ...defaultProfile,
    practice: ["四間飛車"],
    goal: "初段になりたい",
  };
  await Promise.all([
    s.c.setProfile(p),
    s.c.setProfile({ ...p, goal: "終盤を強くしたい" }),
  ]);
  await s.c.sync();
  const c = new CoachController(s.client, s.storage);
  await c.init();
  assert.equal(c.snapshot.profile.goal, "終盤を強くしたい");
  assert.deepEqual(c.snapshot.profile.practice, ["四間飛車"]);
  s.sql.close();
});
test("v4→v5移行は棋譜を保持し、再実行・CASCADE・プロフィールを確認", async () => {
  const s = await setup();
  s.sql.exec("DROP TABLE coaches;DROP TABLE coach_meta;PRAGMA user_version=4");
  await migrate(s.db);
  await migrate(s.db);
  assert.equal(
    s.sql.prepare("PRAGMA user_version").get()!.user_version,
    migrations.length,
  );
  await s.storage.save({
    gameId: "a",
    answers: [],
    attempt: { input, sentAt: null, cancel: false },
    error: null,
  });
  await s.storage.saveProfile(defaultProfile);
  s.sql.exec("DELETE FROM games WHERE id='a'");
  assert.equal((await s.storage.load()).length, 0);
  assert.deepEqual(await s.storage.profile(), defaultProfile);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM games").get()!.n, 1);
  s.sql.close();
});
