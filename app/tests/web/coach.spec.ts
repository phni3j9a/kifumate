import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fakeAnalysis, makeResults } from "../helpers/fake-analysis";
import { coachSections, fakeCoach } from "../helpers/fake-coach";
import { analysisInput, readingText } from "../../src/analysis/display";
import { readKif } from "../../src/core/kif";

const button = (p: Page, name: string) =>
  p.getByRole("button", { name, exact: true });
async function imported(p: Page, precise = true) {
  const analysis = await fakeAnalysis(p);
  const coach = await fakeCoach(p, () => analysis.paid);
  await p.goto("/");
  await button(p, "棋譜を取り込む").click();
  await p
    .getByRole("textbox", { name: "KIF形式の棋譜" })
    .fill(readFileSync("tests/fixtures/standard.kif", "utf8"));
  await p.getByRole("radio", { name: "自分ではない" }).click();
  await button(p, "保存だけする").click();
  await expect(button(p, "AIに聞く")).toBeVisible();
  if (precise) {
    analysis.complete = true;
    await button(p, "解析する").click();
    await expect(button(p, "3位")).toBeVisible();
  }
  return { analysis, coach };
}
test("AIコーチの深読み参照を評価値、盤面リンク、読み筋の再生に使う", async ({
  page,
}) => {
  const { analysis, coach } = await imported(page, false);
  const record = readKif(readFileSync("tests/fixtures/standard.kif", "utf8"));
  const results = makeResults(analysisInput(record, "precise"));
  const shallow = results[1]!;
  const candidate = shallow.candidates[1]!;
  const score = { kind: "cp" as const, value: 420 };
  const deep = {
    ...shallow,
    score,
    candidates: [{ ...candidate, rank: 1, score }],
  };
  results[1] = { ...shallow, deep };
  analysis.results = results;
  analysis.complete = true;
  coach.status = "completed";
  coach.sections = [
    {
      ...coachSections[0]!,
      references: [
        {
          id: "1:deep:candidate:1",
          ply: 1,
          score,
          pv: candidate.pv,
          provenMate: false,
        },
      ],
    },
  ];
  await button(page, "解析する").click();
  await expect(button(page, "3位")).toBeVisible();
  await button(page, "AIに聞く").click();
  await button(page, "解説をつくる").click();
  const link = button(page, "1手目の局面　評価値 +420");
  await expect(link).toBeVisible();
  expect(coach.requests[0]!.analysis.results).toEqual(results);
  expect(coach.requests[0]!.proof).toMatchObject({
    signature: "opaque-proof-kept",
  });
  record.goto(1);
  const words = readingText(record.position, candidate.pv);
  expect(words.length).toBeGreaterThan(0);
  await expect(
    page.getByTestId("coach-sheet").getByText(words.join(" "), { exact: true }),
  ).toBeVisible();
  await link.click();
  await expect(
    page.getByRole("img", { name: "1手目の盤面", exact: true }),
  ).toBeVisible();
  await button(page, "この読み筋を試す").click();
  await expect(page.getByText("分岐1手目", { exact: true })).toBeVisible();
  expect(analysis.errors).toEqual([]);
});

test("リアルタイム解析オフの分岐では、AIコーチが参照した1段目の読み筋を続けられる", async ({
  page,
}) => {
  const { analysis, coach } = await imported(page, false);
  const record = readKif(readFileSync("tests/fixtures/standard.kif", "utf8"));
  const results = makeResults(analysisInput(record, "precise"));
  const start = results[0]!;
  const shallow = {
    ...start.candidates[0]!,
    move: "2g2f",
    pv: ["2g2f", "3c3d", "2f2e"],
  };
  const deep = { ...shallow, pv: ["2g2f", "8c8d"] };
  results[0] = {
    ...start,
    candidates: [shallow],
    deep: { ...start, candidates: [deep] },
  };
  analysis.results = results;
  analysis.complete = true;
  coach.status = "completed";
  coach.sections = [
    {
      ...coachSections[0]!,
      references: [
        {
          id: "0:candidate:1",
          ply: 0,
          score: shallow.score,
          pv: shallow.pv,
          provenMate: false,
        },
      ],
    },
  ];
  await button(page, "解析する").click();
  await button(page, "AIに聞く").click();
  await button(page, "解説をつくる").click();
  await button(page, "この読み筋を試す").click();
  await button(page, "リアルタイム解析 オン").click();
  await button(page, "本譜に戻る").first().click();
  await button(page, "AIに聞く").click();
  await button(page, "この読み筋を試す").click();
  await expect(button(page, "リアルタイム解析 オフ")).toBeVisible();
  const next = button(page, "この手を盤で試す").filter({ hasText: "次の手" });
  await expect(page.getByText("△3四歩", { exact: true })).toBeVisible();
  await expect(page.getByText("△8四歩", { exact: true })).toHaveCount(0);
  await next.click();
  await expect(button(page, "棋譜を開く")).toContainText("分岐2手目△3四歩");
  await button(page, "1手進む").click();
  await expect(button(page, "棋譜を開く")).toContainText("分岐3手目▲2五歩");
});

test("AIコーチ：プロフィール保存・伏せ字・非同期の離脱と再起動・追加質問・無料/通信なしでも履歴閲覧", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const add = media.addEventListener.bind(media);
    const remove = media.removeEventListener.bind(media);
    const listeners = new Set();
    Object.assign(window, { reduceMotionListeners: () => listeners.size });
    Object.assign(media, {
      addEventListener(
        name: string,
        listener: EventListener,
        options?: AddEventListenerOptions,
      ) {
        if (name === "change") listeners.add(listener);
        add(name, listener, options);
      },
      removeEventListener(
        name: string,
        listener: EventListener,
        options?: EventListenerOptions,
      ) {
        if (name === "change") listeners.delete(listener);
        remove(name, listener, options);
      },
    });
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) =>
      query === media.media ? media : matchMedia(query);
  });
  const motionListeners = () =>
    page.evaluate(() =>
      (
        window as unknown as { reduceMotionListeners: () => number }
      ).reduceMotionListeners(),
    );
  const { analysis, coach } = await imported(page);
  await button(page, "AIに聞く").click();
  await expect(page.getByText("どこを中心に説明しますか")).toBeVisible();
  await button(page, "変更").click();
  await button(page, "四間飛車").click();
  await page
    .getByRole("textbox", { name: "目標", exact: true })
    .fill("先手の練習を続ける");
  await button(page, "戻る").click();
  await expect(
    page.getByText("練習中：四間飛車", { exact: false }),
  ).toBeVisible();
  const baseline = await motionListeners();
  await button(page, "解説をつくる").dblclick();
  await expect.poll(() => coach.requests.length).toBe(1);
  await expect(
    page.getByText("解説を作っています…", { exact: true }),
  ).toBeVisible();
  expect(coach.requests[0]!.profile.practice).toEqual(["四間飛車"]);
  expect(coach.requests[0]).not.toHaveProperty("black");
  const band = page
    .getByTestId("coach-sheet")
    .locator('rect[fill^="url(#shimmer-"]')
    .first();
  await expect(band).toBeAttached();
  await expect.poll(motionListeners).toBe(baseline + 1);
  // 最初の1100msが過ぎても動き続ける。
  const positions = await band.evaluate(async (rect) => {
    const moving = rect.closest("svg")!.parentElement!;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const values = new Set<string>();
    for (let i = 0; i < 8; i++) {
      await new Promise(requestAnimationFrame);
      values.add(getComputedStyle(moving).transform);
    }
    return values.size;
  });
  expect(positions).toBeGreaterThan(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(band).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(band).toBeAttached();
  await button(page, "AIコーチを閉じる").click();
  await expect.poll(motionListeners).toBe(baseline);
  const gets = coach.gets;
  await page.waitForTimeout(3700);
  expect(coach.gets).toBe(gets);
  expect(coach.deletes).toBe(0);
  await page.reload();
  await button(page, "AIに聞く").click();
  coach.status = "completed";
  await expect(
    page.getByText("この対局のまとめ", { exact: true }),
  ).toBeVisible();
  expect(coach.requests).toHaveLength(1);
  await button(page, "大きくする").click();
  await expect(button(page, "小さくする")).toBeVisible();
  await button(page, "開始局面　評価値 +25").click();
  await expect(button(page, "大きくする")).toBeVisible();
  await button(page, "この読み筋を試す").first().click();
  await expect(page.getByText("分岐1手目", { exact: true })).toBeVisible();
  await button(page, "本譜に戻る").first().click();
  await button(page, "AIに聞く").click();

  coach.status = "pending";
  await page
    .getByRole("textbox", { name: "AIコーチへの質問" })
    .fill("先手の次の練習は？");
  await button(page, "質問を送る").click();
  await expect.poll(() => coach.requests.length).toBe(2);
  expect(coach.requests[1]!.history[0]!.role).toBe("assistant");
  expect(coach.requests[1]!.question).toContain("先手");
  coach.status = "completed";
  await expect(
    page.getByText("先手の次の練習は？", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("この対局のまとめ", { exact: true })).toHaveCount(
    2,
  );
  // 質問の先頭を上端に寄せる（末尾までしか動かせない場合はその位置）。
  const question = page.getByText("先手の次の練習は？", { exact: true });
  await expect
    .poll(() =>
      question.evaluate((node) => {
        const row = node.parentElement!;
        let scroller = row.parentElement;
        while (scroller && getComputedStyle(scroller).overflowY !== "auto")
          scroller = scroller.parentElement;
        if (!scroller) return Infinity;
        const top =
          row.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop;
        const expected = Math.max(
          0,
          Math.min(top - 6, scroller.scrollHeight - scroller.clientHeight),
        );
        return Math.abs(scroller.scrollTop - expected);
      }),
    )
    .toBeLessThan(2);
  analysis.paid = false;
  coach.online = false;
  analysis.online = false;
  await page.reload();
  await button(page, "AIに聞く").click();
  await expect(page.getByText("この対局のまとめ", { exact: true })).toHaveCount(
    2,
  );
  await expect(
    page.getByRole("textbox", { name: "AIコーチへの質問" }),
  ).toHaveCount(0);
  // 再起動で権利を固定しない。通信が戻るまで新規生成は使わず、履歴は読める。
  expect(coach.requests).toHaveLength(2);
});
test("無料の鍵・精密への案内・失敗/再試行・中止・週上限と回復の案内", async ({
  page,
}) => {
  const { analysis, coach } = await imported(page, false);
  analysis.paid = false;
  await page.reload();
  await button(page, "AIに聞く").click();
  await expect(
    page.getByText("AIコーチは有料プランの機能です", { exact: true }),
  ).toBeVisible();
  await button(page, "AIコーチを閉じる").click();
  analysis.paid = true;
  await page.reload();
  await button(page, "AIに聞く").click();
  await expect(
    page.getByText("先に、この対局の精密解析が必要です", { exact: true }),
  ).toBeVisible();
  analysis.complete = true;
  await button(page, "精密解析する").click();
  await expect(button(page, "解説をつくる")).toBeVisible();
  coach.status = "failed";
  await button(page, "解説をつくる").click();
  await expect(
    page.getByText(/解説を終えられませんでした。今週の残りは減っていません/),
  ).toBeVisible();
  coach.status = "pending";
  await button(page, "もう一度試す").click();
  await expect.poll(() => coach.requests.length).toBe(2);
  await button(page, "中止").click();
  await button(page, "中止する").click();
  await expect.poll(() => coach.deletes).toBe(1);
  await expect(button(page, "解説をつくる")).toBeVisible();
  coach.remainingRatio = 0.09;
  await button(page, "AIコーチを閉じる").click();
  await button(page, "AIに聞く").click();
  await expect(
    page.getByText("今週のAIコーチは残りわずかです", { exact: true }),
  ).toBeVisible();
  coach.remainingRatio = 0;
  await button(page, "AIコーチを閉じる").click();
  await button(page, "AIに聞く").click();
  await expect(
    page.getByText("今週のAIコーチは上限に達しました", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/月曜0時（日本時間）に、また使えます/),
  ).toBeVisible();
  expect(coach.requests).toHaveLength(2);
});
test("POST応答喪失と再起動でも同一IDをGETし、二重POSTしない", async ({
  page,
}) => {
  const { coach } = await imported(page);
  coach.losePost = true;
  await button(page, "AIに聞く").click();
  await button(page, "解説をつくる").click();
  await expect.poll(() => coach.requests.length).toBe(1);
  await expect(page.getByText(/通信できません。保存済みの解説/)).toBeVisible();
  coach.status = "completed";
  await page.reload();
  await button(page, "AIに聞く").click();
  await expect(
    page.getByText("この対局のまとめ", { exact: true }),
  ).toBeVisible();
  expect(coach.requests).toHaveLength(1);
});

test("通信復帰の再確認は新しい依頼を作らず、保存済みの解説とチャットを保つ", async ({
  page,
}) => {
  const { coach } = await imported(page);
  coach.status = "completed";
  await button(page, "AIに聞く").click();
  await button(page, "解説をつくる").click();
  await expect(
    page.getByText("この対局のまとめ", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "AIコーチへの質問" })
    .fill("保存しておく質問");
  await button(page, "質問を送る").click();
  await expect(page.getByText("この対局のまとめ", { exact: true })).toHaveCount(
    2,
  );
  await button(page, "AIコーチを閉じる").click();
  coach.online = false;
  await button(page, "AIに聞く").click();
  await expect(page.getByText(/通信できません。保存済みの解説/)).toBeVisible();
  coach.online = true;
  await button(page, "もう一度試す").click();
  await expect(button(page, "もう一度試す")).toHaveCount(0);
  // 定期同期の1周期後にも、新規POSTやチャットの置き換えが起きないことを確かめる。
  await page.waitForTimeout(3500);
  expect(coach.requests).toHaveLength(2);
  await expect(
    page.getByText("保存しておく質問", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("この対局のまとめ", { exact: true })).toHaveCount(
    2,
  );
  await page.reload();
  await button(page, "AIに聞く").click();
  await expect(
    page.getByText("保存しておく質問", { exact: true }),
  ).toBeVisible();
});

test("設定のAIコーチゲージは有料のみ、再表示で更新し、通信なしでは最後の値を示す", async ({
  page,
}, info) => {
  const analysis = await fakeAnalysis(page);
  const coach = await fakeCoach(page, () => analysis.paid);
  coach.remainingRatio = 0.37;
  await page.goto("/settings");
  const gauge = page.getByRole("progressbar", { name: "AIコーチの今週の残り" });
  await expect(gauge).toHaveAttribute("aria-valuenow", "37");
  await expect(page.getByText("残り 37%", { exact: true })).toBeVisible();
  await expect(
    page.getByText("月曜0時（日本時間）に全回復します"),
  ).toBeVisible();
  await page.screenshot({
    path: `.local/screenshots/58-coach-weekly-budget-${info.project.name}.png`,
  });
  await page.goto("/");
  coach.remainingRatio = 0;
  await page.getByText("設定", { exact: true }).click();
  await expect(gauge).toHaveAttribute("aria-valuenow", "0");
  coach.online = false;
  await page.reload();
  await expect(gauge).toHaveAttribute("aria-valuenow", "0");
  await expect(
    page.getByText("AIコーチの残りは最後に確認した値です。"),
  ).toBeVisible();
  coach.online = true;
  analysis.paid = false;
  await page.reload();
  await expect(page.getByText("無料プラン", { exact: true })).toBeVisible();
  await expect(gauge).toHaveCount(0);
});
