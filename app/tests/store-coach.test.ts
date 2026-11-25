import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { AnalysisClient } from "../src/analysis/client";
import { defaultProfile } from "../src/coach/types";
import { loadWithMocks } from "./helpers/load-with-mocks";

const store = { DISTRIBUTION: "store", COACH_ENABLED: false };
const noop = () => {};
const theme = { colors: {}, line: {}, radius: {}, shadow: {}, font: noop };
const react = {
  useState: (value: unknown) => [value, noop],
  useRef: (current: unknown) => ({ current }),
  useEffect: noop,
  useLayoutEffect: noop,
  useCallback: (f: unknown) => f,
};
const router = {
  useLocalSearchParams: () => ({ kind: "privacy" }),
  useScrollToTop: noop,
  useFocusEffect: (f: () => void) => f(),
};
const native = {
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: "web" },
  Animated: { View: "AnimatedView" },
  PanResponder: { create: () => ({}) },
};
const mocks = {
  react,
  "react-native": native,
  "expo-router": router,
  "expo-sqlite": { useSQLiteContext: noop },
  "../analysis/environment": store,
  "../components/theme": theme,
  "./theme": theme,
  "../coach/provider": {
    useCoach: () => ({
      ready: false,
      controller: {},
      profile: { practice: [] },
    }),
  },
  "../analysis/provider": {
    useAnalysis: () => ({ controller: { sync: noop } }),
  },
  "../entitlements/provider": {
    useEntitlements: () => ({
      checked: true,
      entitlement: { paid: true, expiresAt: null },
    }),
  },
  "../components/ui": {},
  "./ui": {},
  "../components/icons": {},
  "../components/overlay": {},
};
const render = (path: string, extra = {}) =>
  loadWithMocks<{ default: () => any }>(`src/app/${path}.tsx`, {
    ...mocks,
    ...extra,
  }).default();
const forbidden = /コーチ|プロフィール|AIに聞く|解説|練習中の戦法/;

test("ストア版：有料権利があっても設定・利用枠・プラン・招待・規約にコーチがない", () => {
  const settings = render("(tabs)/settings", {
    "../../analysis/environment": store,
    "../../coach/provider": mocks["../coach/provider"],
    "../../analysis/provider": mocks["../analysis/provider"],
    "../../components/ui": {},
    "../../components/analysis-quota": {},
    "../../storage/repository": { listAliases: async () => [] },
  });
  const { AnalysisQuota } = loadWithMocks<{ AnalysisQuota: () => unknown }>(
    "src/components/analysis-quota.tsx",
    mocks,
  );
  for (const tree of [
    settings,
    AnalysisQuota(),
    render("plan"),
    render("invitation", { "../entitlements/status": {} }),
    render("legal"),
    render("legal", { "expo-router": { useLocalSearchParams: () => ({}) } }),
  ]) {
    assert.doesNotMatch(JSON.stringify(tree), forbidden);
  }
});

test("ストア版：紹介は5枚で完了し、学習プロフィールを更新しない", async () => {
  let completed = false;
  for (let step = 0; step < 5; step++) {
    const tree = render("onboarding", {
      react: {
        ...react,
        useState: (value: any) => [
          value?.step === 0 ? { step, direction: 1 } : value,
          noop,
        ],
      },
      "expo-router": {
        ...router,
        useFocusEffect: noop,
        router: { replace: noop },
      },
      "../assets/app-icon.png": {},
      "../components/graph-mark": {},
      "../components/data-provider": {
        useAppData: () => ({
          complete: async () => {
            completed = true;
          },
        }),
      },
      "../components/ui": {
        mascots: Object.fromEntries(
          [1, 2, 3, 4, 7].map((n) => [`onb-${n}`, { ratio: 1 }]),
        ),
      },
      "../storage/repository": {},
    });
    const text = JSON.stringify(tree);
    assert.match(text, new RegExp(`5枚中 ${step + 1}枚目`));
    assert.doesNotMatch(text, forbidden);
    if (step === 4) {
      assert.match(text, /さあ、はじめよう/);
      const button = tree.props.children.at(-1).props.children[0];
      assert.equal(button.props.disabled, false);
      button.props.onPress();
      await Promise.resolve();
      assert(completed);
    }
  }
});

test("起動・前面復帰で /v1/coach を取得するのは招待版だけ", async () => {
  for (const enabled of [true, false]) {
    const requests: string[] = [],
      cleanup: (() => void)[] = [];
    let change: ((state: string) => void) | undefined;
    const client = new AnalysisClient(
      "https://test.invalid",
      { get: async () => "token", set: async () => {} },
      async (url) => {
        requests.push(new URL(String(url)).pathname);
        return Response.json({ paid: true });
      },
    );
    const { CoachProvider } = loadWithMocks<{
      CoachProvider: (props: unknown) => unknown;
    }>("src/coach/provider.tsx", {
      ...mocks,
      "../analysis/environment": { COACH_ENABLED: enabled },
      react: {
        createContext: () => ({}),
        useMemo: (f: () => unknown) => f(),
        useEffect: (f: () => void | (() => void)) => {
          const stop = f();
          if (stop) cleanup.push(stop);
        },
      },
      "react-native": {
        AppState: {
          currentState: "active",
          addEventListener: (_: string, listener: typeof change) => {
            change = listener;
            return { remove: noop };
          },
        },
      },
      "../components/data-provider": { useAppData: () => ({}) },
      "../storage/maintenance": { registerDataDrain: noop },
      "./storage": {
        coachStorage: () => ({
          load: async () => [],
          profile: async () => defaultProfile,
          overview: async () => null,
        }),
      },
    });
    try {
      CoachProvider({ client });
      await setImmediate();
      const calls = () =>
        requests.filter((p) => p.startsWith("/v1/coach")).length;
      assert.equal(calls(), enabled ? 1 : 0);
      change?.("background");
      change?.("active");
      await setImmediate();
      assert.equal(calls(), enabled ? 2 : 0);
    } finally {
      for (const stop of cleanup) stop();
    }
  }
});
