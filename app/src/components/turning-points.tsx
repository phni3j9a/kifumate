import { router } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { TurningPoint } from "../analysis/display";
import { GraphMarkIcon } from "./graph-mark";
import { Icon } from "./icons";
import { ask, Sheet } from "./overlay";
import { colors, font, line, radius } from "./theme";
import { EmptyNote } from "./ui";

// モックの「勝負所」（game.js の turnsHTML、app.css の .tp*）と同じ形。
function deepInfo() {
  ask({
    title: "深読みは、有料プランで使えます",
    text: "精密解析（有料プラン）では、形勢が大きく動いた局面を5秒ずつ深く読み直し、おすすめの手・評価値・読み筋をこの一覧に出します。週20局まで使えます。",
    ok: "有料プランを見る",
    no: "閉じる",
    onOk: () => router.push("/plan"),
  });
}

/** 盤の左下の入口（.brl）。解析済みのときだけ件数を出す */
export function TurningPointsButton({
  count,
  onPress,
}: {
  count: number | null;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`勝負所の一覧${count === null ? "" : `、${count}手`}`}
      hitSlop={{ top: 9, bottom: 9, left: 4, right: 4 }}
      onPress={onPress}
      style={s.pill}
    >
      <Icon name="flag" size={12} strokeWidth={2.2} />
      <Text style={font(700, 11, 1.2, colors.ink2)}>
        勝負所
        {count !== null && <Text style={font(900, 11, 1.2)}> {count}</Text>}
      </Text>
    </Pressable>
  );
}

export function TurningPointsSheet({
  onClose,
  state,
  list,
  ply,
  own,
  you,
  opponent,
  upgrade,
  onRedo,
  onJump,
}: {
  onClose: () => void;
  /** none：未解析、running：解析中・解析待ち、partial：復元した途中結果、done：解析済み */
  state: "none" | "running" | "partial" | "done";
  list: TurningPoint[];
  ply: number;
  own: boolean;
  you: string;
  opponent: string;
  /** 深読みのない解析に出す案内。plan は有料プランの案内、redo は精密解析でのやり直し */
  upgrade: "plan" | "redo" | null;
  onRedo: () => void;
  onJump: (ply: number) => void;
}) {
  const [row, setRow] = useState<{ y: number; height: number } | null>(null);
  const done = state === "done";
  const note = `${upgrade === "redo" ? "精密解析" : "有料プラン"}では、勝負所を5秒ずつ深く読みます`;
  return (
    <Sheet
      visible
      title={done ? `勝負所（${list.length}手）` : "勝負所"}
      onClose={onClose}
      scrollRow={row}
    >
      {!done ? (
        <EmptyNote>
          {state === "running"
            ? "解析が終わると、印の付いた手がここに並びます。"
            : state === "partial"
              ? "途中までの結果だけを復元しています。\n解析し直すと、印の付いた手がここに並びます。"
              : "解析すると、悪手・疑問手・好手など\n印の付いた手がここに並びます。"}
        </EmptyNote>
      ) : !list.length ? (
        <EmptyNote>
          {
            "印の付いた手はありませんでした。\n印は、31手目以降で形勢が大きく動いた手に付きます。"
          }
        </EmptyNote>
      ) : (
        <>
          {upgrade && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={note}
              accessibilityHint={
                upgrade === "redo"
                  ? "精密解析でやり直すか確認します"
                  : "有料プランの案内を開きます"
              }
              onPress={() => {
                // ダイアログは別ウィンドウなので、シートを閉じてから出す（削除の確認と同じ）
                onClose();
                if (upgrade === "redo") onRedo();
                else deepInfo();
              }}
              style={s.note}
            >
              <Icon
                name={upgrade === "redo" ? "refresh" : "lock"}
                size={13}
                strokeWidth={2.2}
                color={colors.ink2}
              />
              <Text style={[font(700, 11.5, 1.4, colors.ink2), { flex: 1 }]}>
                {note}
              </Text>
              <Icon
                name="next"
                size={13}
                strokeWidth={2.2}
                color={colors.ink2}
              />
            </Pressable>
          )}
          <Text style={s.caption}>{you}の勝率</Text>
          {list.map((t) => {
            const best = t.best
              ? `${own && t.self ? "おすすめは" : "最善は"} ${t.best}`
              : "";
            const hint = t.deep
              ? best || "最善の手"
              : t.mate
                ? `${t.mate}手詰めあり`
                : best;
            const reading = t.deep?.reading.join(" ");
            return (
              <Pressable
                key={t.ply}
                accessibilityRole="button"
                accessibilityLabel={[
                  `${t.ply}手目 ${t.text}`,
                  `${t.self ? you : opponent}の手`,
                  t.mark,
                  `${you}の勝率 ${t.before}%から${t.after}%`,
                  t.deep ? `深読み ${hint}` : hint,
                  t.deep && `評価値 ${t.deep.score}`,
                  reading && `読み筋 ${reading}`,
                ]
                  .filter(Boolean)
                  .join("、")}
                aria-selected={t.ply === ply}
                onLayout={
                  t.ply === ply
                    ? (e) => setRow(e.nativeEvent.layout)
                    : undefined
                }
                onPress={() => onJump(t.ply)}
                style={[
                  s.row,
                  t.ply === ply && { backgroundColor: colors.you },
                ]}
              >
                <View style={s.top}>
                  <View style={s.no}>
                    <View
                      style={[
                        s.dot,
                        { backgroundColor: t.self ? colors.you : colors.opp },
                      ]}
                    />
                    <Text
                      style={[
                        font(700, 11, 1.2, colors.ink2),
                        { fontVariant: ["tabular-nums"] },
                      ]}
                    >
                      {t.ply}
                    </Text>
                  </View>
                  <Text
                    numberOfLines={1}
                    style={[font(700, 13.5, 1.2), { flexShrink: 1 }]}
                  >
                    {t.text}
                  </Text>
                  {t.mark && (
                    <View style={s.mark}>
                      <GraphMarkIcon kind={t.mark} size={16} />
                      <Text style={font(900, 10.5, 1.2)}>{t.mark}</Text>
                    </View>
                  )}
                  <Text style={s.rate}>
                    {t.before}% → {t.after}%
                  </Text>
                </View>
                {t.deep ? (
                  <View style={s.deep}>
                    <View style={s.top}>
                      <Text style={s.chip}>深読み</Text>
                      <Text
                        numberOfLines={1}
                        style={[font(900, 12.5, 1.4), { flexShrink: 1 }]}
                      >
                        {hint}
                      </Text>
                      <Text style={s.rate}>{t.deep.score}</Text>
                    </View>
                    {!!reading && (
                      <Text
                        numberOfLines={1}
                        style={font(500, 11.5, 1.45, colors.ink2)}
                      >
                        {reading}
                      </Text>
                    )}
                  </View>
                ) : hint ? (
                  <Text numberOfLines={1} style={s.hint}>
                    {hint}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
        </>
      )}
    </Sheet>
  );
}

const s = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    height: 19,
    marginRight: "auto",
    paddingLeft: 5,
    paddingRight: 7,
    borderWidth: line.thin,
    borderColor: colors.dash,
    borderRadius: radius.pill,
  },
  note: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 44,
    marginHorizontal: 2,
    marginBottom: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: line.thin,
    borderStyle: "dashed",
    borderColor: colors.dash,
    borderRadius: 12,
  },
  caption: {
    ...font(700, 10.5, 1.3, colors.ink2),
    textAlign: "right",
    paddingHorizontal: 10,
    paddingBottom: 2,
  },
  row: {
    minHeight: 44,
    justifyContent: "center",
    padding: 10,
    borderRadius: 10,
  },
  top: { flexDirection: "row", alignItems: "center", gap: 6 },
  no: { flexDirection: "row", alignItems: "center", gap: 4, width: 34 },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: line.thin,
    borderColor: colors.ink,
  },
  mark: { flexDirection: "row", alignItems: "center", gap: 3 },
  rate: {
    ...font(900, 12.5, 1.2),
    marginLeft: "auto",
    fontVariant: ["tabular-nums"],
  },
  hint: {
    ...font(500, 11.5, 1.45, colors.ink2),
    marginTop: 3,
    marginLeft: 40,
  },
  deep: {
    marginTop: 5,
    marginLeft: 40,
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderWidth: line.thin,
    borderColor: colors.ink,
    borderRadius: 10,
    backgroundColor: colors.white,
  },
  chip: {
    ...font(900, 9.5, 1.4),
    paddingHorizontal: 6,
    borderWidth: line.thin,
    borderColor: colors.ink,
    borderRadius: radius.pill,
    backgroundColor: colors.mintSoft,
  },
});
