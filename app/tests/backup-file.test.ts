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

test("非シーク提供元は公式DocumentPickerのストリームコピーを使い、失敗・取消もキャッシュを回収する", async () => {
  let malformed = false,
    disposed = 0;
  const api = loadWithMocks<typeof Files>("src/storage/backup-file.ts", {
    "react-native": { Platform: { OS: "android" } },
    "expo-document-picker": {
      getDocumentAsync: async (options: any) => {
        assert.equal(options.copyToCacheDirectory, true);
        return {
          canceled: false,
          assets: [
            {
              uri: "file:///cache/DocumentPicker/copied.kifumate",
              name: "copied.kifumate",
              size: null,
            },
          ],
        };
      },
    },
    "expo-file-system": {
      File: class {
        exists = true;
        size = 12;
        constructor(uri: string) {
          assert.equal(uri, "file:///cache/DocumentPicker/copied.kifumate");
        }
        delete() {
          if (this.exists) {
            this.exists = false;
            disposed++;
          }
        }
        readableStream() {
          return new ReadableStream({
            start(c) {
              c.enqueue(
                malformed
                  ? new Uint8Array([255])
                  : new TextEncoder().encode("first\nlast\n"),
              );
              c.close();
            },
          });
        }
      },
    },
    "expo-sharing": {},
    "./backup": await import("../src/storage/backup"),
  });
  const first = await api.pickBackup();
  const values = [];
  for await (const line of first!) values.push(line);
  assert.deepEqual(values, ["first", "last"]);
  assert.equal(disposed, 1);
  const canceled = await api.pickBackup();
  for await (const line of canceled!) {
    assert.equal(line, "first");
    break;
  }
  assert.equal(disposed, 2);
  malformed = true;
  await assert.rejects(async () => {
    for await (const line of (await api.pickBackup())!) assert.fail(line);
  }, /encoded|utf-8/i);
  assert.equal(disposed, 3);
  const unused = await api.pickBackup();
  unused!.dispose();
  assert.equal(disposed, 4);
});
test("提供元のサイズが不明でも、キャッシュの実サイズで拒否し直ちに削除する", async () => {
  let removed = false;
  const api = loadWithMocks<typeof Files>("src/storage/backup-file.ts", {
    "react-native": { Platform: { OS: "android" } },
    "expo-document-picker": {
      getDocumentAsync: async () => ({
        canceled: false,
        assets: [
          { uri: "file:///cache/copied", name: "backup.kifumate", size: null },
        ],
      }),
    },
    "expo-file-system": {
      File: class {
        size = 9;
        exists = true;
        delete() {
          removed = true;
        }
        readableStream() {
          assert.fail("上限超過は読む前に拒否");
        }
      },
    },
    "expo-sharing": {},
    "./backup": { backupLimit: 8 },
  });
  await assert.rejects(api.pickBackup(), /256MB/);
  assert(removed);
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

test("OSのコピー中に容量不足で失敗しても今回の部分キャッシュを回収する", async () => {
  const files: any[] = [];
  let removed = false;
  class File {
    uri = "file:///cache/DocumentPicker/partial";
    delete() {
      removed = true;
    }
  }
  const api = loadWithMocks<typeof Files>("src/storage/backup-file.ts", {
    "react-native": { Platform: { OS: "android" } },
    "expo-file-system": {
      File,
      Paths: { cache: "cache" },
      Directory: class {
        list() {
          return files;
        }
      },
    },
    "expo-document-picker": {
      getDocumentAsync: async () => {
        files.push(new File());
        throw Error("容量不足");
      },
    },
    "expo-sharing": {},
    "./backup": {},
  });
  await assert.rejects(api.pickBackup(), /容量不足/);
  assert(removed);
});

test("強制終了でDocumentPickerに残った古いキャッシュも回収し、直近と他のファイルは保つ", () => {
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
      Paths: { cache: { list: () => [new File("unrelated", 1)] } },
      Directory: class {
        list() {
          return [
            new File("orphan.kifumate", now - 3600001),
            new File("in-progress.kifumate", now),
          ];
        }
      },
    },
    "expo-document-picker": {},
    "expo-sharing": {},
    "./backup": {},
  });
  api.clearExpiredBackups();
  assert.deepEqual(removed, ["orphan.kifumate"]);
});

test("起動時に期限切れバックアップを掃除する", () => {
  let cleaned = 0;
  const api = loadWithMocks<{ DataProvider: (p: object) => unknown }>(
    "src/components/data-provider.tsx",
    {
      react: {
        createContext: () => ({ Provider: "Provider" }),
        useContext: () => ({}),
        useCallback: (f: any) => f,
        useState: (v: any) => [v, () => {}],
        useEffect: (f: () => void) => f(),
      },
      "expo-sqlite": {
        useSQLiteContext: () => ({
          getFirstAsync: async () => ({ value: "true" }),
        }),
      },
      "./ui": { Problem: "Problem", Screen: "Screen" },
      "../storage/backup-file": {
        clearExpiredBackups: () => {
          cleaned++;
        },
      },
    },
  );
  api.DataProvider({});
  assert.equal(cleaned, 1);
});

test("バックアップ選択はMIMEを絞り、Webでは拡張子も指定する", async () => {
  for (const platform of ["android", "web"]) {
    let types: string[] = [];
    const api = loadWithMocks<typeof Files>("src/storage/backup-file.ts", {
      "react-native": { Platform: { OS: platform } },
      "expo-file-system": {},
      "expo-sharing": {},
      "./backup": {},
      "expo-document-picker": {
        getDocumentAsync: async (options: any) => {
          types = options.type;
          return { canceled: true };
        },
      },
    });
    assert.equal(await api.pickBackup(), null);
    assert(types.includes("application/octet-stream"));
    assert(types.includes("application/x-kifumate-backup"));
    assert(!types.includes("*/*"));
    assert(!types.some((t) => t.startsWith("video/")));
    assert.equal(types.includes(".kifumate"), platform === "web");
  }
});
test("形式を偽った選択も拡張子で拒否しキャッシュを回収する", async () => {
  let deleted = false;
  const api = loadWithMocks<typeof Files>("src/storage/backup-file.ts", {
    "react-native": { Platform: { OS: "android" } },
    "expo-sharing": {},
    "./backup": { backupLimit: 100 },
    "expo-file-system": {
      File: class {
        exists = true;
        size = 1;
        delete() {
          deleted = true;
        }
        readableStream() {
          assert.fail("動画を読まない");
        }
      },
    },
    "expo-document-picker": {
      getDocumentAsync: async () => ({
        canceled: false,
        assets: [{ name: "video.mp4", uri: "file:///cache/video", size: 1 }],
      }),
    },
  });
  await assert.rejects(api.pickBackup(), /\.kifumate/);
  assert(deleted);
});
