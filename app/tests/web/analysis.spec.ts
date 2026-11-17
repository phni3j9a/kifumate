import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fakeAnalysis } from "../helpers/fake-analysis";
const kif = readFileSync("tests/fixtures/standard.kif", "utf8");
const button = (p: Page, name: string) =>
  p.getByRole("button", { name, exact: true });
async function importOne(p: Page) {
  await p.goto("/");
  await button(p, "棋譜を取り込む").click();
  await p.getByRole("textbox", { name: "KIF形式の棋譜" }).fill(kif);
  await p.getByRole("radio", { name: "自分ではない" }).click();
  await button(p, "保存だけする").click();
  await expect(p.getByText("開始局面", { exact: true })).toBeVisible();
}
test("解析依頼・進行・通信断・再起動・別画面の完了通知・オフライン保存済み精密候補", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  await importOne(page);
  await button(page, "解析する").click();
  await expect(button(page, "中止")).toBeVisible();
  await expect.poll(() => fake.requests[0]?.mode).toBe("precise");
  expect(Object.keys(fake.requests[0]!).sort()).toEqual([
    "initial",
    "mode",
    "moves",
  ]);
  fake.next = 3;
  await expect(page.getByText("2 / 5手", { exact: true })).toBeVisible();
  fake.online = false;
  await expect(page.getByText("中断中", { exact: true }).first()).toBeVisible();
  await button(page, "1手進む").click();
  await expect(page.getByText("+25").first()).toBeVisible();
  fake.online = true;
  await page.reload();
  await expect(button(page, "中止")).toBeVisible();
  await expect(page.getByText("中断中", { exact: true })).toHaveCount(0);
  await button(page, "戻る").click();
  fake.complete = true;
  await expect(
    page.getByText("対局の解析が終わりました", { exact: true }),
  ).toBeVisible();
  await button(page, "開く").click();
  await expect(button(page, "2位")).toBeVisible();
  await button(page, "3位").click();
  await expect(page.getByLabel(/勝率/).first()).toBeVisible();
  fake.online = false;
  await page.reload();
  await expect(button(page, "3位")).toBeVisible();
  await button(page, "3位").click();
  await button(page, "この手を盤で試す").click();
  await expect(page.getByText("分岐1手目", { exact: true })).toBeVisible();
  expect(fake.errors).toEqual([]);
});
test("中止の確認・解析待ちの取り消し・上限と設定・失敗後の再依頼", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  await importOne(page);
  await button(page, "解析する").click();
  await button(page, "中止").click();
  await expect(page.getByText("解析を中止しますか")).toBeVisible();
  await button(page, "続ける").click();
  expect(fake.cancel).toBe(0);
  await button(page, "中止").click();
  await button(page, "中止する").click();
  await expect(button(page, "解析する")).toBeVisible();
  expect(fake.cancel).toBe(1);
  fake.status = "queued";
  await button(page, "解析する").click();
  await expect(
    page.getByText("解析待ち", { exact: true }).first(),
  ).toBeVisible();
  await button(page, "やめる").click();
  await expect(button(page, "解析する")).toBeVisible();
  expect(fake.cancel).toBe(2);
  fake.status = "failed";
  await button(page, "解析する").click();
  await expect(
    page.getByText("解析を終えられませんでした", { exact: true }).first(),
  ).toBeVisible();
  fake.status = "running";
  await button(page, "もう一度").click();
  await expect(button(page, "中止")).toBeVisible();
  await button(page, "中止").click();
  await button(page, "中止する").click();
  fake.remaining = 0;
  fake.precise = 0;
  await button(page, "戻る").click();
  await page.getByRole("tab", { name: /設定/ }).click();
  await expect(
    page.getByLabel("解析の合計（今週） 残り0局", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/月曜の午前0時/)).toBeVisible();
  expect(fake.errors).toEqual([]);
});
