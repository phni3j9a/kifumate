import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { analysisInput } from "../../src/analysis/display";
import { readKif } from "../../src/core/kif";
import { fakeAnalysis, makeResults } from "../helpers/fake-analysis";
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

test("通信復帰後のダイアログから再試行すると古いoffline状態に戻らず依頼できる", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  await importOne(page);
  fake.online = false;
  await page.reload();
  await expect(
    page.getByText("通信できません。つながると解析できます", { exact: true }),
  ).toBeVisible();
  await button(page, "解析する").click();
  await expect(
    page.getByRole("heading", { name: "通信できません" }),
  ).toBeVisible();
  fake.online = true;
  await button(page, "もう一度試す").click();
  await expect.poll(() => fake.requests.length).toBe(1);
  await expect(button(page, "中止")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "通信できません" }),
  ).toHaveCount(0);
});

test("観戦棋譜の反転でも先後と勝率・グラフ・候補の基準は変わらず矢印だけ盤に追従する", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  await importOne(page);
  fake.complete = true;
  // 最初のPOST本文から合法な候補を作り、開始局面の評価だけをはっきりした先手有利にする。
  fake.results = makeResults(analysisInput(readKif(kif), "precise"));
  fake.results[0]!.score = { kind: "cp", value: 1200 };
  await button(page, "解析する").click();
  await expect(button(page, "3位")).toBeVisible();
  await expect(page.getByText("先手 88%", { exact: true })).toBeVisible();
  const graph = page.getByRole("slider", { name: /形勢グラフ/ });
  const graphBefore = await graph.innerHTML();
  const arrow = page
    .getByRole("img", { name: "開始局面の盤面", exact: true })
    .locator('line[stroke="#19C6A5"][stroke-width="15"]');
  expect(Number(await arrow.getAttribute("y2"))).toBeLessThan(
    Number(await arrow.getAttribute("y1")),
  );
  await button(page, "この対局のメニュー").click();
  await button(page, "盤の向きを変える").click();
  await expect(page.getByText("先手 88%", { exact: true })).toBeVisible();
  await expect(page.getByText("12% 後手", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("img", { name: "先手の勝率 88%", exact: true }),
  ).toBeVisible();
  expect(await graph.innerHTML()).toBe(graphBefore);
  await expect(page.getByText("▲7六歩", { exact: true })).toBeVisible();
  expect(Number(await arrow.getAttribute("y2"))).toBeGreaterThan(
    Number(await arrow.getAttribute("y1")),
  );
});

test("応答不明から7日経った依頼は自動再送せず、確認してからだけ新しく依頼する", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  await importOne(page);
  await page.clock.pauseAt(new Date());
  fake.loseCreateResponse = true;
  await button(page, "解析する").click();
  await expect(page.getByText("中断中", { exact: true }).first()).toBeVisible();
  const sent = fake.requests.length;
  await page.clock.setSystemTime(new Date(Date.now() + 7 * 86400000));
  await page.reload();
  await page.clock.resume();
  await expect(button(page, "依頼を確認")).toBeVisible();
  expect(fake.requests.length).toBe(sent);
  await button(page, "依頼を確認").click();
  await expect(
    page.getByRole("heading", { name: "前回の依頼の結果が分かりません" }),
  ).toBeVisible();
  await button(page, "やめる").click();
  expect(fake.requests.length).toBe(sent);
  await button(page, "依頼を確認").click();
  fake.loseCreateResponse = false;
  await button(page, "もう一度解析する").click();
  await expect.poll(() => fake.requests.length).toBe(sent + 1);
  await expect(button(page, "中止")).toBeVisible();
});

test("精密依頼の応答喪失後に失効しても、再起動で結果を回収して無料で読める", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  fake.loseCreateResponse = true;
  await importOne(page);
  await page.clock.pauseAt(new Date());
  await button(page, "解析する").click();
  await expect.poll(() => fake.requests.length).toBe(1);
  await expect(page.getByText("中断中", { exact: true }).first()).toBeVisible();
  fake.paid = false;
  fake.loseCreateResponse = false;
  fake.complete = true;
  await page.reload();
  await page.clock.resume();
  await expect(button(page, "3位")).toBeVisible();
  expect(fake.requests).toHaveLength(2);
  expect(fake.requests[1]).toEqual(fake.requests[0]);
  await button(page, "戻る").click();
  await page.getByRole("tab", { name: /設定/ }).click();
  await expect(page.getByText("無料プラン", { exact: true })).toBeVisible();
  expect(fake.errors).toEqual([]);
});

test("初回の誘導・途中から向き直るゲージと視差軽減", async ({ page }) => {
  const fake = await fakeAnalysis(page, { firstReview: true });
  await importOne(page);
  fake.results = makeResults(analysisInput(readKif(kif), "precise"));
  fake.results[0]!.score = { kind: "cp", value: 1200 };
  fake.results[1]!.score = { kind: "cp", value: -1200 };
  await button(page, "解析する").click();
  await button(page, "1手進む").click();
  fake.complete = true;
  await expect(
    page.getByRole("heading", { name: "はじめての解析ができました" }),
  ).toBeVisible();
  await button(page, "見てみる").click();
  await expect(page.getByRole("img", { name: "開始局面の盤面" })).toBeVisible();
  const track = page.getByRole("img", { name: /先手の勝率/ });
  await expect(track).toHaveAccessibleName("先手の勝率 88%");
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLElement>('[aria-label="先手の勝率 88%"] > div')
        ?.style.width === "88%",
  );
  const samples = await page.evaluate(async () => {
    const find = (name: string) =>
      document.querySelector<HTMLElement>(`[aria-label="${name}"]`)!;
    const width = () =>
      parseFloat(
        document.querySelector<HTMLElement>('[aria-label^="先手の勝率"] > div')!
          .style.width,
      );
    const frames = (test: () => boolean) =>
      new Promise<void>((resolve, reject) => {
        const end = performance.now() + 1000;
        const tick = () =>
          test()
            ? resolve()
            : performance.now() > end
              ? reject(Error("幅が更新されません"))
              : requestAnimationFrame(tick);
        tick();
      });
    find("1手進む").click();
    await frames(
      () => !!find("先手の勝率 12%") && width() < 80 && width() > 25,
    );
    const before = width();
    find("1手戻る").click();
    await frames(() => !!find("先手の勝率 88%"));
    const reversed = width();
    await frames(() => width() === 88);
    return { before, reversed };
  });
  expect(samples.reversed).toBeGreaterThan(12);
  expect(samples.reversed).toBeLessThan(88);
  expect(Math.abs(samples.reversed - samples.before)).toBeLessThan(25);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await button(page, "1手進む").click();
  await expect(track).toHaveAccessibleName("先手の勝率 12%");
  expect(
    await track
      .locator(":scope > div")
      .first()
      .evaluate((node: HTMLElement) => node.style.width),
  ).toBe("12%");
  await button(page, "最後へ").click();
  const end = page.getByRole("img", { name: "先手の勝ち", exact: true });
  await expect(end.locator(":scope > div").first()).toHaveAttribute(
    "style",
    /width: 100%/,
  );
  await page.reload();
  await expect(button(page, "3位")).toBeVisible();
  await expect(button(page, "見てみる")).toHaveCount(0);
});
