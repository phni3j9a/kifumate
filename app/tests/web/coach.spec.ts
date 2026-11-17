import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fakeAnalysis } from "../helpers/fake-analysis";
import { fakeCoach } from "../helpers/fake-coach";
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
test("AIコーチ：プロフィール保存・伏せ字・非同期の離脱と再起動・追加質問・無料/通信なしでも履歴閲覧", async ({
  page,
}) => {
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
  await button(page, "解説をつくる").dblclick();
  await expect.poll(() => coach.requests.length).toBe(1);
  await expect(
    page.getByText("解説を作っています…", { exact: true }),
  ).toBeVisible();
  expect(coach.requests[0]!.profile.practice).toEqual(["四間飛車"]);
  expect(coach.requests[0]).not.toHaveProperty("black");
  await button(page, "AIコーチを閉じる").click();
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
  ).toBeVisible();
  // 最後に確認した権利はキャッシュされるが、新規POSTには必ずサーバー権利検証がある。
  expect(coach.requests).toHaveLength(2);
});
test("無料の鍵・精密への案内・失敗/再試行・中止・月上限と更新日時", async ({
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
    page.getByText(/解説を終えられませんでした。回数は減っていません/),
  ).toBeVisible();
  coach.status = "pending";
  await button(page, "もう一度試す").click();
  await expect.poll(() => coach.requests.length).toBe(2);
  await button(page, "中止").click();
  await button(page, "中止する").click();
  await expect.poll(() => coach.deletes).toBe(1);
  await expect(button(page, "解説をつくる")).toBeVisible();
  coach.remaining = 9;
  coach.low = true;
  await button(page, "AIコーチを閉じる").click();
  await button(page, "AIに聞く").click();
  await expect(
    page.getByText("AIコーチは、今月あと9回使えます", { exact: true }),
  ).toBeVisible();
  coach.remaining = 0;
  await button(page, "AIコーチを閉じる").click();
  await button(page, "AIに聞く").click();
  await expect(
    page.getByText("今月のAIコーチは上限に達しました", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/次の更新：2026\/12\/1 0:00:00/)).toBeVisible();
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
