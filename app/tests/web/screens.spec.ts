import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fakeAnalysis } from "../helpers/fake-analysis";
import { seedGames } from "../helpers/seed-games";

// 対象の縦スクロールだけを動かす（モーダルや横チップ列を拾わない）。
const offset = (child: Locator, y?: number) =>
  child.evaluate((el, y) => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      if (!/^(auto|scroll)$/.test(getComputedStyle(node).overflowY)) continue;
      if (y !== undefined) node.scrollTop = y;
      return node.scrollTop;
    }
    throw new Error("縦スクロールが見つかりません");
  }, y);

test("無料残数からプランへ移動し、絞り込みと選択中タブの再押下で先頭に戻る", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  fake.paid = false;
  fake.remaining = 7;
  const button = (name: string | RegExp) =>
    page.getByRole("button", { name, exact: typeof name === "string" });
  const tab = (name: string) => page.getByRole("tab", { name, exact: true });
  await page.setViewportSize({
    width: page.viewportSize()!.width,
    height: 540,
  });
  await page.goto("/");
  await expect(page.getByText("まだ棋譜がありません")).toBeVisible();
  await seedGames(
    page,
    Array.from({ length: 14 }, (_, i) => ({
      id: `screen-${i}`,
      date: "2026-11-15",
      sente: `つばめ${i}`,
      gote: "こまどり",
      self: "s",
      win: "s",
      plies: 5,
      fav: true,
      tags: {
        s: { st: ["居飛車"], cs: ["美濃囲い"] },
        g: { st: ["振り飛車"], cs: ["美濃囲い"] },
      },
    })),
  );
  await button("今週の解析 あと7局").click();
  await expect(page).toHaveURL(/\/plan$/);
  await button("戻る").click();
  const card = button(/つばめ\d+ 対 こまどり、5手を開く/).first();
  const toMiddle = async (anchor: Locator) =>
    expect(await offset(anchor, 230)).toBeGreaterThan(0);
  const atTop = (anchor: Locator) => expect.poll(() => offset(anchor)).toBe(0);
  await toMiddle(card);
  await button("お気に入り").click();
  await atTop(card);
  await button("検索").click();
  await toMiddle(card);
  await page.getByLabel("棋譜を検索").fill("こまどり");
  await expect.poll(() => offset(card)).toBeGreaterThan(0);
  await button("絞り込み").click();
  await button("自分の対局").click();
  await button("14局を表示").click();
  await atTop(card);
  await toMiddle(card);
  await tab("棋譜").click();
  await atTop(card);
  await tab("戦績").click();
  const period = page.getByRole("radio", { name: "全期間", exact: true });
  await toMiddle(period);
  await tab("戦績").click();
  await atTop(period);
  await tab("設定").click();
  const profile = button(/^学習プロフィール/);
  await toMiddle(profile);
  await tab("設定").click();
  await atTop(profile);
});

const kif = readFileSync("tests/fixtures/standard.kif", "utf8");
async function importPreview(page: Page) {
  await page.goto("/import");
  await page.getByRole("textbox", { name: "KIF形式の棋譜" }).fill(kif);
  await page.getByRole("radio", { name: "自分ではない" }).click();
  await expect(
    page.getByText("保存・再生・解析はできます。戦績には数えません。"),
  ).toBeVisible();
}
const analyzeButton = (page: Page) =>
  page.getByRole("button", { name: "保存して解析する" });
const queuedNotice = (page: Page) =>
  page.getByText("いまの解析が終わったら、続けて解析します");

test("取り込みの無料残数と解析待ち予告を保存前に表示する", async ({ page }) => {
  const fake = await fakeAnalysis(page);
  fake.paid = false;
  fake.remaining = 7;
  await importPreview(page);
  await expect(page.getByText(/今週の解析\s+あと7局/)).toBeVisible();
  await expect(analyzeButton(page)).toBeEnabled();
  fake.reserved = 1;
  await importPreview(page);
  await expect(queuedNotice(page)).toBeVisible();
});

test("有料の残数を権利確認の遅延・失敗・不一致時に無料枠として表示しない", async ({
  page,
}) => {
  await fakeAnalysis(page, { onboarding: true });
  // 紹介を終えてから再読込し、/quota だけが先に届くようにする。
  await page.goto("/");
  await page.getByRole("button", { name: "スキップ" }).click();
  await expect(page.getByText("まだ棋譜がありません")).toBeVisible();
  const gate = Promise.withResolvers<void>();
  let status = 503;
  await page.route("**/v1/entitlements", async (route) => {
    await gate.promise;
    await route.fulfill({
      status,
      headers: { "Access-Control-Allow-Origin": "*" },
      json:
        status === 200
          ? { paid: false, source: null, expiresAt: null }
          : { error: "unavailable" },
    });
  });
  const quota = page.waitForResponse("**/v1/quota");
  await importPreview(page);
  expect((await (await quota).json()).totalRemaining).toBe(99);
  const pendingNote = page.getByText("解析の残り回数を確認しています…");
  const paidAsFree = page.getByText(/今週の解析\s+あと99局/);
  try {
    await expect(pendingNote).toBeVisible();
    await expect(paidAsFree).toHaveCount(0);
  } finally {
    gate.resolve();
  }
  await expect(page.getByText("解析の残り回数を確認できません")).toBeVisible();
  await expect(paidAsFree).toHaveCount(0);

  // 権利確認が成功しても、残数を算出したプランが違えば表示しない。
  status = 200;
  const checked = page.waitForResponse("**/v1/entitlements");
  await importPreview(page);
  expect((await checked).ok()).toBe(true);
  await expect(pendingNote).toBeVisible();
  await expect(paidAsFree).toHaveCount(0);
});

test("オフラインで週をまたいだら保存済みの残数0と古い更新日時を出さない", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  fake.paid = false;
  fake.remaining = 0;
  await importPreview(page);
  const exhausted = page.getByText(/今週の解析枠は残っていません。次の更新：/);
  await expect(exhausted).toBeVisible();

  fake.online = false;
  // 権利だけ確認できても、解析APIに接続できなければ先週の残数を使わない。
  await page.route("**/v1/entitlements", (route) =>
    route.fulfill({
      headers: { "Access-Control-Allow-Origin": "*" },
      json: { paid: false, source: null, expiresAt: null },
    }),
  );
  await page.clock.setFixedTime(fake.resetsAt + 1000);
  const checked = page.waitForResponse("**/v1/entitlements");
  await importPreview(page);
  expect((await checked).ok()).toBe(true);
  await expect(
    page.getByText("通信できないため、今週の解析の残り回数を確認できません"),
  ).toBeVisible();
  await expect(exhausted).toHaveCount(0);
  await expect(analyzeButton(page)).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "保存だけする" }),
  ).toBeEnabled();
});

test("精密枠がないときは順番待ちより先にふつうの解析へ案内する", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  fake.precise = 0;
  fake.reserved = 1;
  await importPreview(page);
  await expect(
    page.getByText(/ふつうの解析に切り替えてください/),
  ).toBeVisible();
  await expect(analyzeButton(page)).toBeDisabled();
  await expect(queuedNotice(page)).toHaveCount(0);
  await page.getByRole("radio", { name: "ふつうの解析", exact: true }).click();
  await expect(analyzeButton(page)).toBeEnabled();
  await expect(queuedNotice(page)).toBeVisible();
});
