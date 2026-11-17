import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { ReactElement } from "react";
import { loadWithMocks } from "./helpers/load-with-mocks";

test("ネイティブ共有は書き込みの完了を待ち、書き込み失敗を利用者へ知らせる", async () => {
  for (const fails of [false, true]) {
    const messages: unknown[] = [],
      calls: string[] = [];
    let finish!: () => void, fail!: (e: Error) => void;
    const pending = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const screen = loadWithMocks<{ default: () => ReactElement }>(
      "src/app/export.tsx",
      {
        react: {
          useState: (value: unknown) => [
            value,
            (next: unknown) => messages.push(next),
          ],
        },
        "react-native": { Platform: { OS: "android" } },
        "expo-router": {
          Stack: { Screen: "Screen" },
          useLocalSearchParams: () => ({ id: "test" }),
        },
        "expo-clipboard": {},
        "expo-sharing": {
          isAvailableAsync: async () => true,
          shareAsync: async () => {
            calls.push("share");
          },
        },
        "expo-file-system": {
          Paths: { cache: "cache" },
          File: class {
            uri = "file://test.kifu";
            write() {
              calls.push("write");
              return pending;
            }
          },
        },
        "../components/ui": Object.fromEntries(
          ["Button", "Field", "Label", "Message", "Page"].map((name) => [
            name,
            name,
          ]),
        ),
        "../components/use-game": {
          useGame: () => ({ game: { kif: "本譜" }, error: "" }),
        },
      },
    );
    function findButton(element: ReactElement): (() => void) | undefined {
      const { children, onPress } = element.props as {
        children?: unknown;
        onPress?: () => void;
      };
      if (
        element.type === "Button" &&
        onPress &&
        children === "ファイルを保存・共有"
      )
        return onPress;
      for (const child of [children].flat(Infinity)) {
        if (child && typeof child === "object" && "props" in child) {
          const found = findButton(child as ReactElement);
          if (found) return found;
        }
      }
    }
    const press = findButton(screen.default());
    assert(press);
    press();
    await setImmediate();
    assert.deepEqual(calls, ["write"], "書き込み途中に共有してはいけない");
    if (fails) fail(new Error("容量不足のため書き込めませんでした。"));
    else finish();
    await setImmediate();
    assert.deepEqual(calls, fails ? ["write"] : ["write", "share"]);
    if (fails)
      assert(messages.includes("容量不足のため書き込めませんでした。"));
  }
});
