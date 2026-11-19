import assert from "node:assert/strict";
import { test } from "node:test";
import { claimFirstReview, firstReviewKey } from "../src/analysis/first-review";
import { ensureVisibleY } from "../src/core/scroll";
import { database } from "./helpers/database";
import { loadWithMocks } from "./helpers/load-with-mocks";
import type * as Coach from "../src/coach/sheet";
import type { Game } from "../src/storage/repository";
import { defaultProfile } from "../src/coach/types";

test("棋譜の現在手が見えていれば維持し、はみ出す側だけ40pxの余白を取る", () => {
  assert.equal(ensureVisibleY(110, 36, 80, 224), 80);
  assert.equal(ensureVisibleY(70, 36, 80, 224), 30);
  assert.equal(ensureVisibleY(282, 36, 80, 224), 134);
  assert.equal(ensureVisibleY(2, 36, 0, 224), 0);
});

test("初回の解析完了案内は端末設定で1回だけ取得できる", async () => {
  const { db, sql } = await database();
  assert.deepEqual(
    await Promise.all([claimFirstReview(db), claimFirstReview(db)]),
    [true, false],
  );
  assert.equal(
    (
      await db.getFirstAsync<{ value: string }>(
        "SELECT value FROM settings WHERE key=?",
        firstReviewKey,
      )
    )?.value,
    "true",
  );
  sql.close();
});

test("iOSコーチのキーボード回避は、盤の下に絶対配置するシート全体に適用する", () => {
  const slide = {};
  const { CoachSheet } = loadWithMocks<typeof Coach>("src/coach/sheet.tsx", {
    react: {
      useCallback: (f: unknown) => f,
      useRef: (v: unknown) => ({ current: v }),
      useState: (v: unknown) => [v, () => {}],
    },
    "react-native": {
      Animated: { View: "Animated.View" },
      KeyboardAvoidingView: "KeyboardAvoidingView",
      Platform: { OS: "ios" },
      StyleSheet: { create: (s: unknown) => s },
      useWindowDimensions: () => ({ height: 852 }),
    },
    "expo-router": { useFocusEffect() {}, useIsFocused: () => true },
    "expo-crypto": {},
    "expo-sqlite": { useSQLiteContext() {} },
    "react-native-safe-area-context": {
      useSafeAreaInsets: () => ({ top: 47, bottom: 34 }),
    },
    "../storage/repository": {},
    "../analysis/provider": { useAnalysis: () => ({ records: {} }) },
    "../components/ui": {},
    "../components/overlay": { useSlideUp: () => slide },
    "../components/icons": {},
    "../components/theme": {
      colors: {},
      font: () => ({}),
      line: {},
      radius: {},
      shadow: {},
    },
    "./provider": {
      useCoach: () => ({ records: {}, profile: defaultProfile }),
    },
    "./privacy": {},
    "../components/waiting-dots": {},
    "./shimmer": {},
    "./style-picker": {},
  });
  const noop = () => {};
  const sheet = CoachSheet({
    game: { id: "game" } as Game,
    halfTop: 450,
    fullTop: 46,
    ply: 0,
    branch: false,
    onClose: noop,
    start: noop,
    jump: noop,
    tryLine: noop,
    onFullChange: noop,
  });
  assert.equal(sheet.type, "KeyboardAvoidingView");
  assert.equal(sheet.props.behavior, "padding");
  assert.equal(sheet.props.style[1].top, 497);
  assert.equal(sheet.props.children.type, "Animated.View");
  assert.equal(
    sheet.props.children.props.style[1].transform[0].translateY,
    slide,
  );
});
