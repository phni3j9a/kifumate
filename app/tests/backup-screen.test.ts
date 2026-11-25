import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { ReactElement } from "react";
import { loadWithMocks } from "./helpers/load-with-mocks";
function elements(e: any): any[] {
  if (Array.isArray(e)) return e.flatMap(elements);
  return e && typeof e === "object" && "props" in e
    ? [e, ...elements(e.props.children)]
    : [];
}
function screen(coachEnabled = true) {
  let index = 0;
  const ref = { current: false },
    deliveries: string[] = [];
  const state: any[] = [],
    dialogs: any[] = [],
    writes: string[] = [],
    routes: any[] = [];
  const api = loadWithMocks<{ default: () => ReactElement }>(
    "src/app/backup.tsx",
    {
      react: {
        useState: (v: any) => {
          const i = index++;
          if (!(i in state)) state[i] = v;
          return [
            state[i],
            (next: any) => {
              state[i] = next;
            },
          ];
        },
        useEffect: () => {},
        useRef: () => ref,
      },
      "react-native": {
        Platform: { OS: "ios" },
        Text: "Text",
        View: "View",
        BackHandler: { addEventListener: () => ({ remove() {} }) },
      },
      "expo-router": {
        useLocalSearchParams: () => ({ restore: "1" }),
        usePreventRemove: () => () => {},
        router: { replace: (r: any) => routes.push(r) },
        useNavigation: () => ({
          getState: () => ({ key: "root", index: 1, routes: [] }),
          dispatch: (s: any) => routes.push(s.payload),
        }),
      },
      "expo-sqlite": {
        useSQLiteContext: () => ({
          runAsync: async (s: string) => {
            writes.push(s);
          },
        }),
      },
      "expo-crypto": { randomUUID: () => "uuid" },
      "../analysis/environment": { COACH_ENABLED: coachEnabled },
      "../analysis/provider": {
        useAnalysis: () => ({ controller: { snapshot: { records: {} } } }),
      },
      "../coach/provider": {
        useCoach: () => ({ controller: { busy: false } }),
      },
      "../components/data-provider": {
        useAppData: () => ({ reload: async () => {} }),
      },
      "../components/overlay": {
        ask: (d: any) => dialogs.push(d),
        toast: () => {},
        Sheet: "Sheet",
      },
      "../components/ui": Object.fromEntries(
        [
          "Button",
          "Card",
          "Hint",
          "MascotImage",
          "PageHeader",
          "PageScroll",
          "Screen",
        ].map((s) => [s, s]),
      ),
      "../components/theme": { colors: {}, font: () => ({}) },
      "../storage/backup": {
        restoreBackup: async () => ({ added: 1, skipped: 0 }),
      },
      "../storage/backup-file": {
        pickBackup: () => new Promise(() => {}),
        clearExpiredBackups: () => {},
        discardBackup: () => {},
        shareBackup: async () => {
          deliveries.push("share");
          return false;
        },
        saveBackup: async () => {
          deliveries.push("save");
          return false;
        },
      },
      "../storage/maintenance": {
        dataPaused: false,
        pauseData: async () => {},
        resumeData: () => {},
      },
    },
  );
  function render() {
    index = 0;
    return api.default();
  }
  render();
  function press(name: string) {
    const node = elements(render()).find(
      (e) => e.type === "Button" && e.props.children === name,
    );
    assert(node, name);
    node.props.onPress();
  }
  return { render, state, dialogs, writes, routes, press, deliveries };
}
test("初回復元の成功は紹介を含む履歴全体を一覧へ置き換える", async () => {
  const h = screen();
  h.state[5] = { createdAt: new Date().toISOString(), games: 1 };
  h.press("すべて置きかえる");
  h.dialogs[0].onOk();
  await setImmediate();
  assert.equal(h.routes.length, 1);
  assert.equal(h.routes[0].index, 0);
  assert.equal(h.routes[0].routes.length, 1);
  assert.equal(h.routes[0].routes[0].name, "(tabs)");
});
test("共有を閉じただけでは最終バックアップ日時を更新しない", async () => {
  for (const name of ["ファイルに保存", "共有する"]) {
    const h = screen();
    h.state[6] = { filename: "backup", file: { uri: "file:///cache" } };
    h.press(name);
    await setImmediate();
    assert.deepEqual(h.writes, []);
    assert.equal(h.state[1], "");
  }
});

test("保存・共有の連打は1回だけ実行し、進行中の一時ファイルを閉じない", async () => {
  const h = screen();
  h.state[6] = { filename: "backup", file: { uri: "file:///cache" } };
  h.press("共有する");
  h.press("ファイルに保存");
  await setImmediate();
  assert.deepEqual(h.deliveries, ["share"]);
});

test("OS選択とキャッシュ読み込みの待機中にも進行表示を出す", async () => {
  const h = screen();
  h.press("ファイルを選ぶ");
  assert.match(h.state[2], /読み込/);
  await setImmediate();
});

test("ストア版：書き出し・統合確認・完了の案内に解説やプロフィールを含めない", async () => {
  const h = screen(false),
    forbidden = /コーチ|プロフィール|解説|質問|目標/;
  assert.doesNotMatch(JSON.stringify(h.render()), forbidden);
  h.state[5] = { createdAt: new Date().toISOString(), games: 1 };
  h.press("既存データと統合する");
  assert.doesNotMatch(h.dialogs[0].text, forbidden);
  h.dialogs[0].onOk();
  await setImmediate();
  assert.doesNotMatch(h.dialogs[1].text, forbidden);
});
