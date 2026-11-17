import { Text, View } from "react-native";
import { font } from "../components/theme";
import { Button, Hint } from "../components/ui";
import { useEntitlements } from "./provider";
export function EntitlementStatus() {
  const {
    entitlement: value,
    checked,
    offline,
    controller,
  } = useEntitlements();
  return (
    <View>
      <Text style={font(900, 16)}>
        {!checked
          ? "権利を確認しています…"
          : offline
            ? "今の権利を確認できません"
            : value.paid
              ? "有料プランを利用中"
              : "無料プラン"}
      </Text>
      {value.paid && (
        <Hint>
          {value.expiresAt === null
            ? "期限なし"
            : `期限：${new Date(value.expiresAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}（日本時間）`}
        </Hint>
      )}
      {offline && (
        <Hint>
          通信できません。つながって権利を確認すると、有料機能を使えます。保存した結果はそのまま読めます。
        </Hint>
      )}
      <Button
        size="sm"
        style={{ marginTop: 10, alignSelf: "flex-start" }}
        onPress={() => void controller.refresh().catch(() => {})}
      >
        今の権利を確認
      </Button>
    </View>
  );
}
