import { Text, View } from "react-native";
import { router } from "expo-router";
import { COACH_ENABLED, DISTRIBUTION } from "../analysis/environment";
import { colors, font, line, radius, shadow } from "../components/theme";
import {
  Button,
  Card,
  Hint,
  MascotImage,
  PageHeader,
  PageScroll,
  Screen,
  TextButton,
} from "../components/ui";
import { Icon } from "../components/icons";
import { toast } from "../components/overlay";
import { planCopy } from "../entitlements/distribution";
const rows = [
  ["棋譜の保存・再生\n戦績の集計", "✓", "✓"],
  [
    "対局の解析",
    "ふつうの解析\n週10局\n候補1手",
    "精密解析\n週20局\n候補3手・深い読み\n合計 週100局",
  ],
  ["分岐して手を試す", "✓", "✓"],
  ["リアルタイム解析", "—", "✓"],
  ...(COACH_ENABLED ? [["AIコーチ", "—", "解説と質問"]] : []),
];
export default function Plan() {
  const copy = planCopy(DISTRIBUTION);
  return (
    <Screen bottom>
      <PageHeader title="有料プラン" />
      <PageScroll>
        <Card
          style={{
            flexDirection: "row",
            gap: 12,
            alignItems: "center",
            paddingVertical: 12,
            paddingLeft: 10,
            paddingRight: 14,
          }}
        >
          <MascotImage name="onb-5" height={104} />
          <View style={{ flex: 1 }}>
            <Text style={font(900, 18, 1.2)}>{copy.heading}</Text>
            <Text style={[font(500, 11.5, 1.6, colors.ink2), { marginTop: 6 }]}>
              {COACH_ENABLED
                ? "精密解析、リアルタイム解析、AIコーチの解説と質問が使えます。"
                : "精密解析とリアルタイム解析が使えます。"}
            </Text>
          </View>
        </Card>
        <View
          style={{
            borderWidth: line.ol,
            borderColor: colors.ink,
            borderRadius: radius.card,
            overflow: "hidden",
            marginTop: 12,
            boxShadow: shadow.card,
            backgroundColor: colors.white,
          }}
        >
          {[["できること", "無料", "有料"], ...rows].map((row, i) => (
            <View
              key={row[0]}
              style={{
                flexDirection: "row",
                borderTopWidth: i > 1 ? 1 : 0,
                borderBottomWidth: i === 0 ? line.ol : 0,
                borderColor: i === 0 ? colors.ink : colors.hair,
              }}
            >
              {row.map((text, j) => (
                <View
                  key={j}
                  style={{
                    flex: 1,
                    paddingVertical: 9,
                    paddingHorizontal: 7,
                    justifyContent: "center",
                    alignItems: j === 0 ? "flex-start" : "center",
                    borderLeftWidth: j ? 1 : 0,
                    borderColor: colors.hair,
                    backgroundColor:
                      i === 0
                        ? j === 2
                          ? colors.mint
                          : colors.sand
                        : colors.white,
                  }}
                >
                  {text === "✓" ? (
                    <View
                      accessibilityLabel="使えます"
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: radius.pill,
                        borderWidth: line.thin,
                        borderColor: colors.ink,
                        backgroundColor: colors.mint,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Icon name="check" size={11} strokeWidth={3.2} />
                    </View>
                  ) : i === 2 && j > 0 ? (
                    <Text style={[font(500, 11, 1.5), { textAlign: "center" }]}>
                      <Text style={font(900, 12, 1.5)}>
                        {text.split("\n").slice(0, 2).join("\n")}
                      </Text>
                      {"\n"}
                      {text.split("\n").slice(2).join("\n")}
                    </Text>
                  ) : (
                    <Text
                      style={[
                        font(
                          i === 0 || text === "—" || (i === 5 && j === 2)
                            ? 900
                            : j === 0
                              ? 700
                              : 500,
                          i === 0 ? 11.5 : 11,
                          i === 0 ? 1.2 : 1.5,
                          text === "—" ? colors.ink2 : colors.ink,
                        ),
                        { textAlign: j === 0 ? "left" : "center" },
                      ]}
                    >
                      {text}
                    </Text>
                  )}
                </View>
              ))}
            </View>
          ))}
        </View>
        <Hint>
          {COACH_ENABLED
            ? "リアルタイム解析は月300分（解析が動いている間を数えます）、AIコーチには週ごとの利用枠があり、設定で残りを確認できます。残りが少なくなったら、お知らせします。"
            : "リアルタイム解析は月300分（解析が動いている間を数えます）です。残りが少なくなったら、お知らせします。"}
        </Hint>
        <Button
          wide
          kind="pri"
          onPress={() =>
            DISTRIBUTION === "invite"
              ? router.push("/invitation")
              : toast("ストアでの購入は準備中です")
          }
        >
          {copy.action}
        </Button>
        {copy.restore && (
          <TextButton onPress={() => toast("ストアでの購入の復元は準備中です")}>
            {copy.restore}
          </TextButton>
        )}
        <Hint>{copy.note}</Hint>
      </PageScroll>
    </Screen>
  );
}
