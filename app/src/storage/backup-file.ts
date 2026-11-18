import { Platform } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { backupLimit, textLines } from "./backup";

export async function pickBackup(): Promise<AsyncIterable<string> | null> {
  let stream: ReadableStream<Uint8Array>;
  if (Platform.OS === "web") {
    const picked = await DocumentPicker.getDocumentAsync({
      type: "*/*",
      base64: false,
    });
    if (picked.canceled) return null;
    const asset = picked.assets[0]!;
    if ((asset.size ?? 0) > backupLimit)
      throw new Error("バックアップは256MB以内にしてください。");
    stream = asset.file!.stream();
  } else {
    const picked = await File.pickFileAsync({ mimeTypes: ["*/*"] });
    if (picked.canceled) return null;
    if (picked.result.size > backupLimit)
      throw new Error("バックアップは256MB以内にしてください。");
    stream = picked.result.readableStream();
  }
  return textLines(decodeChunks(stream));
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
export async function writeBackupFile(lines: AsyncIterable<string>) {
  const filename = `kifumate-backup-${new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")}.kifumate`;
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
    return;
  }
  if (!(await Sharing.isAvailableAsync()))
    throw new Error("共有を使えません。「ファイルに保存」をお試しください。");
  await Sharing.shareAsync(file.file!.uri, {
    mimeType: "application/octet-stream",
    UTI: "public.data",
    dialogTitle: "バックアップを保存・共有",
  });
}
export async function saveBackup(file: BackupFile) {
  if (Platform.OS !== "android") return shareBackup(file);
  const dir = await Directory.pickDirectoryAsync();
  // content:// の子URIを文字列で組み立てず、OSが返したフォルダーへコピーする。
  await file.file!.copy(dir);
}
