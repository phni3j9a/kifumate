import { useCoach } from "../../coach/provider";
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
import { useAnalysis } from "../../analysis/provider";
import { AnalysisQuota } from "../../components/analysis-quota";
import { listAliases } from "../../storage/repository";
export default function Settings() {
  const db = useSQLiteContext();
  const { profile } = useCoach();
  const { controller } = useAnalysis();
  const [names, setNames] = useState("");
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
        <SectionTitle>招待コード</SectionTitle>
        <Card>
          <Row
            first
            icon="lock"
            title="招待コードを入力"
            sub="有料機能をこの端末で使う"
            onPress={() => router.push("/invitation")}
          />
        </Card>
        <SectionTitle>対局と解説</SectionTitle>
        <Card>
          <Row
            first
            icon="user"
            title="自分の対局者名"
            sub={names || "未登録"}
            onPress={() => router.push("/names")}
          />
          <Row
            icon="flag"
            title="学習プロフィール"
            sub={`練習中の戦法：${profile.practice.join("・") || "なし"}`}
            onPress={() => router.push("/profile")}
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
