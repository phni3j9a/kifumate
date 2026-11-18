import { Platform } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { backupLimit, textLines } from "./backup";

export type BackupInput = AsyncIterable<string> & { dispose: () => void };
export async function pickBackup(): Promise<BackupInput | null> {
  const previous = new Set(pickerCacheFiles().map((f) => f.uri));
  try {
    const picked = await DocumentPicker.getDocumentAsync({
      type:
        Platform.OS === "web"
          ? [
              ".kifumate",
              "application/x-kifumate-backup",
              "application/octet-stream",
            ]
          : ["application/x-kifumate-backup", "application/octet-stream"],
      base64: false,
      copyToCacheDirectory: true,
    });
    if (picked.canceled) return null;
    const asset = picked.assets[0]!;
    const file = Platform.OS === "web" ? null : new File(asset.uri);
    const dispose = () => {
      try {
        if (file?.exists) file.delete();
      } catch {}
    };
    try {
      if (!asset.name.toLowerCase().endsWith(".kifumate"))
        throw new Error("拡張子が.kifumateのバックアップを選んでください。");
      if ((file?.size ?? asset.size ?? 0) > backupLimit)
        throw new Error("バックアップは256MB以内にしてください。");
      async function* lines() {
        try {
          yield* textLines(
            decodeChunks(file ? file.readableStream() : asset.file!.stream()),
          );
        } finally {
          dispose();
        }
      }
      return Object.assign(lines(), { dispose });
    } catch (e) {
      dispose();
      throw e;
    }
  } catch (e) {
    // OSコピー自体が失敗してURIを受け取れなかった場合も、今回できたキャッシュだけを回収する。
    for (const file of pickerCacheFiles())
      if (!previous.has(file.uri))
        try {
          file.delete();
        } catch {}
    throw e;
  }
}
function pickerCacheFiles(): File[] {
  if (Platform.OS === "web") return [];
  try {
    return new Directory(Paths.cache, "DocumentPicker")
      .list()
      .filter((f): f is File => f instanceof File);
  } catch {
    return [];
  }
}

async function* decodeChunks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > backupLimit)
        throw new Error("バックアップは256MB以内にしてください。");
      yield decoder.decode(value, { stream: true });
    }
    const last = decoder.decode();
    if (last) yield last;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
const shared = new WeakSet<BackupFile>();
const shareLifetime = 60 * 60 * 1000;
export function clearExpiredBackups() {
  if (Platform.OS === "web") return;
  const files = pickerCacheFiles();
  try {
    files.push(
      ...Paths.cache
        .list()
        .filter(
          (entry): entry is File =>
            entry instanceof File &&
            /^(kifumate-backup-|kifumate-import-)/.test(entry.name),
        ),
    );
  } catch {}
  for (const entry of files) {
    try {
      const sharedAt = entry.name.match(/-shared-(\d+)\.kifumate$/)?.[1];
      const time = sharedAt ? Number(sharedAt) : entry.modificationTime;
      if (time !== null && time < Date.now() - shareLifetime) entry.delete();
    } catch {}
  }
}

export function discardBackup(file: BackupFile) {
  if (!file.file) return;
  const remove = () => {
    try {
      file.file!.delete();
    } catch {}
  };
  if (shared.has(file)) {
    // 共有シート終了後も受取先が読むことがある。再起動時は上の期限走査で回収する。
    const timer = setTimeout(remove, shareLifetime);
    timer.unref?.();
  } else remove();
}
export async function writeBackupFile(lines: AsyncIterable<string>) {
  clearExpiredBackups();
  const filename = `kifumate-backup-${new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(
      /\.\d+Z$/,
      "",
    )}-${Math.random().toString(36).slice(2, 8)}.kifumate`;
  if (Platform.OS === "web") {
    const chunks: BlobPart[] = [];
    for await (const line of lines) chunks.push(line);
    const blob = new Blob(chunks, { type: "application/x-kifumate-backup" });
    return { filename, blob, file: null };
  }
  const file = new File(Paths.cache, filename);
  await file.create();
  const writer = file.writableStream().getWriter(),
    encoder = new TextEncoder();
  try {
    for await (const line of lines) await writer.write(encoder.encode(line));
    await writer.close();
  } catch (e) {
    await writer.abort().catch(() => {});
    try {
      file.delete();
    } catch {}
    throw e;
  }
  return { filename, blob: null, file };
}
export type BackupFile = Awaited<ReturnType<typeof writeBackupFile>>;
export async function shareBackup(file: BackupFile) {
  if (file.blob) {
    const url = URL.createObjectURL(file.blob),
      a = document.createElement("a");
    a.href = url;
    a.download = file.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return false;
  }
  if (!(await Sharing.isAvailableAsync()))
    throw new Error("共有を使えません。「ファイルに保存」をお試しください。");
  await file.file!.rename(
    file.filename.replace(/\.kifumate$/, `-shared-${Date.now()}.kifumate`),
  );
  shared.add(file);
  await Sharing.shareAsync(file.file!.uri, {
    mimeType: "application/octet-stream",
    UTI: "public.data",
    dialogTitle: "バックアップを保存・共有",
  });
  return false;
}
export async function saveBackup(file: BackupFile) {
  if (Platform.OS !== "android") return shareBackup(file);
  const dir = await Directory.pickDirectoryAsync();
  // content:// の子URIを文字列で組み立てず、OSが返したフォルダーへコピーする。
  await file.file!.copy(dir);
  return true;
}
