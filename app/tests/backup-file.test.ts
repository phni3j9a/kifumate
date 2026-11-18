import assert from "node:assert/strict";
import { test } from "node:test";
import { loadWithMocks } from "./helpers/load-with-mocks";
import type * as Files from "../src/storage/backup-file";
import * as maintenance from "../src/storage/maintenance";

test("Android保存はOSのフォルダーをそのまま渡す（content URIへ子パスを連結しない）", async () => {
  const directory = { uri: "content://provider/tree/primary%3ABackup" };
  let destination: unknown;
  const api = loadWithMocks<typeof Files>("src/storage/backup-file.ts", {
    "react-native": { Platform: { OS: "android" } },
    "expo-file-system": {
      Directory: { pickDirectoryAsync: async () => directory },
    },
    "expo-document-picker": {},
    "expo-sharing": {},
    "./backup": {},
  });
  await api.saveBackup({
    filename: "backup.kifumate",
    blob: null,
    file: {
      copy: async (to: unknown) => {
        destination = to;
      },
    } as any,
  });
  assert.equal(destination, directory);
  await assert.rejects(
    api.saveBackup({
      filename: "backup.kifumate",
      blob: null,
      file: {
        copy: async () => {
          throw Error("容量不足");
        },
      } as any,
    }),
    /容量不足/,
  );
});
test("背景の書き込みが終わるまで待ち、重ねたバックアップで先行するロックを解除しない", async () => {
  let finish!: () => void;
  const unregister = maintenance.registerDataDrain(
    () =>
      new Promise<void>((r) => {
        finish = r;
      }),
  );
  try {
    let ready = false;
    const operation = maintenance.pauseData().then(() => {
      ready = true;
    });
    assert(maintenance.dataPaused);
    assert(!ready);
    await assert.rejects(maintenance.pauseData(), /別のデータ操作/);
    assert(maintenance.dataPaused);
    finish();
    await operation;
    assert(ready);
  } finally {
    unregister();
    maintenance.resumeData();
  }
  assert(!maintenance.dataPaused);
});
