import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useAnalysis } from "../analysis/provider";
import { colors, font, line, radius, shadow } from "./theme";
import { Button } from "./ui";
import { Sheet } from "./overlay";
export function AnalysisQuota() {
  const { quota: q, offline, problem, controller } = useAnalysis();
  const [details, setDetails] = useState(false);
  const meter = (label: string, left: number, max: number) => (
    <View
      accessibilityLabel={`${label} 残り${left}局`}
      style={{ gap: 5, marginTop: 10 }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={font(700, 11)}>{label}</Text>
        <Text style={font(900, 11)}>
          {max - left} / {max}局
        </Text>
      </View>
      <View style={s.meter}>
        <View
          style={{
            width: `${Math.min(100, ((max - left) * 100) / max)}%`,
            height: "100%",
            backgroundColor: colors.mint,
          }}
        />
      </View>
    </View>
  );
  return (
    <>
      <View style={s.card}>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <Text style={font(900, 16)}>
            {q ? (q.paid ? "有料プラン" : "無料プラン") : "解析の残り回数"}
          </Text>
          {q?.paid && <Text style={s.using}>利用中</Text>}
        </View>
        {q ? (
          <>
            {q.paid && meter("精密解析（今週）", q.preciseRemaining, 20)}
            {meter(
              q.paid ? "解析の合計（今週）" : "今週の解析",
              q.totalRemaining,
              q.paid ? 100 : 10,
            )}
            <Text style={[font(500, 10.5, 1.4, colors.ink2), { marginTop: 5 }]}>
              {q.paid ? "合計には精密解析も含みます。" : ""}毎週
              月曜の午前0時（日本時間）に 0 に戻ります
            </Text>
          </>
        ) : (
          <Text
            style={[font(500, 12, 1.5, colors.ink2), { marginVertical: 10 }]}
          >
            {problem || "回数を確認しています…"}
          </Text>
        )}
        {offline && (
          <Text style={[font(700, 11, 1.5, colors.ink2), { marginTop: 8 }]}>
            通信できません。残り回数は最後に確認したものです。
          </Text>
        )}
        <Button
          size="sm"
          wide
          style={{ marginTop: 12 }}
          onPress={() => router.push("/plan")}
        >
          {q?.paid ? "プランの内容を見る" : "有料プランを見る"}
        </Button>
        <Button size="sm" onPress={() => setDetails(true)}>
          残り回数と更新日時
        </Button>
      </View>
      <Sheet
        auto
        visible={details}
        title={q?.paid ? "有料プラン" : "解析の回数"}
        onClose={() => setDetails(false)}
      >
        <Text style={font(700, 13, 1.6)}>
          無料は週10局。有料プランは合計週100局、うち精密解析は20局まで。精密解析では候補を3手まで比べられます。招待コードで使えます。
        </Text>
        {q && (
          <Text style={[font(500, 12, 1.6), { marginVertical: 12 }]}>
            今週あと{q.totalRemaining}局
            {q.paid
              ? `、うち精密${Math.min(q.totalRemaining, q.preciseRemaining)}局`
              : ""}
            。解析中・待ちの予約を除く回数です。{`\n`}次の更新：
            {new Date(q.resetsAt).toLocaleString("ja-JP", {
              timeZone: "Asia/Tokyo",
            })}
            （日本時間）
          </Text>
        )}
        <Button onPress={() => void controller.sync()}>残り回数を確認</Button>
      </Sheet>
    </>
  );
}
const s = StyleSheet.create({
  card: {
    padding: 14,
    borderWidth: line.ol,
    borderColor: colors.ink,
    borderRadius: radius.card,
    backgroundColor: colors.white,
    boxShadow: shadow.card,
  },
  meter: {
    height: 10,
    borderWidth: line.thin,
    borderColor: colors.ink,
    borderRadius: radius.pill,
    overflow: "hidden",
    backgroundColor: colors.white,
  },
  using: {
    ...font(900, 10, 1.4),
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderWidth: line.thin,
    borderColor: colors.ink,
    borderRadius: radius.pill,
    backgroundColor: colors.you,
  },
});
