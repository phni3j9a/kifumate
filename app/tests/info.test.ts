import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { ReactElement } from "react";
import * as format from "../src/core/format";
import * as kif from "../src/core/kif";
import type * as Repository from "../src/storage/repository";
import { database } from "./helpers/database";
import { loadWithMocks } from "./helpers/load-with-mocks";

const repository = loadWithMocks<typeof Repository>(
  "src/storage/repository.ts",
  { "expo-crypto": { randomUUID }, "../core/kif": kif },
);
// 対局情報の画面を、Expo・部品を差し替えて実行する。game は渡した時点の行（再読み込み前の古い値もありうる）。
async function screen() {
  const { sql, db } = await database();
  const { id } = await repository.importGame(
    db,
    kif.readKif(readFileSync("tests/fixtures/standard.kif", "utf8")), // 先手の勝ち
    "black",
    "win",
    true,
    false,
  );
  const row = () =>
    sql
      .prepare("SELECT * FROM games WHERE id=?")
      .get(id) as unknown as Repository.Game;
  const ui = Object.fromEntries(
    [
      "Button",
      "Card",
      "Chip",
      "Hint",
      "PageHeader",
      "PageScroll",
      "Problem",
      "Screen",
      "SectionTitle",
      "Segmented",
      "Underlined",
    ].map((n) => [n, n]),
  );
  let game = row();
  const info = loadWithMocks<{ default: () => ReactElement }>(
    "src/app/info.tsx",
    {
      react: {
        useMemo: (f: () => unknown) => f(),
        useState: (v: unknown) => [v, () => {}],
        useRef: (v: unknown) => ({ current: v }),
      },
      "react-native": {
        StyleSheet: { create: (x: unknown) => x },
        Pressable: "Pressable",
        Text: "Text",
        View: "View",
      },
      "expo-router": { useLocalSearchParams: () => ({ id }) },
      "../components/overlay": {
        Sheet: "Sheet",
        toast: (t: string) => assert.fail(t),
      },
      "../components/theme": {
        colors: {},
        font: () => ({}),
        line: {},
        radius: {},
      },
      "../components/ui": ui,
      "../components/use-game": {
        useGame: () => ({ game, error: "", db, reload: async () => {} }),
      },
      "../core/format": format,
      "../core/kif": kif,
      "../storage/repository": repository,
    },
  );
  function find(e: unknown, hit: (e: ReactElement) => boolean): ReactElement {
    const found = walk(e);
    assert(found, "見つからない");
    return found;
    function walk(e: unknown): ReactElement | undefined {
      if (Array.isArray(e)) {
        for (const c of e) {
          const f = walk(c);
          if (f) return f;
        }
      } else if (e && typeof e === "object" && "props" in e) {
        const el = e as ReactElement<{ children?: unknown }>;
        return hit(el) ? el : walk(el.props.children);
      }
    }
  }
  return {
    sql,
    row,
    /** 最新の行で描き直す */
    render() {
      game = row();
      const tree = info.default();
      type Props = {
        label?: string;
        onChange?: (v: string) => void;
        onPress?: () => void;
      };
      return {
        side: (v: string) =>
          (find(tree, (e) => e.type === "Segmented").props as Props).onChange!(
            v,
          ),
        result: (label: string) =>
          (
            find(
              tree,
              (e) => e.type === "Chip" && (e.props as Props).label === label,
            ).props as Props
          ).onPress!(),
      };
    },
  };
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await setImmediate();
};

test("対局情報：保存が終わる前に先後と結果を続けて直しても、先の変更を失わない", async () => {
  const s = await screen();
  try {
    const view = s.render();
    view.side("white"); // 再読み込みの前に、同じ（古い）画面のまま続けて押す
    view.result("引き分け");
    await settle();
    assert.equal(s.row().self_side, "white");
    assert.equal(s.row().result, "draw");
  } finally {
    s.sql.close();
  }
});

test("対局情報：手で直した結果は「自分ではない」を挟んでも残る", async () => {
  const s = await screen();
  try {
    s.render().result("引き分け");
    await settle();
    s.render().side("none");
    await settle();
    assert.equal(s.row().self_side, null);
    s.render().side("black");
    await settle();
    assert.equal(s.row().self_side, "black");
    assert.equal(s.row().result, "draw");
    // 勝ち負けを手で直した場合も、どちらが勝ったかを保ったまま先後を入れ替えられる
    s.render().result("☖ こまどり の勝ち");
    await settle();
    assert.equal(s.row().result, "loss");
    s.render().side("none");
    await settle();
    s.render().side("white");
    await settle();
    assert.equal(s.row().result, "win");
  } finally {
    s.sql.close();
  }
});
