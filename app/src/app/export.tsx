import { useState } from "react";
import { Platform } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";
import { Button, Field, Label, Message, Page } from "../components/ui";
import { useGame } from "../components/use-game";
export default function Export() {
  const { id } = useLocalSearchParams<{ id: string }>(),
    { game, error } = useGame(id);
  const [message, setMessage] = useState(""),
    [failure, setFailure] = useState("");
  async function copy() {
    try {
      await Clipboard.setStringAsync(game!.kif);
      setMessage("コピーしました。");
      setFailure("");
    } catch {
      setFailure("コピーできませんでした。本文を選択してコピーできます。");
    }
  }
  async function share() {
    setFailure("");
    try {
      const filename = `kifumate-${id}.kifu`;
      if (Platform.OS === "web") {
        const url = URL.createObjectURL(
          new Blob([game!.kif], { type: "text/plain;charset=utf-8" }),
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage("UTF-8のKIFを書き出しました。");
      } else {
        if (!(await Sharing.isAvailableAsync()))
          throw new Error(
            "共有はこの端末で利用できません。コピーで書き出してください。",
          );
        const file = new File(Paths.cache, filename);
        file.write(game!.kif);
        await Sharing.shareAsync(file.uri, {
          mimeType: "text/plain",
          dialogTitle: "KIFを保存・共有",
          UTI: "public.plain-text",
        });
      }
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "書き出せませんでした。");
    }
  }
  return (
    <Page>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Button onPress={() => router.back()}>閉じる</Button>
          ),
        }}
      />
      <Label title>大切な一局を、手元に。</Label>
      <Label muted>
        本譜をUTF-8のKIF（.kifu）で書き出します。この画面で試した分岐やアプリ内での結果修正は含めません。
      </Label>
      <Message text={error || failure} error />
      <Message text={message} />
      {game && (
        <>
          <Field
            multiline
            editable={false}
            accessibilityLabel="書き出すKIF"
            value={game.kif}
            style={{ minHeight: 280 }}
          />
          <Button primary onPress={() => void share()}>
            {Platform.OS === "web" ? "ファイルに保存" : "ファイルを保存・共有"}
          </Button>
          <Button onPress={() => void copy()}>コピーする</Button>
        </>
      )}
    </Page>
  );
}
