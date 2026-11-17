// Webの開発バンドルだけで使う検証データ。製品コードにテスト用の入口は追加しない。
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { classificationCatalog, rulesVersion } from "../../src/core/classify";
export interface MockGame {
  id: string;
  date: string;
  sente: string;
  gote: string;
  self: "s" | "g" | null;
  win: "s" | "g" | "d" | "u";
  plies: number;
  fav?: boolean;
  tags: {
    s: { st: string[]; cs: string[]; edited?: boolean };
    g: { st: string[]; cs: string[]; edited?: boolean };
  };
}
export async function seedGames(page: Page, games: MockGame[]) {
  const kif = readFileSync("tests/fixtures/standard.kif", "utf8");
  const rows = games.map((g) => {
    const side = g.self === "s" ? "black" : g.self === "g" ? "white" : null;
    const sides = Object.fromEntries(
      (["s", "g"] as const).map((s) => {
        const tags = g.tags[s],
          family = tags.st[0] ?? "未分類";
        const finding = (kind: "strategies" | "castles", name: string) => {
          const tag = classificationCatalog[kind].find((t) => t.name === name);
          if (!tag) throw new Error(`未対応の検証タグ: ${kind} ${name}`);
          return { ...tag, ply: 0, sfen: "", conditions: [] };
        };
        return [
          s === "s" ? "black" : "white",
          {
            family,
            familyHistory: [],
            strategies: tags.st.slice(1).map((n) => finding("strategies", n)),
            castles: tags.cs.map((n) => finding("castles", n)),
            strategyStatus: tags.st.length ? "判定済み" : "未分類",
            castleStatus: tags.cs.length ? "判定済み" : "未分類",
          },
        ];
      }),
    );
    return {
      id: g.id,
      black: g.sente,
      white: g.gote,
      date: g.date,
      plies: g.plies,
      side,
      result:
        !side || g.win === "u"
          ? "unknown"
          : g.win === "d"
            ? "draw"
            : g.win === g.self
              ? "win"
              : "loss",
      favorite: +!!g.fav,
      kif,
      automatic: JSON.stringify({
        rulesVersion,
        processedPlies: g.plies,
        sides,
        relationships: [],
        relationshipStatus: "未分類",
      }),
    };
  });
  await page.evaluate(
    async ({ rows, version }) => {
      const require = (globalThis as any).__r;
      const entry = [...require.getModules().entries()].find(
        ([, m]: any) =>
          m.verboseName === "node_modules/expo-sqlite/build/index.js",
      ) as any;
      if (!entry) throw new Error("検証にはMetroの開発バンドルが必要です");
      const db = await require(entry[0]).openDatabaseAsync("kifumate.db");
      await db.withTransactionAsync(async () => {
        await db.runAsync("DELETE FROM games");
        for (const r of rows) {
          await db.runAsync(
            `INSERT INTO games (id,identity,kif,black,white,played_at,plies,self_side,result,favorite,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            r.id,
            `比較用:${r.id}`,
            r.kif,
            r.black,
            r.white,
            r.date,
            r.plies,
            r.side,
            r.result,
            r.favorite,
            r.date,
            r.date,
          );
          await db.runAsync(
            "INSERT INTO classifications (game_id,rules_version,automatic) VALUES (?,?,?)",
            r.id,
            version,
            r.automatic,
          );
        }
      });
    },
    { rows, version: rulesVersion },
  );
  await page.reload();
}
