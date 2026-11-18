import { test, expect, type Page } from "@playwright/test";
import { fakeAnalysis } from "../helpers/fake-analysis";
const b = (p: Page, name: string) =>
  p.getByRole("button", {
    name,
    exact: ![
      "学習プロフィール",
      "使い方をもう一度見る",
      "バックアップと復元",
    ].includes(name),
  });
async function choose(page: Page, path: string) {
  const picker = page.waitForEvent("filechooser");
  await b(page, "ファイルを選ぶ").last().click();
  await (await picker).setFiles(path);
}
test("初回7場面・任意の名前/目標・戻る・完了後の再起動と設定からの再表示", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page, { onboarding: true });
  fake.paid = false;
  await page.goto("/");
  await expect(page.getByText("kifumateへ ようこそ")).toBeVisible();
  await b(page, "はじめる").click();
  await page
    .getByRole("textbox", { name: "対局で使っている名前" })
    .fill("つばめ");
  await b(page, "次へ").click();
  await expect(page.getByText("形勢グラフを読む")).toBeVisible();
  await b(page, "前へ").click();
  await expect(
    page.getByRole("textbox", { name: "対局で使っている名前" }),
  ).toHaveValue("つばめ");
  await b(page, "次へ").click();
  await b(page, "次へ").click();
  await expect(page.getByText("分岐を試す")).toBeVisible();
  await b(page, "次へ").click();
  await expect(page.getByText("コーチに質問")).toBeVisible();
  await b(page, "次へ").click();
  await b(page, "矢倉").click();
  await page
    .getByRole("textbox", { name: "目標", exact: true })
    .fill("初段になりたい");
  await b(page, "次へ").click();
  await expect(page.getByText("さあ、はじめよう")).toBeVisible();
  await b(page, "あとで").click();
  await expect(page.getByText("まだ棋譜がありません")).toBeVisible();
  await page.reload();
  await expect(page.getByText("まだ棋譜がありません")).toBeVisible();
  await page.getByRole("tab", { name: "設定" }).click();
  await expect(page.getByText("つばめ", { exact: true })).toBeVisible();
  await b(page, "学習プロフィール").click();
  await expect(
    page.getByRole("textbox", { name: "目標", exact: true }),
  ).toHaveValue("初段になりたい");
  await b(page, "戻る").click();
  await b(page, "使い方をもう一度見る").click();
  await expect(page.getByText("kifumateへ ようこそ")).toBeVisible();
  await expect(b(page, "バックアップから復元する")).toHaveCount(0);
  await b(page, "スキップ").click();
  await expect(page.getByText("使い方をもう一度見る")).toBeVisible();
  expect(fake.requests).toHaveLength(0);
});
test("見本の対局→ファイル保存→空の別端末へ復元、統合・置換の確認と取消", async ({
  page,
  browser,
}, testInfo) => {
  const fake = await fakeAnalysis(page);
  fake.paid = false;
  await page.goto("/");
  await expect(page.getByText("まだ棋譜がありません")).toBeVisible();
  await b(page, "見本の対局で試してみる").click();
  await expect(page.getByRole("img", { name: /先手の勝率/ })).toBeVisible();
  await b(page, "戻る").click();
  await expect(page.getByText("サンプル", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "戦績" }).click();
  await expect(page.getByText("まだ集計できる対局がありません")).toBeVisible();
  await page.getByRole("tab", { name: "設定" }).click();
  await b(page, "学習プロフィール").click();
  await b(page, "矢倉").click();
  await page
    .getByRole("textbox", { name: "目標", exact: true })
    .fill("復元した目標を守る");
  await b(page, "戻る").click();
  await b(page, "バックアップと復元").click();
  await b(page, "書き出す").click();
  const download = page.waitForEvent("download");
  await b(page, "ファイルに保存").click();
  const file = await download,
    path = testInfo.outputPath(file.suggestedFilename());
  await file.saveAs(path);
  const other = await browser.newContext({
      viewport: { width: Number(testInfo.project.name), height: 852 },
    }),
    target = await other.newPage();
  const api = await fakeAnalysis(target, { onboarding: true });
  api.paid = false;
  try {
    await target.goto("/");
    await b(target, "バックアップから復元する").click();
    await b(target, "やめる").click();
    await b(target, "戻る").click();
    await expect(target.getByText("kifumateへ ようこそ")).toBeVisible();
    await b(target, "バックアップから復元する").click();
    await choose(target, path);
    await expect(
      target.getByText("棋譜 1局・重複 0局。復元する方法を選んでください。"),
    ).toBeVisible();
    await b(target, "すべて置きかえる").click();
    await expect(
      target.getByText("このバックアップで置きかえますか"),
    ).toBeVisible();
    await b(target, "置きかえる").click();
    await expect(
      target.getByText("復元しました", { exact: true }),
    ).toBeVisible();
    await b(target, "OK").click();
    await expect(target.getByText("サンプル", { exact: true })).toBeVisible();
    expect(
      await target.evaluate(() => {
        const require = (globalThis as any).__r;
        const entry = [...require.getModules().entries()].find(
          ([, m]: any) =>
            m.verboseName ===
            "node_modules/expo-router/build/imperative-api.js",
        ) as any;
        return require(entry[0]).router.canGoBack();
      }),
    ).toBe(false);
    await target.getByRole("tab", { name: "設定" }).click();
    await b(target, "学習プロフィール").click();
    await expect(
      target.getByRole("textbox", { name: "目標", exact: true }),
    ).toHaveValue("復元した目標を守る");
    await expect(b(target, "矢倉")).toHaveAttribute("aria-selected", "true");
    await b(target, "戻る").click();
    await target.getByRole("tab", { name: "棋譜" }).click();
    await expect(target).toHaveURL(/\/$/);
    await expect(target.getByText("サンプル", { exact: true })).toBeVisible();
    await target.reload();
    await expect(target.getByText("サンプル", { exact: true })).toBeVisible();
    await target.getByRole("tab", { name: "設定" }).click();
    await b(target, "バックアップと復元").click();
    await choose(target, path);
    await b(target, "既存データと統合する").click();
    await b(target, "統合する").click();
    await expect(target.getByText(/同じ棋譜 1局は省きました/)).toBeVisible();
    await b(target, "OK").click();
    await target.getByRole("tab", { name: "設定" }).click();
    await b(target, "バックアップと復元").click();
    await choose(target, path);
    await b(target, "すべて置きかえる").click();
    await b(target, "やめる").click();
    await target.reload();
    await b(target, "戻る").click();
    await target.getByRole("tab", { name: "棋譜" }).click();
    await expect(target.getByText("サンプル", { exact: true })).toBeVisible();
    expect(api.requests).toHaveLength(0);
  } finally {
    await other.close();
  }
  expect(fake.requests).toHaveLength(0);
});
test("壊れたバックアップと未来版は変更せず理由を表示", async ({ page }) => {
  await fakeAnalysis(page);
  await page.goto("/");
  await page.getByRole("tab", { name: "設定" }).click();
  await b(page, "バックアップと復元").click();
  for (const [content, message] of [
    ["{", /壊れている/],
    [JSON.stringify({ format: "kifumate-backup", version: 999 }), /新しい版/],
  ] as const) {
    const picker = page.waitForEvent("filechooser");
    await b(page, "ファイルを選ぶ").last().click();
    await (
      await picker
    ).setFiles({
      name: "broken.kifumate",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(content),
    });
    await expect(page.getByRole("alert")).toContainText(message);
  }
  await b(page, "戻る").click();
  await page.getByRole("tab", { name: "棋譜" }).click();
  await expect(page.getByText("まだ棋譜がありません")).toBeVisible();
});

test("途中解析の未受信局面は上部も未解析、先後を変えた見本は検索の戦績に数えない", async ({
  page,
}) => {
  await fakeAnalysis(page);
  await page.goto("/");
  await b(page, "見本の対局で試してみる").click();
  await b(page, "戻る").click();
  await page.evaluate(async () => {
    const require = (globalThis as any).__r;
    const entry = [...require.getModules().entries()].find(
      ([, m]: any) =>
        m.verboseName === "node_modules/expo-sqlite/build/index.js",
    ) as any;
    const db = await require(entry[0]).openDatabaseAsync("kifumate.db");
    const row = await db.getFirstAsync("SELECT * FROM analyses");
    const a = JSON.parse(row.document);
    a.saved.results = a.saved.results.slice(0, 3);
    a.saved.partial = true;
    await db.runAsync(
      "UPDATE analyses SET document=? WHERE game_id=?",
      JSON.stringify(a),
      row.game_id,
    );
    await db.runAsync(
      "UPDATE games SET self_side='black',side_manual=1,result='win'",
    );
  });
  await page.reload();
  await page.getByText("サンプル", { exact: true }).click();
  await b(page, "最初へ").click();
  for (let i = 0; i < 3; i++) await b(page, "1手進む").click();
  await expect(
    page.getByText("未解析", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByText("この局面は未解析です", { exact: true }),
  ).toBeVisible();
  await b(page, "戻る").click();
  await b(page, "検索").click();
  await page.getByLabel("棋譜を検索").fill("tsubame");
  await expect(page.getByText(/「tsubame」/)).toHaveText(/1局$/);
});
