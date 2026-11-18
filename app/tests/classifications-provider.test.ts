import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { loadWithMocks } from "./helpers/load-with-mocks";
import * as maintenance from "../src/storage/maintenance";

function provider(
  reclassify: (
    db: unknown,
    changed: () => void,
    cancelled: () => boolean,
  ) => Promise<void>,
) {
  const notices: string[] = [];
  let close = () => {};
  const api = loadWithMocks<{
    ClassificationsProvider: (props: object) => unknown;
  }>("src/components/classifications-provider.tsx", {
    react: {
      createContext: () => ({ Provider: "Provider" }),
      useContext: () => ({}),
      useState: (v: unknown) => [v, () => {}],
      useEffect: (f: () => () => void) => {
        close = f();
      },
    },
    "react-native": {
      AppState: {
        currentState: "active",
        addEventListener: () => ({ remove() {} }),
      },
    },
    "expo-sqlite": { useSQLiteContext: () => ({}) },
    "./data-provider": { useAppData: () => ({ revision: 0 }) },
    "../storage/maintenance": maintenance,
    "../storage/classifications": { reclassifyGames: reclassify },
    "./overlay": { toast: (s: string) => notices.push(s) },
  });
  api.ClassificationsProvider({});
  return { close: () => close(), notices };
}
test("自動分類の保存失敗は通知し、後続のバックアップ待機へ過去の失敗を渡さない", async () => {
  const p = provider(async () => {
    throw Error("容量不足");
  });
  try {
    await setImmediate();
    assert.equal(p.notices.length, 1);
    await assert.doesNotReject(maintenance.pauseData());
  } finally {
    p.close();
    maintenance.resumeData();
  }
});
test("バックアップで中断した自動分類は、復帰操作なしで残りを再開する", async () => {
  let finish!: () => void,
    calls = 0;
  const p = provider(async (_db, _changed, cancelled) => {
    calls++;
    if (calls === 1) {
      await new Promise<void>((r) => {
        finish = r;
      });
      assert(cancelled());
    }
  });
  try {
    const paused = maintenance.pauseData();
    finish();
    await paused;
    assert.equal(calls, 1);
    maintenance.resumeData();
    await setImmediate();
    assert.equal(calls, 2);
  } finally {
    p.close();
    maintenance.resumeData();
  }
});
