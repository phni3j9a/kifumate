import { test, expect } from "@playwright/test";
import { fakeAnalysis } from "../helpers/fake-analysis";
test("設定から招待入力・正規化・有料化・再起動・取消で無料へ戻る・ストア表現なし", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  fake.paid = false;
  fake.remaining = 10;
  await page.goto("/settings");
  await page.getByRole("button", { name: /招待コードを入力/ }).click();
  const code = page.getByRole("textbox", { name: "招待コード", exact: true });
  await code.fill("ａｂｃｄｅｆｇｈｊｋｍｎｐｑｒｓ");
  await expect(code).toHaveValue("ABCD-EFGH-JKMN-PQRS");
  await page.getByRole("button", { name: "コードを使う", exact: true }).click();
  await expect(
    page.getByText("有料プランを利用中", { exact: true }),
  ).toBeVisible();
  await expect(code).toHaveValue("");
  expect(fake.redeemed).toEqual([{ code: "ABCDEFGHJKMNPQRS" }]);
  await page.reload();
  await expect(
    page.getByText("有料プランを利用中", { exact: true }),
  ).toBeVisible();
  fake.paid = false;
  await page
    .getByRole("button", { name: "今の権利を確認", exact: true })
    .click();
  await expect(page.getByText("無料プラン", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "戻る", exact: true }).click();
  await page
    .getByRole("button", { name: "有料プランを見る", exact: true })
    .click();
  await expect(
    page.getByText("招待コードで使えます", { exact: true }),
  ).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(
    /月額|購入|解約|ストア/,
  );
  expect(fake.errors).toEqual([]);
});
test("入力エラー・端末上限・再試行日時・通信なし・期限切れで無料", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  fake.paid = false;
  await page.goto("/invitation");
  const code = page.getByRole("textbox", { name: "招待コード", exact: true });
  const submit = page.getByRole("button", {
    name: "コードを使う",
    exact: true,
  });
  await code.fill("abcd");
  await submit.click();
  await expect(page.getByText(/コードは半角英数字16文字/)).toBeVisible();
  await code.fill("abcd-efgh-jkmn-pqrs");
  for (const [error, status, text] of [
    ["invite_invalid", 400, "コードが違うか"],
    ["invite_full", 409, "端末数の上限"],
    ["invite_rate_limited", 429, "以降に"],
  ] as const) {
    fake.inviteError = error;
    fake.inviteStatus = status;
    await submit.click();
    await expect(page.getByText(new RegExp(text))).toBeVisible();
  }
  fake.online = false;
  await submit.click();
  await expect(page.getByText(/接続を確かめて/)).toBeVisible();
  fake.online = true;
  fake.inviteError = "";
  fake.entitlementExpiresAt = Date.now() + 3000;
  await submit.click();
  await expect(
    page.getByText("有料プランを利用中", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/^期限：/)).toBeVisible();
  await expect(page.getByText("無料プラン", { exact: true })).toBeVisible({
    timeout: 15000,
  });
});
