import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fakeAnalysis } from "../helpers/fake-analysis";
import { seedGames, type MockGame } from "../helpers/seed-games";
const tags = (st: string[] = [], cs: string[] = []) => ({ st, cs });
const statsGames: MockGame[] = [
  {
    id: "a",
    date: "2026-11-16",
    sente: "自分",
    gote: "相手A",
    self: "s",
    win: "s",
    plies: 5,
    tags: {
      s: tags(["振り飛車", "四間飛車"], ["美濃囲い", "高美濃", "銀冠"]),
      g: tags(["居飛車", "棒銀"], ["舟囲い"]),
    },
  },
  {
    id: "b",
    date: "2026-11-15",
    sente: "相手B",
    gote: "自分",
    self: "g",
    win: "s",
    plies: 6,
    tags: {
      s: tags(["居飛車", "矢倉"], ["金矢倉"]),
      g: tags(
        ["振り飛車", "四間飛車", "角交換振り飛車"],
        ["美濃囲い", "高美濃"],
      ),
    },
  },
  {
    id: "c",
    date: "2026-11-14",
    sente: "自分",
    gote: "相手C",
    self: "s",
    win: "d",
    plies: 7,
    tags: {
      s: tags(["居飛車", "矢倉"], ["金矢倉"]),
      g: tags(["居飛車", "矢倉"], ["金矢倉"]),
    },
  },
  {
    id: "d",
    date: "2026-11-13",
    sente: "相手D",
    gote: "自分",
    self: "g",
    win: "u",
    plies: 8,
    tags: { s: tags(["居飛車"]), g: tags() },
  },
  {
    id: "e",
    date: "2026-08-01",
    sente: "自分",
    gote: "相手E",
    self: "s",
    win: "s",
    plies: 9,
    tags: {
      s: tags(["居飛車", "棒銀"], ["舟囲い"]),
      g: tags(["振り飛車", "四間飛車"], ["美濃囲い"]),
    },
  },
  {
    id: "f",
    date: "2026-11-12",
    sente: "観戦A",
    gote: "観戦B",
    self: null,
    win: "s",
    plies: 10,
    tags: { s: tags(["居飛車", "矢倉"]), g: tags(["居飛車", "矢倉"]) },
  },
];
test.beforeEach(async ({ page }) => {
  await fakeAnalysis(page);
  await page.clock.setFixedTime(new Date("2026-11-16T12:00:00Z"));
});
test("戦績の空・集計・先後と期間・内訳・該当棋譜への移動", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("tab", { name: "戦績" }).click();
  await expect(page.getByText("まだ集計できる対局がありません")).toBeVisible();
  await seedGames(page, statsGames);
  await expect(page.getByText("自分の対局 5局")).toBeVisible();
  await page.getByRole("button", { name: "5局を表示", exact: true }).click();
  await expect(
    page.getByText("自分の対局・5局 2勝1敗1分", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "観戦A 対 観戦B、10手を開く" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "戻る", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "勝率67%の対局を表示" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "振り飛車 2局 1勝1敗 50%の対局を表示",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "振り飛車 2局 1勝1敗 50%の対局を表示",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "自分 対 相手A、5手を開く" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "相手B 対 自分、6手を開く" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "自分 対 相手C、7手を開く" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "自分 対 相手A、5手を開く", exact: true })
    .click();
  await expect(page.getByText("開始局面", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "戻る", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "相手B 対 自分、6手を開く", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "戻る", exact: true }).click();
  await page.getByRole("radio", { name: "自分の囲い", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "美濃囲い 2局 1勝1敗 50%の対局を表示",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "銀冠 1局 1勝0敗 100%の対局を表示",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("radio", { name: "30日", exact: true }).click();
  await expect(page.getByText("自分の対局 4局")).toBeVisible();
  await page.getByRole("radio", { name: "後手", exact: true }).click();
  await expect(page.getByText("自分の対局 2局")).toBeVisible();
  await page
    .getByRole("button", { name: "戦績の絞り込み", exact: true })
    .click();
  await page.getByRole("button", { name: "金矢倉", exact: true }).click();
  await page.getByRole("button", { name: "0局を表示", exact: true }).click();
  await expect(page.getByText("この条件の対局はありません。")).toBeVisible();
  await page
    .getByRole("button", { name: "条件をすべて外す", exact: true })
    .click();
  await expect(page.getByText("自分の対局 5局")).toBeVisible();
  expect(errors).toEqual([]);
});
test("対局情報の分類修正・未分類・自動へ戻す・再起動・一覧のタグと検索", async ({
  page,
}) => {
  await page.goto("/import");
  await page
    .getByRole("textbox", { name: "KIF形式の棋譜" })
    .fill(readFileSync("tests/fixtures/standard.kif", "utf8"));
  await page.getByRole("radio", { name: "☗ つばめ", exact: true }).click();
  await page.getByRole("button", { name: "保存だけする", exact: true }).click();
  await page
    .getByRole("button", { name: "この対局のメニュー", exact: true })
    .click();
  await page.getByRole("button", { name: "対局情報", exact: true }).click();
  await page
    .getByRole("button", { name: "先手の戦法を修正", exact: true })
    .click();
  await page.getByRole("radio", { name: "居飛車", exact: true }).click();
  await page.getByRole("button", { name: "矢倉", exact: true }).click();
  await page.getByRole("button", { name: "これでよい", exact: true }).click();
  await page
    .getByRole("button", { name: "先手の囲いを修正", exact: true })
    .click();
  await page.getByRole("button", { name: "美濃囲い", exact: true }).click();
  await page.getByRole("button", { name: "高美濃", exact: true }).click();
  await expect(page.getByText("いまの記録：美濃囲い → 高美濃")).toBeVisible();
  await page.getByRole("button", { name: "これでよい", exact: true }).click();
  await page.reload();
  await expect(page.getByText("手で修正", { exact: true })).toBeVisible();
  await expect(page.getByText("矢倉", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "先手の戦法を修正", exact: true })
    .click();
  await page.getByRole("radio", { name: "未分類", exact: true }).click();
  await page.getByRole("button", { name: "これでよい", exact: true }).click();
  await expect(page.getByText("高美濃", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "先手の戦法を修正", exact: true })
    .click();
  await page
    .getByRole("button", { name: "自動判定に戻す", exact: true })
    .click();
  await page.getByRole("button", { name: "これでよい", exact: true }).click();
  await expect(page.getByText("手で修正", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "先手の戦法を修正", exact: true })
    .click();
  await page.getByRole("radio", { name: "居飛車", exact: true }).click();
  await page.getByRole("button", { name: "矢倉", exact: true }).click();
  await page.getByRole("button", { name: "これでよい", exact: true }).click();
  await page.goto("/");
  await expect(page.getByText("矢倉", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await page.getByLabel("棋譜を検索").fill("矢倉");
  await expect(
    page.getByRole("button", { name: "つばめ 対 こまどり、5手を開く" }),
  ).toBeVisible();
  await page.getByLabel("棋譜を検索").fill("銀冠");
  await expect(page.getByText("「銀冠」に合う棋譜がありません")).toBeVisible();
});

test("分類で絞った戦績から大分類の行を開いても、元の絞り込みと件数を保つ", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("まだ棋譜がありません")).toBeVisible();
  await seedGames(page, statsGames);
  await page.getByRole("tab", { name: "戦績" }).click();
  await page
    .getByRole("button", { name: "戦績の絞り込み", exact: true })
    .click();
  await page.getByRole("button", { name: "矢倉", exact: true }).first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "1局を表示", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "居飛車 1局 0勝0敗1分 0%の対局を表示",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("自分の戦法・1局 0勝0敗1分", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "自分 対 相手E、9手を開く", exact: true }),
  ).toHaveCount(0);
});

test("具体的戦法の行を開くときも、集計に使った大分類を保つ", async ({
  page,
}) => {
  const shared = statsGames
    .slice(0, 3)
    .map((g, i) => ({
      ...g,
      tags: {
        ...g.tags,
        [g.self!]: tags([
          i === 0 ? "居飛車" : i === 1 ? "振り飛車" : "未分類",
          "棒銀",
        ]),
      },
    }));
  await page.goto("/");
  await expect(page.getByText("まだ棋譜がありません")).toBeVisible();
  await seedGames(page, shared);
  await page.getByRole("tab", { name: "戦績" }).click();
  await page
    .getByRole("button", {
      name: "棒銀 1局 1勝0敗 100%の対局を表示",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("自分の戦法・1局 1勝0敗", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "相手B 対 自分、6手を開く", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "自分 対 相手C、7手を開く", exact: true }),
  ).toHaveCount(0);
});
