import { Platform, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";
import { Sheet, toast } from "./overlay";
import { Button, Hint, KifArea } from "./ui";

/** 「KIFを書き出す」シート（モックの A.kifout）。本譜だけを UTF-8 の .kifu で出す */
export default function ExportSheet({
  visible,
  onClose,
  id,
  kif,
}: {
  visible: boolean;
  onClose: () => void;
  id: string;
  kif: string;
}) {
  async function copy() {
    try {
      await Clipboard.setStringAsync(kif);
      toast("コピーしました");
    } catch {
      toast("コピーできませんでした。本文を選んでコピーしてください");
    }
  }
  async function share() {
    try {
      const filename = `kifumate-${id}.kifu`;
      if (Platform.OS === "web") {
        const url = URL.createObjectURL(
          new Blob([kif], { type: "text/plain;charset=utf-8" }),
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast("ファイルに保存しました");
      } else {
        if (!(await Sharing.isAvailableAsync()))
          throw new Error(
            "共有はこの端末で利用できません。コピーで書き出してください。",
          );
        const file = new File(Paths.cache, filename);
        await file.write(kif);
        await Sharing.shareAsync(file.uri, {
          mimeType: "text/plain",
          dialogTitle: "KIFを保存・共有",
          UTI: "public.plain-text",
        });
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "書き出せませんでした。");
    }
  }
  return (
    <Sheet auto visible={visible} title="KIFを書き出す" onClose={onClose}>
      <KifArea
        editable={false}
        accessibilityLabel="書き出すKIF"
        value={kif}
        height={210}
        size={11}
      />
      <View style={{ gap: 9, marginTop: 16 }}>
        <Button kind="pri" wide icon="copy" onPress={() => void copy()}>
          コピーする
        </Button>
        {/* 保存先を選ぶ画面と共有は、OSの共有シートが1つで受け持つ（Web はダウンロード） */}
        <Button
          size="md"
          wide
          icon={Platform.OS === "web" ? "file" : "export"}
          onPress={() => void share()}
        >
          {Platform.OS === "web" ? "ファイルに保存" : "ファイルに保存・共有"}
        </Button>
      </View>
      <Hint>
        本譜を UTF-8 の
        KIF（.kifu）で書き出します。試した分岐と、アプリの中で直した結果は入りません。
      </Hint>
    </Sheet>
  );
}
