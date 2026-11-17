import { router } from "expo-router";
import { AppBar, Button, EmptyState, Screen } from "../../components/ui";
// 集計は次の段階で作る。いまは、モックの「集計できる対局がない」ときの姿だけ。
export default function Stats() {
  return (
    <Screen>
      <AppBar title="戦績" />
      <EmptyState
        image="sys-empty"
        title="戦績の集計は準備中です"
        detail="自分の対局を取り込んでおくと、勝率などの成績をここに出せるようになります。"
      >
        <Button
          kind="pri"
          icon="plus"
          style={{ marginTop: 10 }}
          onPress={() => router.push("/import")}
        >
          棋譜を取り込む
        </Button>
      </EmptyState>
    </Screen>
  );
}
