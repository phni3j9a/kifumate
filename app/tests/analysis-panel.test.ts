import assert from "node:assert/strict";
import { test } from "node:test";
import { Color } from "tsshogi";
import type * as Panel from "../src/components/analysis-panel";
import { loadWithMocks } from "./helpers/load-with-mocks";

test("途中結果の未受信局面を候補なしや終局と表示しない", () => {
  const api = loadWithMocks<typeof Panel>("src/components/analysis-panel.tsx", {
    react: { useState: (v: any) => [v, () => {}] },
    "react-native": {
      StyleSheet: { create: (s: any) => s },
      View: "View",
      Text: "Text",
      Pressable: "Pressable",
    },
    "react-native-svg": { default: "Svg", Circle: "Circle", Path: "Path" },
    "expo-router": { router: {} },
    "../analysis/provider": {
      useAnalysis: () => ({
        quota: { paid: true },
        offline: true,
        controller: {},
      }),
    },
    "./theme": {
      colors: {},
      font: () => ({}),
      radius: {},
      line: {},
      shadow: {},
    },
    "./icons": { Icon: "Icon" },
    "./overlay": { ask() {}, toast() {} },
    "./ui": { Button: "Button" },
    "./realtime-controls": {},
    "./chance-bar": { BarStripes: "BarStripes" },
    "./waiting-dots": { WaitingDots: "WaitingDots" },
  });
  const tree = api.AnalysisPanel({
    analysis: {
      gameId: "id",
      saved: {
        initial: "startpos",
        moves: ["7g7f"],
        mode: "precise",
        results: [],
        coachProof: null,
        jobId: "",
        partial: true,
      },
      attempt: null,
      error: null,
    },
    branch: false,
    received: false,
    rows: [],
    selected: 0,
    onSelect() {},
    onTry() {},
    self: Color.BLACK,
    u: 0,
    start() {},
    ending: "終局",
  });
  const text = JSON.stringify(tree);
  assert.match(text, /この局面は未解析です/);
  assert.doesNotMatch(text, /この局面の候補手はありません/);
});
