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

test("iOSの共有シート終了は保存成功と区別する", async () => {
  const api = loadWithMocks<typeof Files>("src/storage/backup-file.ts", {
    "react-native": { Platform: { OS: "ios" } },
    "expo-file-system": {},
    "expo-document-picker": {},
    "./backup": {},
    "expo-sharing": {
      isAvailableAsync: async () => true,
      shareAsync: async () => {},
    },
  });
  const file = {
    filename: "test.kifumate",
    blob: null,
    file: { uri: "file:///test", rename() {} },
  } as any;
  assert.equal(await api.shareBackup(file), false);
  assert.equal(await api.saveBackup(file), false);
});

test("非シークURIはコピーしてから読み込み、取消・検証失敗も含め一時ファイルを回収する", async () => {
  const deleted: string[] = [],
    copied: string[] = [];
  let malformed = false;
  class LocalFile {
    uri = "file:///cache/import.kifumate";
    size = 12;
    delete() {
      deleted.push(this.uri);
    }
    readableStream() {
      return new ReadableStream({
        start(c) {
          c.enqueue(
            malformed
              ? new Uint8Array([0xff])
              : new TextEncoder().encode("first\nlast\n"),
          );
          c.close();
        },
      });
    }
    static pickFileAsync = async () => ({
      canceled: false,
      result: {
        size: 12,
        readableStream: () => assert.fail("非シークURIを直接読むべきでない"),
        copy: async (destination: LocalFile) => {
          copied.push(destination.uri);
        },
      },
    });
  }
  const backup = await import("../src/storage/backup");
  const api = loadWithMocks<typeof Files>("src/storage/backup-file.ts", {
    "react-native": { Platform: { OS: "android" } },
    "expo-file-system": { File: LocalFile, Paths: { cache: "cache" } },
    "expo-document-picker": {},
    "expo-sharing": {},
    "./backup": backup,
  });
  const lines = await api.pickBackup();
  const values: string[] = [];
  for await (const line of lines!) values.push(line);
  assert.deepEqual(values, ["first", "last"]);
  assert.equal(copied.length, 1);
  assert.equal(deleted.length, 1);
  for await (const line of (await api.pickBackup())!) {
    assert.equal(line, "first");
    break;
  }
  assert.equal(deleted.length, 2);
  malformed = true;
  await assert.rejects(async () => {
    for await (const line of (await api.pickBackup())!) assert.fail(line);
  }, /encoded|utf-8/i);
  assert.equal(deleted.length, 3);
});

test("取消した出力はすぐ削除し、共有先の読み取り中は保持して期限後に回収する", async () => {
  let deleted = 0;
  const api = loadWithMocks<typeof Files>("src/storage/backup-file.ts", {
    "react-native": { Platform: { OS: "android" } },
    "expo-file-system": {},
    "expo-document-picker": {},
    "./backup": {},
    "expo-sharing": {
      isAvailableAsync: async () => true,
      shareAsync: async () => {},
    },
  });
  const file = {
    filename: "test.kifumate",
    blob: null,
    file: {
      uri: "file:///test",
      rename() {},
      delete: () => {
        deleted++;
      },
    },
  } as any;
  api.discardBackup(file);
  assert.equal(deleted, 1);
  await api.shareBackup(file);
  api.discardBackup(file);
  assert.equal(deleted, 1, "共有先が読み終える猶予を残す");
});

test("期限切れのキャッシュだけを走査で回収し、共有開始から1時間は古い出力も残す", () => {
  const now = Date.now(),
    removed: string[] = [];
  class File {
    constructor(
      public name: string,
      public modificationTime: number,
    ) {}
    delete() {
      removed.push(this.name);
    }
  }
  const api = loadWithMocks<typeof Files>("src/storage/backup-file.ts", {
    "react-native": { Platform: { OS: "android" } },
    "expo-file-system": {
      File,
      Paths: {
        cache: {
          list: () => [
            new File("kifumate-backup-old.kifumate", 1),
            new File("kifumate-import-old.tmp", 1),
            new File("kifumate-backup-recent.kifumate", now),
            new File(`kifumate-backup-old-shared-${now}.kifumate`, 1),
            new File("other-private-file", 1),
          ],
        },
      },
    },
    "expo-document-picker": {},
    "expo-sharing": {},
    "./backup": {},
  });
  api.clearExpiredBackups();
  assert.deepEqual(removed, [
    "kifumate-backup-old.kifumate",
    "kifumate-import-old.tmp",
  ]);
});
