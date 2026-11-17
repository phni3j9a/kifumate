import { router } from "expo-router";
import { Pressable, StyleSheet, Text } from "react-native";
import type { RealtimeState } from "../analysis/realtime-types";
import { Icon } from "./icons";
import { ask, toast } from "./overlay";
import { colors, font, line, radius } from "./theme";
export function realtimeInfo() {
  ask({
    title: "分岐中の解析は、有料プランで使えます",
    text: "分岐で指すたびに、その局面の評価値と最善手が出ます。",
    ok: "有料プランを見る",
    no: "閉じる",
    onOk: () => router.push("/plan"),
  });
}
export function realtimeLabel(state: RealtimeState) {
  if (state.paid === false) return "";
  if (!state.enabled) return "オフ";
  if (state.status === "offline") return "通信なし";
  if (state.status === "limit") return "残り0分";
  return `オン${state.quota?.low ? `・残り${Math.ceil(state.quota.remainingMs / 60000)}分` : ""}`;
}
export function RealtimeToggle({
  state,
  toggle,
}: {
  state: RealtimeState;
  toggle: () => void;
}) {
  const label = realtimeLabel(state);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`分岐中の解析 ${label || "有料プラン"}${state.status === "paused" ? "、休止中" : ""}`}
      hitSlop={{ top: 12, bottom: 12, left: 4, right: 4 }}
      onPress={() => {
        if (state.paid !== true) {
          realtimeInfo();
          return;
        }
        toggle();
        toast(
          state.enabled
            ? "分岐中の解析をオフにしました"
            : "分岐中の解析をオンにしました。次に指した手から評価値が出ます",
        );
      }}
      style={s.toggle}
    >
      <Icon name="bolt" size={12} strokeWidth={2.2} />
      <Text style={font(700, 11, 1.2, colors.ink2)}>
        分岐中の解析{label ? " " : ""}
        <Text style={font(900, 11, 1.2)}>{label}</Text>
      </Text>
      {state.paid !== true && <Icon name="lock" size={11} />}
    </Pressable>
  );
}
const s = StyleSheet.create({
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    height: 19,
    marginLeft: "auto",
    paddingLeft: 5,
    paddingRight: 7,
    borderWidth: line.thin,
    borderColor: colors.dash,
    borderRadius: radius.pill,
  },
});
