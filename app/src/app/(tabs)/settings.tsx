import { useCallback, useState } from "react";
import { ScrollView } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import {
  AppBar,
  Card,
  Hint,
  Row,
  Screen,
  SectionTitle,
} from "../../components/ui";
import { listAliases } from "../../storage/repository";
export default function Settings() {
  const db = useSQLiteContext();
  const [names, setNames] = useState("");
  useFocusEffect(
    useCallback(() => {
      listAliases(db)
        .then((a) => setNames(a.map((n) => n.name).join("、")))
        .catch(() => setNames(""));
    }, [db]),
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
        <SectionTitle first>対局</SectionTitle>
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
      </ScrollView>
    </Screen>
  );
}
