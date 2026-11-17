import { test } from "node:test";
import assert from "node:assert/strict";
import { AnalysisClient, ApiError } from "../src/analysis/client";
import { RealtimeController } from "../src/analysis/realtime-controller";
import type {
  RealtimeInput,
  RealtimeReply,
} from "../src/analysis/realtime-types";
const input = (n: number): RealtimeInput => ({
  initial: "startpos",
  moves: ["7g7f", "3c3d", "2g2f"].slice(0, n),
});
const reply = (patch: Partial<RealtimeReply> = {}): RealtimeReply => ({
  paid: true,
  sessionId: "session-a",
  sequence: 0,
  status: "ready",
  result: {
    ply: 1,
    score: { kind: "cp", value: 25 },
    candidates: [],
    mate: null,
  },
  idleMs: 30000,
  error: null,
  quota: {
    monthStart: 0,
    resetsAt: 200000,
    limitMs: 18000000,
    usedMs: 0,
    remainingMs: 18000000,
    low: false,
  },
  ...patch,
});
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  const calls = {
    posts: [] as RealtimeInput[],
    puts: [] as number[],
    stops: [] as string[],
    gets: 0,
  };
  const api = {
    realtime: async () => {
      calls.gets++;
      return reply({ sessionId: null, status: "off", result: null });
    },
    startRealtime: async (i: RealtimeInput) => {
      calls.posts.push(i);
      return reply();
    },
    updateRealtime: async (
      _id: string,
      _i: RealtimeInput,
      sequence: number,
    ) => {
      calls.puts.push(sequence);
      return reply({ sequence });
    },
    stopRealtime: async (id: string) => {
      calls.stops.push(id);
      return reply({ status: "off" });
    },
  };
  const controller = new RealtimeController(api, 5);
  return { api, calls, controller };
}
async function enter(c: RealtimeController) {
  c.setVisible(true);
  await flush();
}

test("認証・トークンを共用し、分岐APIには局面とsequence以外を送らない", async () => {
  const bodies: {
    path: string;
    method: string;
    body: unknown;
    auth: string | null;
  }[] = [];
  const api = new AnalysisClient(
    "https://example.test",
    { get: async () => "a".repeat(64), set: async () => {} },
    async (url, init) => {
      if (String(url).endsWith("/v1/entitlements"))
        return Response.json({ paid: true, source: "invite", expiresAt: null });
      bodies.push({
        path: String(url),
        method: init!.method!,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        auth: new Headers(init?.headers).get("Authorization"),
      });
      return Response.json(reply());
    },
  );
  await api.realtime();
  await api.startRealtime({
    ...input(1),
    mode: "precise",
    name: "送らない",
  } as RealtimeInput);
  await api.updateRealtime("a/b", input(2), 1);
  await api.stopRealtime("a/b");
  assert.deepEqual(
    bodies.map((b) => b.body),
    [null, input(1), { ...input(2), sequence: 1 }, null],
  );
  assert.equal(bodies[2]!.path, "https://example.test/v1/realtime/a%2Fb");
  assert.ok(bodies.every((b) => b.auth === `Bearer ${"a".repeat(64)}`));
  assert.equal(bodies[3]!.method, "DELETE");
});
test("準備→解析→結果、readyで短いポーリングを止める", async () => {
  const { controller: c, api, calls } = setup();
  await enter(c);
  api.startRealtime = async () => reply({ status: "preparing", result: null });
  api.realtime = async () => {
    calls.gets++;
    return reply({ status: calls.gets < 3 ? "analyzing" : "ready" });
  };
  c.move(input(1));
  await flush();
  assert.equal(c.snapshot.status, "preparing");
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(c.snapshot.status, "ready");
  const gets = calls.gets;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.gets, gets);
  await c.stop();
});
test("連続PUTは前のHTTP応答を待たず送り、逆順の結果と古いGETを捨てる", async () => {
  const { controller: c, api, calls } = setup();
  await enter(c);
  c.move(input(1));
  await flush();
  const first = deferred<RealtimeReply>(),
    second = deferred<RealtimeReply>();
  api.updateRealtime = async (_id, _i, seq) => {
    calls.puts.push(seq);
    return seq === 1 ? first.promise : second.promise;
  };
  c.move(input(2));
  await flush();
  c.move(input(3));
  await flush();
  assert.deepEqual(calls.puts, [1, 2]);
  assert.equal(c.snapshot.result, null);
  second.resolve(
    reply({ sequence: 2, result: { ...reply().result!, ply: 3 } }),
  );
  await flush();
  assert.equal({ ...c.snapshot }.result?.ply, 3);
  first.resolve(reply({ sequence: 1, result: { ...reply().result!, ply: 2 } }));
  await flush();
  assert.equal({ ...c.snapshot }.result?.ply, 3);
  await c.stop();
});
test("初回POST中の連続着手も最新局面へPUTし、旧局面を見せない", async () => {
  const { controller: c, api, calls } = setup();
  await enter(c);
  const pending = deferred<RealtimeReply>();
  api.startRealtime = async () => pending.promise;
  c.move(input(1));
  await flush();
  c.move(input(3));
  await flush();
  api.updateRealtime = async (_id, i, seq) => {
    calls.puts.push(seq);
    assert.equal(i.moves.length, 3);
    return reply({ sequence: seq, result: { ...reply().result!, ply: 3 } });
  };
  pending.resolve(reply());
  await flush();
  assert.deepEqual(calls.puts, [1]);
  assert.equal({ ...c.snapshot }.result?.ply, 3);
  await c.stop();
});
for (const scene of [
  "分岐を出る",
  "対局を閉じる",
  "オフ",
  "バックグラウンド",
] as const) {
  test(`${scene}でDELETEし、遅いPOSTの結果も回収して止める`, async () => {
    const { controller: c, api, calls } = setup();
    await enter(c);
    const pending = deferred<RealtimeReply>();
    api.startRealtime = async () => pending.promise;
    c.move(input(1));
    await flush();
    if (scene === "分岐を出る") c.leaveBranch();
    if (scene === "対局を閉じる") c.setVisible(false);
    if (scene === "オフ") c.toggle();
    if (scene === "バックグラウンド") c.setForeground(false);
    pending.resolve(reply());
    await flush();
    assert.deepEqual(calls.stops, ["session-a"]);
    assert.equal(c.snapshot.result, null);
    await c.stop();
  });
}
test("POST応答を失っても再POSTせずGET回収、停止失敗は復帰時に再DELETE", async () => {
  const { controller: c, api, calls } = setup();
  await enter(c);
  api.startRealtime = async () => {
    calls.posts.push(input(1));
    throw new TypeError("offline");
  };
  api.realtime = async () => reply();
  c.move(input(1));
  await flush();
  assert.equal(c.snapshot.status, "ready");
  assert.equal(calls.posts.length, 1);
  let online = false;
  api.stopRealtime = async (id) => {
    calls.stops.push(id);
    if (!online) throw new TypeError("offline");
    return reply({ status: "off" });
  };
  c.setForeground(false);
  await flush();
  online = true;
  api.realtime = async () => reply({ status: "off" });
  api.startRealtime = async () => reply();
  c.setForeground(true);
  await flush();
  assert.ok(calls.stops.length >= 2);
  assert.equal(c.snapshot.status, "ready");
  await c.stop();
});
test("休止はオンと結果を保ち、次の手でsequenceを進めて再開する", async () => {
  const { controller: c, api, calls } = setup();
  await enter(c);
  api.startRealtime = async () => reply({ status: "paused" });
  c.move(input(1));
  await flush();
  assert.equal(c.snapshot.status, "paused");
  assert.equal(c.snapshot.enabled, true);
  assert.equal({ ...c.snapshot }.result?.ply, 1);
  api.updateRealtime = async (_id, _i, seq) => {
    calls.puts.push(seq);
    return reply({ sequence: seq, status: "preparing", result: null });
  };
  c.move(input(2));
  await flush();
  assert.equal(c.snapshot.status, "preparing");
  assert.deepEqual(calls.puts, [1]);
  await c.stop();
});
test("月上限・残りわずかを保持し、無料なら開始しない", async () => {
  const { controller: c, api, calls } = setup();
  api.realtime = async () => reply({ paid: false, sessionId: null });
  await enter(c);
  c.move(input(1));
  await flush();
  assert.equal(calls.posts.length, 0);
  api.realtime = async () => reply({ sessionId: null });
  c.retry();
  await flush();
  api.updateRealtime = async () => {
    throw new ApiError(429, "monthly_limit", {
      ...reply().quota,
      remainingMs: 0,
      low: true,
    });
  };
  c.move(input(2));
  await flush();
  assert.equal(c.snapshot.status, "limit");
  assert.equal(c.snapshot.quota?.remainingMs, 0);
  await c.stop();
});
test("通信なし→もう一度試す、権利失効は停止する", async () => {
  const { controller: c, api, calls } = setup();
  await enter(c);
  api.startRealtime = async () => {
    throw new TypeError("offline");
  };
  api.realtime = async () => {
    throw new TypeError("offline");
  };
  c.move(input(1));
  await flush();
  assert.equal(c.snapshot.status, "offline");
  api.realtime = async () => reply({ sessionId: null });
  api.startRealtime = async () => reply();
  c.retry();
  await flush();
  assert.equal(c.snapshot.status, "ready");
  api.updateRealtime = async () => {
    throw new ApiError(403, "paid_required");
  };
  c.move(input(2));
  await flush();
  assert.equal(c.snapshot.paid, false);
  assert.deepEqual(calls.stops, ["session-a"]);
  await c.stop();
});
test("別sessionId・違うplyの結果は出さない", async () => {
  const { controller: c, api } = setup();
  await enter(c);
  c.move(input(1));
  await flush();
  api.updateRealtime = async (_id, _i, seq) =>
    reply({ sequence: seq, sessionId: "old-session" });
  c.move(input(2));
  await flush();
  assert.equal(c.snapshot.result, null);
  api.updateRealtime = async (_id, _i, seq) =>
    reply({ sequence: seq, result: { ...reply().result!, ply: 1 } });
  c.move(input(3));
  await flush();
  assert.equal(c.snapshot.result, null);
  await c.stop();
});

test("前面復帰の権利確認中はPOSTせず、回収した別局面は必ずPUTしてから表示", async () => {
  const { controller: c, api, calls } = setup();
  const entitlement = deferred<RealtimeReply>();
  api.realtime = async () => entitlement.promise;
  c.setVisible(true);
  c.move(input(1));
  await flush();
  assert.equal(calls.posts.length, 0);
  entitlement.resolve(reply({ sessionId: null, result: null }));
  await flush();
  assert.equal(calls.posts.length, 1);
  await c.stop();
  api.realtime = async () => reply({ sessionId: null, result: null });
  api.startRealtime = async () => {
    throw new TypeError("応答喪失");
  };
  const recovered = reply({
    sequence: 8,
    result: { ...reply().result!, score: { kind: "cp", value: 999 } },
  });
  const update = deferred<RealtimeReply>();
  api.updateRealtime = async (_id, _input, sequence) => {
    calls.puts.push(sequence);
    return update.promise;
  };
  api.realtime = async () => recovered;
  c.move(input(1));
  await flush();
  assert.deepEqual(calls.puts, [9]);
  assert.equal(c.snapshot.result, null);
  update.resolve(reply({ sequence: 9 }));
  await flush();
  assert.equal({ ...c.snapshot }.result?.score?.value, 25);
  await c.stop();
});
test("遅いGETは局面変更後に到着しても古い評価値を表示しない", async () => {
  const { controller: c, api } = setup();
  await enter(c);
  api.startRealtime = async () => reply({ status: "analyzing", result: null });
  const oldGet = deferred<RealtimeReply>();
  api.realtime = async () => oldGet.promise;
  c.move(input(1));
  await flush();
  await new Promise((r) => setTimeout(r, 10));
  api.updateRealtime = async (_id, _input, sequence) =>
    reply({ sequence, result: { ...reply().result!, ply: 2 } });
  c.move(input(2));
  await flush();
  oldGet.resolve(reply());
  await flush();
  assert.equal(c.snapshot.result?.ply, 2);
  await c.stop();
});
test("オンへ戻すだけでは開始せず、停止503のIDは次の操作で再送する", async () => {
  const { controller: c, api, calls } = setup();
  await enter(c);
  c.move(input(1));
  await flush();
  let fail = true;
  api.stopRealtime = async (id) => {
    calls.stops.push(id);
    if (fail) throw new ApiError(503, "unavailable");
    return reply({ status: "off" });
  };
  c.toggle();
  await flush();
  c.toggle();
  await flush();
  assert.equal(calls.posts.length, 1);
  assert.equal(c.snapshot.enabled, true);
  fail = false;
  c.move(input(2));
  await flush();
  assert.deepEqual(calls.stops, ["session-a", "session-a"]);
  assert.equal(calls.posts.length, 2);
  await c.stop();
});

for (const scene of ["画面離脱", "バックグラウンド"] as const) {
  test(`初回GETを待つ間の${scene}でも、遅れて見つかったセッションを停止する`, async () => {
    const { controller: c, api, calls } = setup();
    const pending = deferred<RealtimeReply>();
    api.realtime = async () => pending.promise;
    c.setVisible(true);
    await flush();
    if (scene === "画面離脱") c.setVisible(false);
    else c.setForeground(false);
    await flush();
    assert.deepEqual(calls.stops, []);
    pending.resolve(reply({ sessionId: "orphan-session" }));
    await flush();
    assert.deepEqual(calls.stops, ["orphan-session"]);
    assert.equal(c.snapshot.result, null);
    assert.equal(calls.posts.length, 0);
    await c.stop();
  });
}
