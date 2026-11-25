import { COACH_ENABLED } from "../analysis/environment";
import { useEntitlements } from "../entitlements/provider";
import { router } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { useAnalysis } from "../analysis/provider";
import { useCoach } from "../coach/provider";
import { colors, font, line, radius, shadow } from "./theme";
import { Button } from "./ui";
export function AnalysisQuota() {
  const { quota: q, offline, problem } = useAnalysis();
  const { overview, offline: coachOffline } = useCoach();
  const coachQuota = overview?.quota;
  const percent = (coachQuota?.remainingRatio ?? 0) * 100;
  const coachLeft =
    percent > 0 && percent < 1 ? "1%未満" : `${Math.floor(percent)}%`;
  const { entitlement, checked, offline: accessOffline } = useEntitlements();
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
    <View style={s.card}>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Text style={font(900, 16)}>
          {!checked
            ? "権利を確認しています…"
            : accessOffline
              ? "今の権利を確認できません"
              : q
                ? q.paid
                  ? "有料プラン"
                  : "無料プラン"
                : "解析の残り回数"}
        </Text>
        {q?.paid && <Text style={s.using}>利用中</Text>}
      </View>
      {entitlement.paid && (
        <Text style={[font(500, 11, 1.5, colors.ink2), { marginTop: 6 }]}>
          {entitlement.expiresAt === null
            ? "期限なし"
            : `期限：${new Date(entitlement.expiresAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}（日本時間）`}
        </Text>
      )}
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
        <Text style={[font(500, 12, 1.5, colors.ink2), { marginVertical: 10 }]}>
          {problem || "回数を確認しています…"}
        </Text>
      )}
      {offline && (
        <Text style={[font(700, 11, 1.5, colors.ink2), { marginTop: 8 }]}>
          通信できません。残り回数は最後に確認したものです。
        </Text>
      )}
      {COACH_ENABLED && entitlement.paid && (
        <View style={{ gap: 5, marginTop: 12 }}>
          <View
            style={{ flexDirection: "row", justifyContent: "space-between" }}
          >
            <Text style={font(700, 11)}>AIコーチ（今週）</Text>
            {coachQuota && <Text style={font(900, 11)}>残り {coachLeft}</Text>}
          </View>
          {coachQuota && (
            <View
              accessibilityRole="progressbar"
              accessibilityLabel="AIコーチの今週の残り"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.floor(percent)}
              aria-valuetext={`残り ${coachLeft}`}
              style={s.meter}
            >
              <View
                style={{
                  width: `${percent}%`,
                  height: "100%",
                  backgroundColor: colors.mint,
                }}
              />
            </View>
          )}
          <Text style={font(500, 10.5, 1.4, colors.ink2)}>
            {coachQuota
              ? "月曜0時（日本時間）に全回復します"
              : coachOffline
                ? "残りを確認できません"
                : "残りを確認しています…"}
          </Text>
          {coachQuota && coachOffline && (
            <Text style={font(700, 11, 1.5, colors.ink2)}>
              AIコーチの残りは最後に確認した値です。
            </Text>
          )}
        </View>
      )}
      <Button
        size="sm"
        wide
        style={{ marginTop: 12 }}
        onPress={() => router.push("/plan")}
      >
        {q?.paid ? "プランの内容を見る" : "有料プランを見る"}
      </Button>
    </View>
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
