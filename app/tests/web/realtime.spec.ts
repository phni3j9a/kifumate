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
  await expect(button(page, "リアルタイム解析 オン、休止中")).toBeVisible();
  fake.rt.status = "preparing";
  await move(page, 8, 3, 4);
  await expect(page.getByText("準備中", { exact: true })).toBeVisible();
  fake.rt.status = "ready";
  await expect(button(page, "この手を盤で試す")).toBeVisible();
  await button(page, "リアルタイム解析 オン").click();
  await expect.poll(() => fake.rt.stops).toBe(1);
  await expect(
    page.getByText("リアルタイム解析はオフ", { exact: true }).first(),
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
  await button(page, "リアルタイム解析 有料プラン").click();
  await expect(
    page.getByText("リアルタイム解析は、有料プランで使えます"),
  ).toBeVisible();
  expect(fake.rt.requests).toHaveLength(0);
  await button(page, "閉じる").click();
  await button(page, "本譜に戻る").first().click();
  fake.paid = true;
  await page.reload();
  await expect(button(page, "解析する")).toBeVisible();
  fake.online = false;
  await move(page, 2, 7, 6);
  await expect(button(page, "リアルタイム解析 通信なし")).toBeVisible();
  fake.online = true;
  fake.rt.low = true;
  fake.rt.remainingMs = 12 * 60000;
  await button(page, "もう一度試す").click();
  await expect(button(page, "リアルタイム解析 オン・残り12分")).toBeVisible();
  fake.rt.status = "limit";
  fake.rt.remainingMs = 0;
  await move(page, 3, 3, 4);
  await expect(button(page, "リアルタイム解析 残り0分")).toBeVisible();
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
  await expect(button(page, "リアルタイム解析 残り0分")).toBeVisible();
  await expect(candidate).toBeVisible();
  await expect(
    page.getByText("今月のリアルタイム解析は残り0分", { exact: true }),
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
  await button(page, "深く読む").click();
  await expect.poll(() => fake.rt.requests.at(-1)?.input.hold).toBe(true);
  await undo.click();
  await expect.poll(() => fake.rt.stops).toBe(2);
  await expect(
    page.getByRole("img", { name: "分岐2手目の盤面" }),
  ).toBeVisible();
  await expect(undo).toHaveCount(0);
  await expect
    .poll(() => fake.rt.requests.at(-1))
    .toMatchObject({
      method: "POST",
      input: { moves: ["2g2f", "3c3d"] },
    });
  expect(fake.rt.requests.at(-1)?.input.hold).toBeUndefined();
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

test("本譜では深く読むまで送信せず、結果・矢印だけを更新し、保存済みの候補とグラフは保つ", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  await open(page);
  fake.complete = true;
  await button(page, "解析する").click();
  await expect(button(page, "3位")).toBeVisible();
  await button(page, "1手進む").click();
  await button(page, "1手戻る").click();
  expect(fake.rt.requests).toHaveLength(0);
  const graph = page.getByRole("slider", { name: /形勢グラフ/ });
  const savedGraph = await graph.innerHTML();
  const arrow = page
    .getByRole("img", { name: "開始局面の盤面", exact: true })
    .locator('line[stroke="#19C6A5"][stroke-width="15"]');
  const savedArrow = await arrow.getAttribute("x2");
  const result = {
    ply: 0,
    depth: 8,
    score: { kind: "cp", value: 50 } as const,
    candidates: [
      {
        rank: 1,
        depth: 8,
        move: "2g2f",
        score: { kind: "cp", value: 50 } as const,
        pv: ["2g2f", "8c8d"],
      },
    ],
    mate: null,
  };
  fake.rt.result = result;
  fake.rt.searching = true;
  await button(page, "深く読む").click();
  await expect(button(page, "終了")).toBeVisible();
  await expect(page.getByText("深く読んだ結果（深さ8）")).toBeVisible();
  await expect(page.getByText(/読み進めています/)).toBeVisible();
  await expect(arrow).not.toHaveAttribute("x2", savedArrow!);
  expect(fake.rt.requests[0]).toMatchObject({
    method: "POST",
    input: { moves: [], hold: true },
  });
  const deepGraph = await graph.innerHTML();
  fake.rt.result = { ...result, depth: 14, score: { kind: "cp", value: 77 } };
  await expect(page.getByText("深く読んだ結果（深さ14）")).toBeVisible();
  await expect(page.getByText(/2六歩.+77/)).toBeVisible();
  expect(await graph.innerHTML()).toBe(deepGraph);
  await expect(button(page, "3位")).toBeVisible();
  expect(fake.requests).toHaveLength(1);
  expect(fake.rt.requests).toHaveLength(1);

  fake.rt.status = "paused";
  await expect(page.getByText("休止中", { exact: true })).toBeVisible();
  await expect(page.getByText("深く読んだ結果（深さ14）")).toBeVisible();
  fake.rt.status = "ready";
  await button(page, "再開").click();
  await expect
    .poll(() => fake.rt.requests.at(-1))
    .toMatchObject({ method: "PUT", input: { moves: [], hold: true } });
  fake.rt.result = undefined;
  await button(page, "1手進む").click();
  await expect
    .poll(() => fake.rt.requests.at(-1))
    .toMatchObject({ method: "PUT", input: { moves: ["7g7f"], hold: true } });
  await button(page, "1手戻る").click();
  await expect
    .poll(() => fake.rt.requests.at(-1))
    .toMatchObject({ method: "PUT", input: { moves: [], hold: true } });
  await button(page, "終了").click();
  await expect.poll(() => fake.rt.stops).toBe(1);
  await expect(button(page, "深く読む")).toBeVisible();
  await expect(page.getByText(/深く読んだ結果/)).toHaveCount(0);
  await expect(arrow).toHaveAttribute("x2", savedArrow!);
  expect(await graph.innerHTML()).toBe(savedGraph);
  await page.reload();
  await expect(button(page, "3位")).toBeVisible();
  expect(await graph.innerHTML()).toBe(savedGraph);
  expect(fake.rt.requests).toHaveLength(4);
  expect(fake.errors).toEqual([]);
});

test("権利確認を待たずに深く読むを押しても、無料と分かれば案内が開く", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  fake.paid = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/v1/entitlements", async (route) => {
    if (route.request().method() === "GET") await pending;
    await route.fallback();
  });
  await open(page);
  await button(page, "深く読む").click();
  await expect(button(page, "終了")).toBeVisible();
  release();
  await expect(
    page.getByText("リアルタイム解析は、有料プランで使えます"),
  ).toBeVisible();
  expect(fake.rt.requests).toHaveLength(0);
});

test("前面復帰の権利再確認中に深く読むを押し、失効が分かると有料プランを案内する", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  await open(page);
  await button(page, "深く読む").click();
  await expect(page.getByText(/深く読んだ結果/)).toBeVisible();
  await button(page, "終了").click();
  await expect.poll(() => fake.rt.stops).toBe(1);
  const visibility = (value: "hidden" | "visible") =>
    page.evaluate((value) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }, value);
  await visibility("hidden");
  fake.paid = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/v1/entitlements", async (route) => {
    if (route.request().method() === "GET") await pending;
    await route.fallback();
  });
  const checking = page.waitForRequest(
    (req) => req.url().endsWith("/v1/entitlements") && req.method() === "GET",
  );
  await visibility("visible");
  await checking;
  try {
    await button(page, "深く読む").click();
    await expect(button(page, "終了")).toBeVisible();
  } finally {
    release();
  }
  await expect(
    page.getByText("リアルタイム解析は、有料プランで使えます"),
  ).toBeVisible();
  expect(fake.rt.requests).toHaveLength(1);
});

test("未解析の本譜で月上限に達しても更新日ボタンはリアルタイム解析だけ", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  fake.rt.status = "limit";
  fake.rt.remainingMs = 0;
  fake.rt.result = null;
  await open(page);
  await button(page, "深く読む").click();
  await expect(page.getByText("今月のリアルタイム解析は残り0分")).toBeVisible();
  await expect(button(page, "解析する")).toBeVisible();
  const reset = button(page, "更新日");
  await expect(reset).toHaveCount(1);
  await reset.click();
  await expect(page.getByText(/次の更新：2026\/12\/1 0:00:00/)).toBeVisible();
});

test("深く読むは無料では案内し、背景・画面離脱で終了して復帰時に再開しない", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  fake.paid = false;
  await open(page);
  const gameUrl = page.url();
  await button(page, "深く読む").click();
  await expect(
    page.getByText("リアルタイム解析は、有料プランで使えます"),
  ).toBeVisible();
  await button(page, "有料プランを見る").click();
  await expect(
    page.getByText("リアルタイム解析", { exact: true }),
  ).toBeVisible();
  expect(fake.rt.requests).toHaveLength(0);
  fake.paid = true;
  await page.goto(gameUrl);
  await expect(button(page, "解析する")).toBeVisible();
  await button(page, "深く読む").click();
  await expect(page.getByText(/深く読んだ結果/)).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => fake.rt.stops).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(button(page, "深く読む")).toBeVisible();
  expect(fake.rt.requests).toHaveLength(1);
  await button(page, "深く読む").click();
  await expect(page.getByText(/深く読んだ結果/)).toBeVisible();
  await button(page, "この対局のメニュー").click();
  await button(page, "対局情報").click();
  await expect.poll(() => fake.rt.stops).toBe(2);
  await button(page, "戻る").click();
  await expect(button(page, "深く読む")).toBeVisible();
  expect(fake.rt.requests).toHaveLength(2);
  expect(fake.errors).toEqual([]);
});
