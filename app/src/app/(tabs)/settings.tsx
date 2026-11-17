import { router } from "expo-router";
import { Button, Card, Label, Page } from "../../components/ui";
export default function Settings() {
  return (
    <Page>
      <Card>
        <Label title>自分の対局</Label>
        <Label muted>いつもの名前を登録すると、先後と勝敗を見分けます。</Label>
        <Button onPress={() => router.push("/names")}>自分の対局者名</Button>
      </Card>
      <Card>
        <Label>オフラインで使えます</Label>
        <Label muted>
          棋譜はこの端末だけに保存されます。解析・AIコーチ・一括バックアップ・同期は準備中です。大切な棋譜はKIFで書き出して保管してください。
        </Label>
      </Card>
      <Card>
        <Label>このアプリについて</Label>
        <Label muted>kifumate 0.1.0</Label>
        <Button onPress={() => router.push("/licenses")}>ライセンス</Button>
      </Card>
    </Page>
  );
}
