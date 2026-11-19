import { expect, test, type Locator } from "@playwright/test";
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

test("取り込みの無料残数と解析待ち予告を保存前に表示する", async ({ page }) => {
  const fake = await fakeAnalysis(page);
  fake.paid = false;
  fake.remaining = 7;
  const kif = readFileSync("tests/fixtures/standard.kif", "utf8");
  async function preview() {
    await page.goto("/import");
    await page.getByRole("textbox", { name: "KIF形式の棋譜" }).fill(kif);
    await page.getByRole("radio", { name: "自分ではない" }).click();
    await expect(
      page.getByText("保存・再生・解析はできます。戦績には数えません。"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "保存して解析する" }),
    ).toBeEnabled();
  }
  await page.goto("/");
  await expect(page.getByText("まだ棋譜がありません")).toBeVisible();
  await preview();
  await expect(page.getByText(/今週の解析\s+あと7局/)).toBeVisible();
  fake.reserved = 1;
  await preview();
  await expect(
    page.getByText("いまの解析が終わったら、続けて解析します"),
  ).toBeVisible();
});
