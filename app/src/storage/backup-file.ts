import { Platform } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { backupLimit, textLines } from "./backup";

export async function pickBackup(): Promise<AsyncIterable<string> | null> {
  if (Platform.OS === "web") {
    const picked = await DocumentPicker.getDocumentAsync({
      type: "*/*",
      base64: false,
    });
    if (picked.canceled) return null;
    const asset = picked.assets[0]!;
    if ((asset.size ?? 0) > backupLimit)
      throw new Error("バックアップは256MB以内にしてください。");
    return textLines(decodeChunks(asset.file!.stream()));
  }
  const picked = await File.pickFileAsync({ mimeTypes: ["*/*"] });
  if (picked.canceled) return null;
  if (picked.result.size > backupLimit)
    throw new Error("バックアップは256MB以内にしてください。");
  return readPickedBackup(picked.result);
}
async function* readPickedBackup(source: File) {
  const local = new File(
    Paths.cache,
    `kifumate-import-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    // DocumentsProviderのパイプはシークできない。copyは入力ストリームで転送する。
    await source.copy(local);
    if (local.size > backupLimit)
      throw new Error("バックアップは256MB以内にしてください。");
    yield* textLines(decodeChunks(local.readableStream()));
  } finally {
    try {
      local.delete();
    } catch {}
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
  try {
    for (const entry of Paths.cache.list())
      if (
        entry instanceof File &&
        /^(kifumate-backup-|kifumate-import-)/.test(entry.name)
      ) {
        const sharedAt = entry.name.match(/-shared-(\d+)\.kifumate$/)?.[1];
        const time = sharedAt ? Number(sharedAt) : entry.modificationTime;
        if (time !== null && time < Date.now() - shareLifetime)
          try {
            entry.delete();
          } catch {}
      }
  } catch {}
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
