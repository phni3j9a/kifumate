import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AnalysisClient,
  ApiError,
  retryAfterSeconds,
} from "../src/analysis/client";
import {
  analysisUrl,
  deviceStorageKey,
  PRODUCTION_URL,
  STAGING_URL,
} from "../src/analysis/config";
import {
  EntitlementController,
  type Entitlement,
} from "../src/entitlements/controller";
import {
  normalizeInvitation,
  formatInvitation,
  validInvitation,
  invitationError,
} from "../src/entitlements/invitation";
test("招待コードはサーバーと同じ正規化・入力中の4文字区切り・不正文字を黙って削除しない", () => {
  assert.equal(
    normalizeInvitation("ａｂｃｄ‐ｅｆｇｈ  ｊｋｍｎ—ｐｑｒｓ"),
    "ABCDEFGHJKMNPQRS",
  );
  assert.equal(formatInvitation("abcdEFghjkmnpqrs"), "ABCD-EFGH-JKMN-PQRS");
  assert.equal(formatInvitation("abcde"), "ABCD-E");
  assert.equal(formatInvitation(""), "");
  assert.equal(normalizeInvitation("ＯｉＬo"), "0110");
  for (const code of [
    "ABCD-EFGH-JKMN-PQRS",
    "0123—4567—89ab—cdef",
    "abcdefghjkmnpqrs",
  ])
    assert.ok(validInvitation(code));
  for (const code of [
    "abcd",
    "ABCD-EFGH-JKMN-PQRU",
    "ABCD-EFGH-JKMN-PQRS0",
    "ABCD−EFGH-JKMN-PQRS",
    "ABCD!EFGHJKMNPQRS",
  ])
    assert.equal(validInvitation(code), false);
});
test("開発はstaging・リリースは環境変数にかかわらず本番・トークンの保存先を分離", () => {
  assert.equal(analysisUrl(true), STAGING_URL);
  assert.equal(
    analysisUrl(true, "http://127.0.0.1:18090/"),
    "http://127.0.0.1:18090",
  );
  assert.equal(analysisUrl(false, STAGING_URL), PRODUCTION_URL);
  assert.equal(analysisUrl(false, "http://localhost:8081"), PRODUCTION_URL);
  assert.notEqual(
    deviceStorageKey(STAGING_URL),
    deviceStorageKey(PRODUCTION_URL),
  );
  assert.match(deviceStorageKey(PRODUCTION_URL), /^[\w.-]+$/);
});
test("権利を取得・取消・期限・通信断で無料へ戻し、developmentは明示許可時だけ", async () => {
  let now = 100;
  let value: Entitlement = { paid: true, source: "invite", expiresAt: 200 };
  let fail = false;
  const source = {
    entitlements: async () => {
      if (fail) throw Error();
      return value;
    },
    redeem: async () => value,
  };
  const access = new EntitlementController(source, false, () => now);
  await access.refresh();
  assert.ok(access.snapshot.entitlement.paid);
  now = 200;
  access.expire();
  assert.equal(access.snapshot.entitlement.paid, false);
  value = { paid: true, source: "invite", expiresAt: null };
  await access.refresh();
  assert.ok(access.snapshot.entitlement.paid);
  value = { paid: false, source: null, expiresAt: null };
  await access.refresh();
  assert.equal(access.snapshot.entitlement.paid, false);
  value = { paid: true, source: "development", expiresAt: null };
  await access.refresh();
  assert.equal(access.snapshot.entitlement.paid, false);
  const dev = new EntitlementController(source, true);
  await dev.refresh();
  assert.ok(dev.snapshot.entitlement.paid);
  fail = true;
  await assert.rejects(dev.refresh());
  assert.equal(dev.snapshot.entitlement.paid, false);
  assert.ok(dev.snapshot.offline);
});
test("同時照会を集約し、招待登録のあとGETで権利を確認", async () => {
  const calls: string[] = [];
  const value: Entitlement = { paid: true, source: "invite", expiresAt: null };
  const access = new EntitlementController({
    entitlements: async () => {
      calls.push("get");
      return value;
    },
    redeem: async (code) => {
      calls.push(code);
      return value;
    },
  });
  await Promise.all([access.refresh(), access.refresh()]);
  assert.deepEqual(calls, ["get"]);
  await access.redeem("ABCDEFGHJKMNPQRS");
  assert.deepEqual(calls, ["get", "ABCDEFGHJKMNPQRS", "get"]);
});
test("全有料機能の実行前はGET権利を再確認し、失効・開発用権利はPOSTしない", async () => {
  const calls: string[] = [];
  let source = "development";
  const client = new AnalysisClient(
    PRODUCTION_URL,
    { get: async () => "a".repeat(64), set: async () => {} },
    async (url, init) => {
      calls.push(`${init?.method} ${new URL(String(url)).pathname}`);
      return Response.json(
        String(url).endsWith("/entitlements")
          ? { paid: true, source, expiresAt: null }
          : {},
      );
    },
  );
  const input = { initial: "startpos", moves: ["7g7f"] };
  await assert.rejects(client.create({ ...input, mode: "precise" }), ApiError);
  await assert.rejects(client.startRealtime(input), ApiError);
  await assert.rejects(client.updateRealtime("id", input, 1), ApiError);
  assert.equal(
    calls.filter((c) => c.startsWith("POST") || c.startsWith("PUT")).length,
    0,
  );
  source = "invite";
  await client.create({ ...input, mode: "precise" });
  assert.deepEqual(calls.slice(-2), ["GET /v1/entitlements", "POST /v1/jobs"]);
});
test("招待エラーとRetry-Afterの秒数・日時を案内しコード原文を含めない", () => {
  assert.match(invitationError(new ApiError(400, "invite_invalid")), /期限/);
  assert.match(invitationError(new ApiError(409, "invite_full")), /端末数/);
  assert.match(
    invitationError(
      new ApiError(429, "invite_rate_limited", undefined, 900),
      0,
    ),
    /以降/,
  );
  assert.match(invitationError(new TypeError()), /通信/);
  assert.equal(retryAfterSeconds("60"), 60);
  assert.equal(retryAfterSeconds("Thu, 01 Jan 1970 00:15:00 GMT", 0), 900);
  assert.equal(retryAfterSeconds("broken"), undefined);
});
