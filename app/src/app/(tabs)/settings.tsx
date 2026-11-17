import { useCallback, useState } from "react";
import { ScrollView, Text } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import {
  AppBar,
  Button,
  Card,
  Hint,
  Row,
  Screen,
  SectionTitle,
} from "../../components/ui";
import * as Crypto from "expo-crypto";
import * as Clipboard from "expo-clipboard";
import { useAnalysis } from "../../analysis/provider";
import { tokenStore } from "../../analysis/token";
import { AnalysisQuota } from "../../components/analysis-quota";
import { Sheet, toast } from "../../components/overlay";
import { font } from "../../components/theme";
import { listAliases } from "../../storage/repository";
export default function Settings() {
  const db = useSQLiteContext();
  const { controller } = useAnalysis();
  const [names, setNames] = useState("");
  const [hash, setHash] = useState("");
  async function device() {
    try {
      const token = await tokenStore.get();
      if (!token) {
        toast("残り回数を確認してからお試しください");
        return;
      }
      setHash(
        await Crypto.digestStringAsync(
          Crypto.CryptoDigestAlgorithm.SHA256,
          token,
        ),
      );
    } catch {
      toast("端末の登録を読めませんでした");
    }
  }
  useFocusEffect(
    useCallback(() => {
      void controller.sync();
      listAliases(db)
        .then((a) => setNames(a.map((n) => n.name).join("、")))
        .catch(() => setNames(""));
    }, [db, controller]),
  );
  return (
    <Screen>
      <AppBar title="設定" />
      <ScrollView
        contentContainerStyle={{
          paddingTop: 9,
          paddingHorizontal: 14,
          paddingBottom: 22,
        }}
      >
        <AnalysisQuota />
        <SectionTitle>対局</SectionTitle>
        <Card>
          <Row
            first
            icon="user"
            title="自分の対局者名"
            sub={names || "未登録"}
            onPress={() => router.push("/names")}
          />
        </Card>
        <SectionTitle>データ</SectionTitle>
        <Hint style={{ marginTop: 0 }}>
          棋譜はこの端末の中だけに保存されています。まとめてバックアップする機能は準備中です。大切な棋譜は、対局の「…」から「KIFを書き出す」で保管してください。
        </Hint>
        <SectionTitle>このアプリ</SectionTitle>
        <Card>
          <Row
            first
            icon="info"
            title="このアプリについて"
            sub="ライセンス"
            onPress={() => router.push("/about")}
          />
        </Card>
        {__DEV__ && (
          <>
            <SectionTitle>開発用</SectionTitle>
            <Card>
              <Row
                first
                icon="info"
                title="解析用の端末登録"
                sub="開発用の有料許可に使う識別子"
                onPress={() => void device()}
              />
            </Card>
          </>
        )}
      </ScrollView>
      <Sheet
        auto
        visible={!!hash}
        title="開発用の端末登録"
        onClose={() => setHash("")}
      >
        <Text style={font(500, 12, 1.5)}>
          この識別子を staging
          の開発用許可一覧へ登録すると、精密解析を試せます。購入状態はサーバーの判定を使います。
        </Text>
        <Text selectable style={[font(700, 12, 1.5), { marginVertical: 14 }]}>
          {hash}
        </Text>
        <Button
          onPress={() =>
            void Clipboard.setStringAsync(hash).then(() =>
              toast("識別子をコピーしました"),
            )
          }
        >
          識別子をコピー
        </Button>
      </Sheet>
    </Screen>
  );
}
