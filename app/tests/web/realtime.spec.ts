import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fakeAnalysis } from "../helpers/fake-analysis";
const kif = readFileSync("tests/fixtures/standard.kif", "utf8");
const button = (p: Page, name: string) =>
  p.getByRole("button", { name, exact: true });
const move = async (p: Page, f: number, from: number, to: number) => {
  await p.getByTestId(`square-${f}-${from}`).click();
  await p.getByTestId(`square-${f}-${to}`).click();
};
async function open(p: Page) {
  await p.goto("/");
  await button(p, "棋譜を取り込む").click();
  await p.getByRole("textbox", { name: "KIF形式の棋譜" }).fill(kif);
  await p.getByRole("radio", { name: "自分ではない" }).click();
  await button(p, "保存だけする").click();
  await expect(p.getByText("開始局面", { exact: true })).toBeVisible();
}
test("分岐の準備・連続局面・休止再開・オフ・本譜復帰・画面離脱・背景で停止", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  fake.rt.status = "preparing";
  fake.rt.idleMs = 10;
  await open(page);
  await move(page, 2, 7, 6);
  await expect(page.getByText("準備中", { exact: true })).toBeVisible();
  fake.rt.status = "analyzing";
  await expect(
    page.getByText("この局面の評価値と最善手を調べています"),
  ).toBeVisible();
  fake.rt.status = "ready";
  await expect(button(page, "この手を盤で試す")).toBeVisible();
  await move(page, 3, 3, 4);
  await move(page, 2, 6, 5);
  await expect.poll(() => fake.rt.requests.at(-1)?.input.moves.length).toBe(3);
  expect(fake.rt.requests.at(-1)?.sequence).toBe(2);
  expect(Object.keys(fake.rt.requests[0]!.input).sort()).toEqual([
    "initial",
    "moves",
  ]);
  fake.rt.status = "paused";
  await expect(button(page, "分岐中の解析 オン、休止中")).toBeVisible();
  fake.rt.status = "preparing";
  await move(page, 8, 3, 4);
  await expect(page.getByText("準備中", { exact: true })).toBeVisible();
  fake.rt.status = "ready";
  await expect(button(page, "この手を盤で試す")).toBeVisible();
  await button(page, "分岐中の解析 オン").click();
  await expect.poll(() => fake.rt.stops).toBe(1);
  await expect(
    page.getByText("分岐中の解析はオフ", { exact: true }).first(),
  ).toBeVisible();
  await button(page, "オンにする").click();
  expect(fake.rt.requests).toHaveLength(4); // オンだけでは課金を開始しない。
  await move(page, 2, 5, 4);
  await expect.poll(() => fake.rt.requests.length).toBe(5);
  await button(page, "本譜に戻る").first().click();
  await expect.poll(() => fake.rt.stops).toBe(2);
  await move(page, 2, 7, 6);
  await expect.poll(() => fake.rt.requests.length).toBe(6);
  await button(page, "この対局のメニュー").click();
  await button(page, "対局情報").click();
  await expect.poll(() => fake.rt.stops).toBe(3);
  await button(page, "戻る").click();
  await expect.poll(() => fake.rt.requests.length).toBe(7);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => fake.rt.stops).toBe(4);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => fake.rt.requests.length).toBe(8);
  expect(fake.errors).toEqual([]);
});
test("無料の鍵案内・通信なし再試行・残りわずか・月上限と更新日時", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  fake.paid = false;
  await open(page);
  await move(page, 2, 7, 6);
  await button(page, "分岐中の解析 有料プラン").click();
  await expect(
    page.getByText("分岐中の解析は、有料プランで使えます"),
  ).toBeVisible();
  expect(fake.rt.requests).toHaveLength(0);
  await button(page, "閉じる").click();
  await button(page, "本譜に戻る").first().click();
  fake.paid = true;
  await page.reload();
  await expect(button(page, "解析する")).toBeVisible();
  fake.online = false;
  await move(page, 2, 7, 6);
  await expect(button(page, "分岐中の解析 通信なし")).toBeVisible();
  fake.online = true;
  fake.rt.low = true;
  fake.rt.remainingMs = 12 * 60000;
  await button(page, "もう一度試す").click();
  await expect(button(page, "分岐中の解析 オン・残り12分")).toBeVisible();
  fake.rt.status = "limit";
  fake.rt.remainingMs = 0;
  await move(page, 3, 3, 4);
  await expect(button(page, "分岐中の解析 残り0分")).toBeVisible();
  await button(page, "更新日").click();
  await expect(page.getByText(/次の更新：2026/)).toBeVisible();
  expect(fake.errors).toEqual([]);
});

test("結果を保持したまま月上限になっても、再開時期と更新日を別に案内する", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  fake.rt.idleMs = 10;
  await open(page);
  await move(page, 2, 7, 6);
  const candidate = button(page, "この手を盤で試す");
  await expect(candidate).toBeVisible();
  const requests = fake.rt.requests.length;
  fake.rt.status = "limit";
  fake.rt.remainingMs = 0;
  fake.rt.low = true;
  await expect(button(page, "分岐中の解析 残り0分")).toBeVisible();
  await expect(candidate).toBeVisible();
  await expect(
    page.getByText("今月の分岐中の解析は残り0分", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("月が変わると、また300分使えます", { exact: true }),
  ).toBeVisible();
  await button(page, "更新日").click();
  await expect(page.getByText(/次の更新：2026\/12\/1 0:00:00/)).toBeVisible();
  expect(fake.rt.requests.length).toBe(requests);
  expect(fake.errors).toEqual([]);
});

test("グラフで本譜へ飛ぶと解析を停止し、2手の分岐を一度だけ復元できる", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  await open(page);
  await move(page, 2, 7, 6);
  await move(page, 3, 3, 4);
  await expect.poll(() => fake.rt.requests.at(-1)?.input.moves.length).toBe(2);
  const graph = page.getByRole("slider", { name: /形勢グラフ/ });
  await graph.click();
  await expect.poll(() => fake.rt.stops).toBe(1);
  const undo = button(page, "分岐に戻る");
  await undo.click();
  await expect(
    page.getByRole("img", { name: "分岐2手目の盤面" }),
  ).toBeVisible();
  await expect(undo).toHaveCount(0);
  await expect.poll(() => fake.rt.requests.at(-1)?.method).toBe("POST");
  await button(page, "1手戻る").click();
  await expect(
    page.getByRole("img", { name: "分岐1手目の盤面" }),
  ).toBeVisible();
  await graph.click();
  await expect(undo).toBeVisible();
  await button(page, "戻る").click();
  await expect(page.getByRole("tab", { name: "棋譜" })).toBeVisible();
  await expect(undo).toHaveCount(0);
  await expect(page.getByText("本譜に戻りました", { exact: true })).toHaveCount(
    0,
  );
});
