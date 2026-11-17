import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import Encoding from "encoding-japanese";
import { identity, readKif } from "../../src/core/kif";
import { fakeAnalysis } from "../helpers/fake-analysis";
test.beforeEach(async ({ page }) => {
  const fake = await fakeAnalysis(page);
  fake.paid = false;
  fake.remaining = 10;
});
const kif = readFileSync("tests/fixtures/standard.kif", "utf8");
const button = (page: Page, name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });
test("名前登録→貼り付け→保存→再起動→再生→分岐→書き出し→対局情報、ファイル重複、削除", async ({
  page,
  context,
}, testInfo) => {
  const shots = `.local/screenshots/web/${testInfo.project.name}`;
  mkdirSync(shots, { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByText("まだ棋譜がありません")).toBeVisible();
  const tabLabel = await page
    .getByRole("tab", { name: /棋譜/ })
    .getByText("棋譜", { exact: true })
    .boundingBox();
  expect(tabLabel?.height).toBeGreaterThanOrEqual(10.5); // モックの .tb（10.5px/1）が欠けずに出る

  // 対局者名は1件ずつ足し、× で外すと「元に戻す」が出る
  await page.getByRole("tab", { name: /設定/ }).click();
  await page.getByText("自分の対局者名", { exact: true }).click();
  const nameBox = page.getByRole("textbox", { name: "追加する対局者名" });
  for (const name of ["つばめ", "tsubame", "こまどり"]) {
    await nameBox.fill(name);
    await button(page, "追加").click();
    await expect(page.getByText(`「${name}」を登録しました`)).toBeVisible();
  }
  await button(page, "こまどり を削除").click();
  await expect(page.getByText("「こまどり」を外しました")).toBeVisible();
  await button(page, "元に戻す").click();
  await expect(button(page, "こまどり を削除")).toBeVisible();
  await button(page, "こまどり を削除").click();
  await expect(button(page, "こまどり を削除")).toHaveCount(0);

  // 貼り付けると自動で読み取り、登録名から先手と分かる
  await page.goto("/");
  await button(page, "棋譜を取り込む").click();
  await page.getByRole("textbox", { name: "KIF形式の棋譜" }).fill(kif);
  await expect(page.getByText("あなたは先手")).toBeVisible();
  await expect(page.getByText("重複はありません")).toBeVisible();
  await button(page, "保存だけする").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/01-import.png` });
  await button(page, "保存だけする").click();
  await expect(page.getByText("保存しました", { exact: true })).toBeVisible();
  await expect(page.getByText("開始局面", { exact: true })).toBeVisible();

  // 再起動しても残り、一覧で絞り込める
  await page.goto("/");
  await expect(page.getByRole("img", { name: "勝ち" })).toBeVisible();
  await page.reload();
  const card = button(page, "つばめ 対 こまどり、5手を開く");
  await expect(card).toBeVisible();
  await expect(page.getByText("あなたは☗先手")).toBeVisible();
  await page.screenshot({ path: `${shots}/02-list.png` });
  await button(page, "お気に入りに入れる").click();
  await expect(button(page, "お気に入りから外す")).toBeVisible();
  await button(page, "お気に入り").click();
  await expect(card).toBeVisible();
  await button(page, "検索").click();
  await page.getByLabel("棋譜を検索").fill("こまどり");
  await expect(card).toBeVisible();
  await page.getByLabel("棋譜を検索").fill("zzz");
  await expect(page.getByText("「zzz」に合う棋譜がありません")).toBeVisible();
  await page.getByLabel("棋譜を検索").fill("こまどり");
  await card.click();

  // 再生と、駒を動かして始まる分岐
  await expect(page.getByText("開始局面", { exact: true })).toBeVisible();
  await button(page, "1手進む").click();
  await expect(page.getByText("1手目", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${shots}/03-replay.png` });
  await button(page, "最初へ").click();
  // 本譜と同じ手（▲7六歩）は分岐にせず、本譜を進める
  await page.getByTestId("square-7-7").click();
  await page.getByTestId("square-7-6").click();
  await expect(page.getByText("1手目", { exact: true })).toBeVisible();
  await expect(page.getByText("分岐中", { exact: true })).toHaveCount(0);
  await button(page, "最初へ").click();
  await page.getByTestId("square-2-7").click();
  await page.getByTestId("square-2-6").click();
  await expect(page.getByText("分岐1手目", { exact: true })).toBeVisible();
  await expect(
    page.getByText("分岐は保存されません。本譜や戦績は変わりません"),
  ).toBeVisible();
  await page.screenshot({ path: `${shots}/04-branch.png` });
  await button(page, "本譜に戻る").last().click();
  await expect(page.getByText("開始局面", { exact: true })).toBeVisible();

  // 「…」メニューから KIF を書き出す
  await button(page, "この対局のメニュー").click();
  await button(page, "KIFを書き出す").click();
  await expect(
    page.getByRole("textbox", { name: "書き出すKIF" }),
  ).toBeVisible();
  await page.screenshot({ path: `${shots}/05-export.png` });
  const download = page.waitForEvent("download");
  await button(page, "ファイルに保存").click();
  const downloaded = await download;
  await downloaded.saveAs(".local/screenshots/web/exported.kifu");
  assertIdentity(readFileSync(".local/screenshots/web/exported.kifu", "utf8"));
  await button(page, "閉じる").last().click();

  // 対局情報：先手か後手かは押した時点で保存、結果はシートで直す
  await button(page, "この対局のメニュー").click();
  await button(page, "対局情報").click();
  await page.getByRole("radio", { name: "☖ こまどり" }).click();
  await expect(page.getByRole("radio", { name: "☖ こまどり" })).toBeChecked();
  await button(page, "結果を修正").click();
  await button(page, "引き分け").click();
  await button(page, "これでよい").click();
  await expect(page.getByText("5手・引き分け")).toBeVisible();
  await expect(page.getByText("手で修正")).toBeVisible();
  await page.screenshot({ path: `${shots}/06-info.png` });

  // 名前を変えて再照合しても、手で直した先後と結果は残る
  await page.goto("/names");
  await button(page, "tsubame を削除").click();
  await expect(page.getByText("「tsubame」を外しました")).toBeVisible();
  await page.goto("/");
  await expect(page.getByText("あなたは☖後手")).toBeVisible();
  await expect(page.getByRole("img", { name: "引き分け" })).toBeVisible();

  // Shift_JIS のファイルは保存前に重複と分かる
  await button(page, "取り込む").click();
  await page.getByRole("radio", { name: "ファイル" }).click();
  const chooser = page.waitForEvent("filechooser");
  await button(page, "ファイルを選ぶ").click();
  const bytes = Buffer.from(
    Encoding.convert(Encoding.stringToCode(kif), {
      from: "UNICODE",
      to: "SJIS",
    }),
  );
  await (
    await chooser
  ).setFiles({ name: "test.kif", mimeType: "text/plain", buffer: bytes });
  await expect(
    page.getByText("同じ棋譜がすでに保存されています"),
  ).toBeVisible();
  await expect(button(page, "保存だけする")).toHaveCount(0);
  await button(page, "保存済みの棋譜を開く").click();
  await context.setOffline(true);
  await button(page, "1手進む").click();
  await expect(page.getByText("1手目", { exact: true })).toBeVisible();
  await context.setOffline(false);

  // 削除は確認してから。一覧に戻り「削除しました」
  await button(page, "この対局のメニュー").click();
  await button(page, "この棋譜を削除").click();
  await expect(page.getByText("この棋譜を削除しますか")).toBeVisible();
  await page.screenshot({ path: `${shots}/07-delete.png` });
  await button(page, "やめる").click();
  await expect(page.getByText("この棋譜を削除しますか")).toHaveCount(0);
  await button(page, "この対局のメニュー").click();
  await button(page, "この棋譜を削除").click();
  await button(page, "削除する").click();
  await expect(page.getByText("削除しました", { exact: true })).toBeVisible();
  await expect(page.getByText("まだ棋譜がありません")).toBeVisible();
  await page.reload();
  await expect(page.getByText("まだ棋譜がありません")).toBeVisible();
  expect(errors).toEqual([]);
});
test("取り込み：本文を書き換えた直後は、前の読み取り結果で保存しない", async ({
  page,
}) => {
  // 登録名から自動で先後が決まる（手で選ばなくても保存できる）状態にする
  await page.goto("/names");
  await page.getByRole("textbox", { name: "追加する対局者名" }).fill("つばめ");
  await button(page, "追加").click();
  await expect(page.getByText("「つばめ」を登録しました")).toBeVisible();
  await page.goto("/import");
  const box = page.getByRole("textbox", { name: "KIF形式の棋譜" });
  await box.fill(kif);
  await expect(page.getByText("重複はありません")).toBeVisible();
  const save = button(page, "保存だけする");
  await expect(save).toBeEnabled();
  // 読み直しの待ち（250ms）のあいだに押す
  await box.fill("これは棋譜ではありません");
  await save.click({ force: true, timeout: 200 }).catch(() => {});
  await expect(page.getByText("棋譜として読み取れませんでした")).toBeVisible();
  await page.goto("/");
  await expect(page.getByText("まだ棋譜がありません")).toBeVisible();
});
test("対局画面：持ち駒は見た目より広い範囲で押せる", async ({ page }) => {
  await page.goto("/import");
  await page.getByRole("textbox", { name: "KIF形式の棋譜" }).fill(kif);
  await page.getByRole("radio", { name: /☗/ }).click();
  await button(page, "保存だけする").click();
  for (let i = 0; i < 4; i++) await button(page, "1手進む").click(); // 角を交換した局面
  const hand = button(page, "先手の持ち駒 角 1枚");
  const box = (await hand.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(30); // 駒の見た目は22×23
  expect(box.height).toBeGreaterThanOrEqual(26);
  await hand.click({ position: { x: 1, y: 1 } }); // 範囲の隅
  await page.getByTestId("square-5-5").click();
  await expect(page.getByText("分岐1手目", { exact: true })).toBeVisible();
});
function assertIdentity(text: string) {
  expect(identity(readKif(text))).toBe(identity(readKif(kif)));
}
