import { Text, View } from "react-native";
import { router } from "expo-router";
import { DISTRIBUTION } from "../analysis/environment";
import { colors, font, line, radius } from "../components/theme";
import {
  Button,
  Card,
  Hint,
  MascotImage,
  PageHeader,
  PageScroll,
  Screen,
} from "../components/ui";
import { EntitlementStatus } from "../entitlements/status";
const rows = [
  ["棋譜の保存・再生\n戦績の集計", "✓", "✓"],
  [
    "対局の解析",
    "ふつうの解析\n週10局\n候補1手",
    "精密解析\n週20局\n候補3手・深い読み\n合計 週100局",
  ],
  ["分岐して手を試す", "✓", "✓"],
  ["分岐中の解析", "—", "✓"],
  ["AIコーチ", "—", "解説と質問"],
];
export default function Plan() {
  return (
    <Screen bottom>
      <PageHeader title="有料プラン" />
      <PageScroll>
        <Card style={{ padding: 14 }}>
          <EntitlementStatus />
        </Card>
        <View
          style={{
            flexDirection: "row",
            gap: 14,
            alignItems: "center",
            marginVertical: 14,
          }}
        >
          <MascotImage name="onb-5" height={80} />
          <View style={{ flex: 1 }}>
            <Text style={font(900, 18)}>
              {DISTRIBUTION === "invite"
                ? "招待コードで使えます"
                : "有料プラン"}
            </Text>
            <Hint>
              精密解析、分岐中の解析、AIコーチの解説と質問が使えます。
            </Hint>
          </View>
        </View>
        <View
          style={{
            borderWidth: line.ol,
            borderColor: colors.ink,
            borderRadius: radius.card,
            overflow: "hidden",
          }}
        >
          {[["できること", "無料", "有料"], ...rows].map((row, i) => (
            <View
              key={row[0]}
              style={{
                flexDirection: "row",
                borderTopWidth: i ? line.thin : 0,
                borderColor: colors.ink,
                backgroundColor: i === 0 ? colors.sand : colors.white,
              }}
            >
              {row.map((text, j) => (
                <Text
                  key={j}
                  style={[
                    font(j === 0 ? 700 : 900, 11, 1.6),
                    {
                      flex: j === 0 ? 1.35 : 1,
                      paddingVertical: 12,
                      paddingHorizontal: 6,
                      textAlign: j === 0 ? "left" : "center",
                    },
                  ]}
                >
                  {text}
                </Text>
              ))}
            </View>
          ))}
        </View>
        <Hint>
          分岐中の解析は月300分（解析が動いている間を数えます）、AIコーチは月100回まで使えます。残りが少なくなったら、お知らせします。
        </Hint>
        <Button wide kind="pri" onPress={() => router.push("/invitation")}>
          招待コードを入力
        </Button>
        <Hint>
          招待コードはこの端末だけで使えます。期限が切れたり、取り消されたりすると無料プランに戻ります。保存した解析結果と解説は、そのあとも読めます。
        </Hint>
      </PageScroll>
    </Screen>
  );
}
