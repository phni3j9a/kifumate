import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ReactElement } from "react";
import * as kif from "../src/core/kif";
import type { Game } from "../src/storage/repository";
import { loadWithMocks } from "./helpers/load-with-mocks";

for (const [screen, coachEnabled] of [
  ["info", true],
  ["game/[id]", true],
  ["game/[id]", false],
] as const) {
  const title = coachEnabled
    ? `${screen}：分類の更新だけでは同じKIFを再解析せず、本文の変更では読み直す`
    : "ストア版：?coach=1 でもコーチを開かず、削除確認も解析のみ";
  test(title, () => {
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
    let dialog = "";
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
          useLocalSearchParams: () => ({
            id: "a",
            coach: coachEnabled ? undefined : "1",
          }),
          useFocusEffect: () => {},
          useIsFocused: () => true,
          router: {},
        },
        "react-native-safe-area-context": {
          useSafeAreaInsets: () => ({ bottom: 0 }),
        },
        [`${prefix}/analysis/environment`]: { COACH_ENABLED: coachEnabled },
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
        [`${prefix}/components/overlay`]: {
          ...stub(["Sheet", "MenuRow", "toast"]),
          ask: (options: { text: string }) => {
            dialog = options.text;
          },
        },
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
        return (element.type as (props: unknown) => ReactElement)(
          element.props,
        );
      return element;
    };
    if (!coachEnabled) {
      const nodes = (e: any): any[] =>
        Array.isArray(e)
          ? e.flatMap(nodes)
          : e?.props
            ? [e, ...nodes(e.props.children)]
            : [];
      const tree = nodes(render());
      assert(!tree.some((e) => e.type === "CoachSheet"));
      const panel = tree.find((e) => e.type === "AnalysisPanel");
      assert(panel);
      assert.equal(panel.props.onCoach, undefined);
      tree.find((e) => e.props.label === "この棋譜を削除").props.onPress();
      assert.match(dialog, /解析結果/);
      assert.doesNotMatch(dialog, /コーチ|解説/);
      return;
    }
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
