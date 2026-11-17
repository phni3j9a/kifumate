import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Sheet } from "./overlay";
import { colors, font, fonts, line, mono } from "./theme";
import { Hint, TextButton } from "./ui";

const sample = `開始日時：2026/11/15 20:05:08
先手：hiyodori
後手：tsubame
手数----指手---------消費時間--
   1 ７六歩(77)   ( 0:04/00:00:04)
   2 ３四歩(33)   ( 0:02/00:00:06)`;
/** 「KIFってなに？」の入口と、その説明シート（モックの KIF_HELP / A.kifhelp） */
export function KifHelpLink() {
  const [open, setOpen] = useState(false);
  const p = font(500, 12.5, 1.75);
  return (
    <>
      <TextButton onPress={() => setOpen(true)}>
        KIFってなに？ どこで手に入る？
      </TextButton>
      <Sheet
        auto
        visible={open}
        title="KIFについて"
        onClose={() => setOpen(false)}
      >
        <Text style={p}>
          <Text style={{ fontFamily: fonts[700] }}>KIF</Text>
          は、将棋の棋譜を保存するための形式です。対局者の名前、日付、指し手が、テキストで書かれています。
        </Text>
        <Text style={[p, { marginTop: 8 }]}>
          多くの対局サイトや対局アプリには、「棋譜をコピー」「棋譜を保存」「KIF出力」などのメニューがあり、そこから取り出せます。
        </Text>
        <Text style={[p, { marginTop: 8 }]}>
          コピーしたら「テキスト」で貼り付け、ファイルなら「ファイル」で選んで取り込みます。
        </Text>
        <View
          style={{
            marginTop: 12,
            borderWidth: line.ol,
            borderColor: colors.ink,
            borderRadius: 12,
            backgroundColor: colors.white,
          }}
        >
          <ScrollView
            horizontal
            contentContainerStyle={{
              paddingVertical: 10,
              paddingHorizontal: 12,
            }}
          >
            <Text
              style={{
                fontFamily: mono,
                fontSize: 11,
                lineHeight: 17.6,
                color: colors.ink,
              }}
            >
              {sample}
            </Text>
          </ScrollView>
        </View>
        <Hint>こういう形のテキストです。拡張子は .kif か .kifu です。</Hint>
      </Sheet>
    </>
  );
}
