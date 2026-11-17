import { useState } from "react";
import { Platform, View } from "react-native";
import { router, Stack } from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import type { Record as ShogiRecord } from "tsshogi";
import { Button, Card, Field, Label, Message, Page } from "../components/ui";
import { IdentityFields } from "../components/identity-fields";
import {
  decodeKif,
  describe,
  gameOutcome,
  matchNames,
  MAX_BYTES,
  readKif,
  resultFor,
  type Result,
  type Side,
} from "../core/kif";
import { importGame, listAliases } from "../storage/repository";
export default function Import() {
  const db = useSQLiteContext();
  const [text, setText] = useState(""),
    [record, setRecord] = useState<ShogiRecord | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [side, setSide] = useState<Side>(null),
    [result, setResult] = useState<Result>("unknown"),
    [sideManual, setSideManual] = useState(false),
    [resultManual, setResultManual] = useState(false),
    [busy, setBusy] = useState(false),
    [duplicate, setDuplicate] = useState("");
  async function preview(input: string) {
    setError("");
    setDuplicate("");
    setRecord(null);
    setBusy(true);
    try {
      const r = readKif(input),
        d = describe(r),
        names = await listAliases(db),
        match = matchNames(
          d.black,
          d.white,
          names.map((n) => n.name),
        );
      setRecord(r);
      setSide(match.side);
      setResult(resultFor(match.side, gameOutcome(r)));
      setSideManual(false);
      setResultManual(false);
      setNotice(
        match.ambiguous
          ? "両方の名前が登録名に一致しました。自分がどちらか選んでください。"
          : !match.side
            ? "登録名に一致しませんでした。自分の棋譜なら、先手・後手を指定してください。"
            : "登録名から判定しました。違っていたら直せます。",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み取れませんでした。");
    } finally {
      setBusy(false);
    }
  }
  async function pick() {
    setError("");
    try {
      let buffer: ArrayBuffer;
      if (Platform.OS === "web") {
        const picked = await DocumentPicker.getDocumentAsync({
          type: "*/*",
          base64: false,
        });
        if (picked.canceled) return;
        const asset = picked.assets[0]!;
        if ((asset.size ?? 0) > MAX_BYTES)
          throw new Error("ファイルは2MB以内にしてください。");
        buffer = await asset.file!.arrayBuffer();
      } else {
        // File自身のピッカーで読み取り権限を受け取る（共有キャッシュのパスに依存しない）。
        const picked = await File.pickFileAsync({ mimeTypes: ["*/*"] });
        if (picked.canceled) return;
        if (picked.result.size > MAX_BYTES)
          throw new Error("ファイルは2MB以内にしてください。");
        buffer = await picked.result.arrayBuffer();
      }
      const decoded = decodeKif(new Uint8Array(buffer));
      setText(decoded);
      await preview(decoded);
    } catch (e) {
      setError(e instanceof Error ? e.message : "ファイルを開けませんでした。");
    }
  }
  async function save() {
    if (!record || busy) return;
    setBusy(true);
    setError("");
    try {
      const saved = await importGame(
        db,
        record,
        side,
        result,
        sideManual,
        resultManual,
      );
      if (saved.duplicate) {
        setDuplicate(saved.id);
        setNotice(
          "同じ開始局面と指し手の棋譜が、すでにあります。重ねて保存していません。",
        );
      } else {
        router.dismissTo("/");
      }
    } catch {
      setError("棋譜を保存できませんでした。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  }
  const d = record ? describe(record) : null;
  return (
    <Page>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Button onPress={() => router.back()}>閉じる</Button>
          ),
        }}
      />
      <Label title>指した将棋を、ここに。</Label>
      <Label muted>
        UTF-8・Shift_JIS のKIFに対応しています。取り込みは端末内だけで行います。
      </Label>
      <Button disabled={busy} onPress={() => void pick()}>
        ファイルを選ぶ
      </Button>
      <Field
        multiline
        accessibilityLabel="KIFの本文"
        placeholder="KIFの本文を貼り付け"
        value={text}
        onChangeText={(t) => {
          setText(t);
          setRecord(null);
          setDuplicate("");
          setNotice("");
        }}
        editable={!busy}
        style={{ minHeight: 180 }}
      />
      <Button
        disabled={busy || !text.trim()}
        onPress={() => void preview(text)}
      >
        内容を確認
      </Button>
      <Message text={error} error />
      {d && (
        <Card>
          <Label title>取り込む棋譜</Label>
          <Label>先手：{d.black}</Label>
          <Label>後手：{d.white}</Label>
          <Label muted>
            {d.date || "対局日不明"}・{d.plies}手
          </Label>
          <Message text={notice} />
          <IdentityFields
            side={side}
            result={result}
            onSide={(s) => {
              setSide(s);
              setSideManual(true);
              if (!resultManual) setResult(resultFor(s, gameOutcome(record!)));
            }}
            onResult={(r) => {
              setResult(r);
              setResultManual(true);
            }}
          />
          <View>
            {duplicate ? (
              <Button
                primary
                onPress={() => {
                  router.dismissTo("/");
                  router.push(`/game/${duplicate}`);
                }}
              >
                保存済みの棋譜を開く
              </Button>
            ) : (
              <Button primary disabled={busy} onPress={() => void save()}>
                {busy ? "保存中…" : "棋譜を保存"}
              </Button>
            )}
          </View>
        </Card>
      )}
    </Page>
  );
}
