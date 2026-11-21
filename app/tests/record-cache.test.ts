import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ReactElement } from "react";
import * as kif from "../src/core/kif";
import type { Game } from "../src/storage/repository";
import { loadWithMocks } from "./helpers/load-with-mocks";

for (const screen of ["info", "game/[id]"]) {
  test(`${screen}：分類の更新だけでは同じKIFを再解析せず、本文の変更では読み直す`, () => {
    const text = readFileSync("tests/fixtures/standard.kif", "utf8");
    let game = {
      id: "a",
      kif: text,
      black: "つばめ",
      white: "こまどり",
      plies: 5,
      played_at: "2026/11/16",
      result: "win",
      self_side: "black",
    } as Game;
    let reads = 0,
      cursor = 0;
    const memos: { dependencies: unknown[]; value: unknown }[] = [];
    const prefix = screen === "info" ? ".." : "../..";
    const stub = (names: string[]) =>
      Object.fromEntries(names.map((name) => [name, name]));
    const theme = {
      colors: {},
      font: () => ({}),
      line: {},
      radius: {},
      shadow: {},
    };
    const module = loadWithMocks<{ default: () => ReactElement }>(
      `src/app/${screen}.tsx`,
      {
        react: {
          useMemo: (f: () => unknown, dependencies: unknown[]) => {
            const i = cursor++,
              old = memos[i];
            if (
              !old ||
              dependencies.some((d, j) => !Object.is(d, old.dependencies[j]))
            )
              memos[i] = { dependencies, value: f() };
            return memos[i]!.value;
          },
          useState: (v: unknown) => [v, () => {}],
          useRef: (v: unknown) => ({ current: v }),
          useEffect: () => {},
          useCallback: (fn: unknown) => fn,
        },
        "react-native": {
          ...stub(["Pressable", "Text", "View", "ScrollView"]),
          StyleSheet: { create: (v: unknown) => v },
          Platform: { OS: "web" },
          useWindowDimensions: () => ({ width: 393, height: 852 }),
        },
        "react-native-svg": { default: "Svg", Line: "Line" },
        "expo-router": {
          useLocalSearchParams: () => ({ id: "a" }),
          useFocusEffect: () => {},
          useIsFocused: () => true,
          router: {},
        },
        "react-native-safe-area-context": {
          useSafeAreaInsets: () => ({ bottom: 0 }),
        },
        [`${prefix}/components/chance-bar`]: stub(["ChanceBar"]),
        [`${prefix}/components/evaluation-help`]: stub(["EvaluationHelp"]),
        [`${prefix}/components/use-game`]: {
          useGame: () => ({ game, error: "", db: {}, reload: async () => {} }),
        },
        [`${prefix}/components/theme`]: theme,
        [`${prefix}/components/ui`]: stub([
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
          "RoundButton",
        ]),
        [`${prefix}/components/overlay`]: stub([
          "Sheet",
          "MenuRow",
          "toast",
          "ask",
        ]),
        [`${prefix}/components/classification-editor`]: stub([
          "ClassificationEditor",
        ]),
        [`${prefix}/components/board`]: stub(["Board"]),
        [`${prefix}/components/export-sheet`]: { default: "ExportSheet" },
        [`${prefix}/components/graph`]: stub(["EvalGraph"]),
        [`${prefix}/components/icons`]: stub(["Icon"]),
        [`${prefix}/components/analysis-panel`]: stub(["AnalysisPanel"]),
        [`${prefix}/components/realtime-controls`]: stub(["RealtimeToggle"]),
        [`${prefix}/components/turning-points`]: stub([
          "TurningPointsButton",
          "TurningPointsSheet",
        ]),
        [`${prefix}/coach/sheet`]: stub(["CoachSheet"]),
        [`${prefix}/coach/provider`]: {
          useCoach: () => ({ controller: {}, records: {} }),
        },
        [`${prefix}/analysis/provider`]: {
          useRealtime: () => ({ controller: {}, quota: null }),
          useAnalysis: () => ({
            records: {},
            offline: false,
            ready: false,
            controller: {},
          }),
        },
        [`${prefix}/storage/repository`]: {},
        [`${prefix}/core/kif`]: {
          ...kif,
          readStoredKif: (value: string) => {
            reads++;
            return kif.readStoredKif(value);
          },
        },
      },
    );
    const render = () => {
      cursor = 0;
      const element = module.default();
      // 対局画面のルートはidでキー付けしたGameViewを返す。
      if (typeof element.type === "function")
        (element.type as (props: unknown) => unknown)(element.props);
    };
    render();
    assert.equal(reads, 1);
    for (let i = 0; i < 5; i++) {
      game = {
        ...game,
        classification_manual: JSON.stringify({
          black: { castles: i % 2 ? ["mino"] : [] },
        }),
      };
      render();
    }
    assert.equal(reads, 1, "約100msごとの分類更新で同じKIFを再解析している");
    game = { ...game, kif: text.replace("こまどり", "別の対局者") };
    render();
    assert.equal(reads, 2, "KIF本文の変更は再解析する");
  });
}
