import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { Color, Record as ShogiRecord } from "tsshogi";
import { pointsFor, startPly } from "../../src/analysis/display";
import { writeKif } from "../../src/core/kif";
import { fakeAnalysis, sampleResults } from "../helpers/fake-analysis";

const sample = JSON.parse(
  readFileSync("../mock/data/sample-game-2.json", "utf8"),
);
const record = new ShogiRecord();
for (const { move } of sample.positions.slice(1))
  record.append(record.position.createMoveByUSI(move.usi)!);
const kif = writeKif(record);
const button = (p: Page, name: string | RegExp) =>
  p.getByRole("button", { name, exact: true });
const entry = (p: Page) => p.getByRole("button", { name: /^勝負所の一覧/ });
const rows = (p: Page) => p.getByRole("button", { name: /^\d+手目 / });
async function importOne(p: Page, side: string | RegExp) {
  await p.goto("/");
  await button(p, "棋譜を取り込む").click();
  await p.getByRole("textbox", { name: "KIF形式の棋譜" }).fill(kif);
  await p.getByRole("radio", { name: side }).click();
  await button(p, "保存だけする").click();
  await expect(p.getByText("開始局面", { exact: true })).toBeVisible();
}

test("勝負所の一覧：未解析・解析中の案内、無料は鍵から有料プランの案内へ、行から局面へ移る", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  fake.paid = false;
  fake.remaining = 10;
  fake.results = sampleResults(sample);
  await importOne(page, /☖/);

  await expect(entry(page)).toHaveAccessibleName("勝負所の一覧");
  await entry(page).click();
  await expect(
    page.getByText(
      /解析すると、悪手・疑問手・好手など\s*印の付いた手がここに並びます。/,
    ),
  ).toBeVisible();
  await button(page, "閉じる").click();

  await button(page, "解析する").click();
  await expect(button(page, "中止")).toBeVisible();
  await expect.poll(() => fake.requests[0]?.mode).toBe("std");
  await entry(page).click();
  await expect(
    page.getByText("解析が終わると、印の付いた手がここに並びます。"),
  ).toBeVisible();
  await button(page, "閉じる").click();
  fake.complete = true;
  await expect(entry(page)).toHaveAccessibleName("勝負所の一覧、15手");
  await entry(page).click();
  await expect(
    page.getByRole("heading", { name: "勝負所（15手）" }),
  ).toBeVisible();
  await expect(rows(page)).toHaveCount(15);
  expect(
    await rows(page).evaluateAll((els) =>
      els.map((e) => parseInt(e.getAttribute("aria-label")!)),
    ),
  ).toEqual([40, 44, 45, 46, 47, 48, 54, 57, 58, 59, 60, 76, 84, 86, 88]);
  await expect(page.getByText("あなたの勝率", { exact: true })).toBeVisible();
  await expect(rows(page).nth(6)).toHaveAccessibleName(
    "54手目 △1五角、あなたの手、悪手、あなたの勝率 50%から21%、おすすめは △2七歩",
  );
  await expect(rows(page).nth(4)).toHaveAccessibleName(
    "47手目 ▲2二歩、相手の手、疑問手、あなたの勝率 36%から50%、最善は ▲2二成銀",
  );
  await expect(page.getByText("深読み", { exact: true })).toHaveCount(0);

  // 鍵は一覧に1つ。押すと有料プランの案内へ
  const lock = button(page, "有料プランでは、勝負所を5秒ずつ深く読みます");
  await expect(lock).toHaveCount(1);
  const box = (await lock.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  await lock.click();
  await expect(
    page.getByRole("heading", { name: "深読みは、有料プランで使えます" }),
  ).toBeVisible();
  await button(page, "有料プランを見る").click();
  await expect(page.getByText("招待コードで使えます")).toBeVisible();
  await button(page, "戻る").click();

  // 行を押すと、その手を指した局面へ移る（最初の悪手から開くときと同じ）
  await entry(page).click();
  await rows(page).nth(8).click();
  await expect(page.getByRole("heading", { name: /^勝負所/ })).toHaveCount(0);
  await expect(
    page.getByRole("img", { name: "58手目の盤面", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("好手！", { exact: true })).toBeVisible();
  await entry(page).click();
  await expect(rows(page).nth(8)).toHaveAttribute("aria-selected", "true");
  await expect(rows(page).nth(8)).toBeInViewport();
  await button(page, "閉じる").click();

  // 分岐中は「本譜に戻る」に入れかわる
  await button(page, "この手を盤で試す").click();
  await expect(entry(page)).toHaveCount(0);
  await button(page, "本譜に戻る").first().click();
  await expect(entry(page)).toBeVisible();
  expect(fake.errors).toEqual([]);
});

test("勝負所の一覧：ふつうの解析は精密解析でのやり直しを案内し、深読みのある手には結果を添える", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  fake.results = sampleResults(sample);
  fake.complete = true;
  await importOne(page, "自分ではない");
  await button(page, "ふつう").click();
  await button(page, "解析する").click();
  await expect(entry(page)).toHaveAccessibleName("勝負所の一覧、15手");
  await entry(page).click();
  await expect(page.getByText("先手の勝率", { exact: true })).toBeVisible();
  await expect(
    button(page, "有料プランでは、勝負所を5秒ずつ深く読みます"),
  ).toHaveCount(0);
  await button(page, "精密解析では、勝負所を5秒ずつ深く読みます").click();
  await expect(
    page.getByRole("heading", { name: "精密解析でやり直しますか" }),
  ).toBeVisible();

  // 53・54手目と59・60手目の前後、印の付かない30・31手目を深読み済みにする
  const deep = [30, 31, 53, 54, 59, 60];
  fake.results = fake.results.map((r) =>
    deep.includes(r.ply)
      ? {
          ...r,
          deep: {
            ...r,
            score: r.ply === 54 ? { kind: "cp", value: 900 } : r.score,
          },
        }
      : r,
  );
  await button(page, "精密解析する").click();
  await expect.poll(() => fake.requests.at(-1)?.mode).toBe("precise");
  await expect(entry(page)).toHaveAccessibleName("勝負所の一覧、16手");
  await entry(page).click();
  await expect(page.getByRole("button", { name: /深く読みます$/ })).toHaveCount(
    0,
  );
  await expect(page.getByText("深読み", { exact: true })).toHaveCount(3);
  // 印がなくても、前後とも深く読んだ手は一覧に入る
  await expect(rows(page).first()).toHaveAccessibleName(
    "31手目 ▲3三角成、先手の手、先手の勝率 51%から51%、深読み 最善の手、評価値 +29、読み筋 △同桂 ▲2四歩 △同歩 ▲同銀",
  );
  // 勝率と印は深読みどうしで決め、深読みのおすすめ・評価値・読み筋を添える
  await expect(button(page, /^54手目 /)).toHaveAccessibleName(
    "54手目 △1五角、後手の手、悪手、先手の勝率 50%から82%、深読み 最善は △2七歩、評価値 +3、読み筋 ▲3八飛 △5二金 ▲7五歩 △4二金 ▲同成銀",
  );

  // 保存した深読みは、無料に戻っても通信がなくても読める
  fake.paid = false;
  fake.online = false;
  await page.reload();
  await entry(page).click();
  await expect(page.getByText("深読み", { exact: true })).toHaveCount(3);
  await expect(page.getByRole("button", { name: /深く読みます$/ })).toHaveCount(
    0,
  );
  await button(page, /^54手目 /).click();
  await expect(page.getByText("深く読んだ局面", { exact: true })).toBeVisible();
});

test("勝負所の一覧：印の付いた手がない対局は、その旨を出す", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  fake.complete = true;
  await page.goto("/");
  await button(page, "棋譜を取り込む").click();
  await page
    .getByRole("textbox", { name: "KIF形式の棋譜" })
    .fill(readFileSync("tests/fixtures/standard.kif", "utf8"));
  await page.getByRole("radio", { name: "自分ではない" }).click();
  await button(page, "保存だけする").click();
  await button(page, "解析する").click();
  await expect(entry(page)).toHaveAccessibleName("勝負所の一覧、0手");
  await entry(page).click();
  await expect(
    page.getByRole("heading", { name: "勝負所（0手）" }),
  ).toBeVisible();
  // 印は31手目にも付く（pointsFor の i > 30）
  await expect(
    page.getByText(
      /印の付いた手はありませんでした。\s*印は、31手目以降で形勢が大きく動いた手に付きます。/,
    ),
  ).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /深く読みます$/ })).toHaveCount(
    0,
  );
});

test("勝負所の一覧：開いたまま初回の解析が終わったら、案内の前に一覧を閉じ、「見てみる」で最初の悪手の盤が見える", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page, { firstReview: true });
  fake.results = sampleResults(sample);
  await importOne(page, /☖/);
  await button(page, "解析する").click();
  await expect(button(page, "中止")).toBeVisible();
  await entry(page).click();
  await expect(
    page.getByText("解析が終わると、印の付いた手がここに並びます。"),
  ).toBeVisible();
  fake.complete = true;
  await expect(
    page.getByRole("heading", { name: "はじめての解析ができました" }),
  ).toBeVisible();
  // 案内は別ウィンドウ。一覧が残ると重なる（Web では「見てみる」を押せない）ので、先に閉じる
  await expect(page.getByRole("heading", { name: /^勝負所/ })).toHaveCount(0);
  await button(page, "見てみる").click();
  const first = startPly(pointsFor(record, fake.results, Color.WHITE));
  expect(first).toBeGreaterThan(30);
  await expect(
    page.getByRole("img", { name: `${first}手目の盤面`, exact: true }),
  ).toBeVisible();
  expect(fake.errors).toEqual([]);
});

test("勝負所の一覧：バックアップから復元した途中までの結果を、解析済みとして数えない", async ({
  page,
}) => {
  const fake = await fakeAnalysis(page);
  await page.goto("/");
  await button(page, "見本の対局で試してみる").click();
  await expect(entry(page)).toHaveAccessibleName(/^勝負所の一覧、[1-9]\d*手$/);
  await button(page, "戻る").click();
  // 復元した途中結果と同じ形にする：85手の対局の20手目までと partial
  await page.evaluate(async () => {
    const require = (globalThis as any).__r;
    const entry = [...require.getModules().entries()].find(
      ([, m]: any) =>
        m.verboseName === "node_modules/expo-sqlite/build/index.js",
    ) as any;
    const db = await require(entry[0]).openDatabaseAsync("kifumate.db");
    const row = await db.getFirstAsync("SELECT * FROM analyses");
    const a = JSON.parse(row.document);
    a.saved.results = a.saved.results.slice(0, 21);
    a.saved.partial = true;
    await db.runAsync(
      "UPDATE analyses SET document=? WHERE game_id=?",
      JSON.stringify(a),
      row.game_id,
    );
  });
  await page.reload();
  await page.getByText("サンプル", { exact: true }).click();
  await expect(page.getByRole("img", { name: /の盤面$/ })).toBeVisible();
  await expect(entry(page)).toHaveAccessibleName("勝負所の一覧");
  await entry(page).click();
  await expect(
    page.getByRole("heading", { name: "勝負所", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /途中までの結果だけを復元しています。\s*解析し直すと、印の付いた手がここに並びます。/,
    ),
  ).toBeVisible();
  await expect(page.getByText(/印の付いた手はありませんでした/)).toHaveCount(0);
  expect(fake.errors).toEqual([]);
});

test("勝負所の一覧：解析回数を取得できなくても、照会済みの有料プランに有料プランの案内を出さない", async ({
  page,
}) => {
  await fakeAnalysis(page);
  // 権利の照会は有料のまま、解析回数の取得だけ失敗させる（後から登録した経路が優先される）
  await page.route("**/v1/quota", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "unavailable" }),
    }),
  );
  await page.goto("/");
  await button(page, "見本の対局で試してみる").click();
  // 権利は有料と照会できている（「深く読む」が鍵の案内ではなく開始になる）
  await button(page, "深く読む").click();
  await button(page, "終了").click();
  await entry(page).click();
  await expect(rows(page)).not.toHaveCount(0);
  await expect(page.getByRole("button", { name: /深く読みます$/ })).toHaveCount(
    0,
  );
});
