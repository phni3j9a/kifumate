import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { Color } from "tsshogi";
import { useAnalysis } from "../analysis/provider";
import { cp, percent, type CandidateRow } from "../analysis/display";
import {
  needsRetryConfirmation,
  type Analysis,
  type Mode,
  type Score,
} from "../analysis/types";
import { Icon } from "./icons";
import { ask, toast } from "./overlay";
import { colors, font, line, radius, shadow } from "./theme";
import { Button } from "./ui";
export function ChancePie({
  score,
  self,
  u = 0,
}: {
  score: Score | null;
  self: Color;
  u?: number;
}) {
  const value = cp(score);
  if (value === null) return null;
  const pct = percent((self === Color.BLACK ? 1 : -1) * value),
    size = 43 + u * 0.7,
    center = size / 2,
    r = center - 1;
  const angle = (pct / 100) * 2 * Math.PI,
    x = center + r * Math.sin(angle),
    y = center - r * Math.cos(angle);
  const wedge = `M${center} ${center}L${center} ${center - r}A${r} ${r} 0 ${pct > 50 ? 1 : 0} 1 ${x} ${y}Z`;
  return (
    <View
      accessibilityLabel={`勝率 ${pct}%`}
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        gap: 2,
      }}
    >
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={center} cy={center} r={r} fill={colors.opp} />
        <Path d={wedge} fill={colors.you} />
        <Circle
          cx={center}
          cy={center}
          r={r}
          stroke={colors.ink}
          strokeWidth={2}
          fill="none"
        />
      </Svg>
      <Text style={font(900, 14)}>{pct}%</Text>
      <Text style={font(700, 9.5, 1, colors.ink2)}>勝率</Text>
    </View>
  );
}
export function AnalysisPanel({
  analysis,
  branch,
  branchRow,
  rows,
  selected,
  onSelect,
  onTry,
  self,
  u,
  start,
  ending,
}: {
  analysis?: Analysis;
  branch: boolean;
  branchRow?: CandidateRow;
  rows: CandidateRow[];
  selected: number;
  onSelect: (i: number) => void;
  onTry: (row: CandidateRow) => void;
  self: Color;
  u: number;
  start: (mode: Mode) => void;
  ending?: string;
}) {
  const { quota, offline, controller } = useAnalysis();
  const [mode, setMode] = useState<Mode>("precise");
  const t = analysis?.attempt,
    job = t?.job,
    saved = analysis?.saved;
  const confirmation = needsRetryConfirmation(t);
  const waiting = !!t && job?.status === "queued";
  const running = !!t && !waiting && !confirmation;
  const kind = quota?.paid ? mode : "std";
  const row = branch ? branchRow : rows[selected] || rows[0];
  const tab = (
    label: string,
    onPress?: () => void,
    on = true,
    locked = false,
  ) => (
    <Pressable
      key={label}
      accessibilityRole={onPress ? "button" : undefined}
      onPress={onPress}
      style={[
        s.tab,
        {
          height: (on ? 27 : 24) + u * 0.25,
          backgroundColor: locked
            ? "transparent"
            : on
              ? colors.white
              : colors.sand,
          borderBottomColor: on ? colors.white : colors.ink,
          ...(locked
            ? {
                borderStyle: "dashed" as const,
                borderWidth: line.thin,
                borderColor: colors.dash,
              }
            : {}),
        },
      ]}
    >
      {locked && <Icon name="lock" size={10} />}
      <Text
        style={font(locked ? 700 : 900, 11, 1, on ? colors.ink : colors.ink2)}
      >
        {label}
      </Text>
    </Pressable>
  );
  const preciseInfo = () =>
    ask({
      title: "精密解析は、有料プランで使えます",
      text: "候補を3手まで出し、より深く読みます。週20局まで使えます。課金は準備中です。",
      ok: "閉じる",
      single: true,
    });
  async function cancel() {
    const previous = analysis?.saved?.jobId;
    try {
      await controller.cancel(analysis!.gameId);
      const latest = controller.snapshot.records[analysis!.gameId];
      toast(
        latest?.attempt
          ? "中止を依頼しました。通信が戻ると中止します"
          : latest?.saved?.jobId !== previous
            ? "解析はすでに終わっています"
            : waiting
              ? "解析待ちをやめました"
              : "解析を中止しました",
      );
    } catch {
      toast("中止を保存できませんでした。もう一度お試しください");
    }
  }
  let title = "",
    sub = "",
    action: React.ReactNode = null;
  if (branch) {
    title = row?.text || "自由に指して試せます";
    sub = row ? "保存した読み筋" : "分岐は保存されません。本譜は変わりません";
  } else if (confirmation) {
    title = "前回の依頼の結果が分かりません";
    sub = "もう一度解析するには確認が必要です";
    action = (
      <Button size="sm" onPress={() => start(t!.mode)}>
        依頼を確認
      </Button>
    );
  } else if (waiting) {
    title = "解析待ち";
    sub = "いまの解析が終わると、続けて始まります";
    action = (
      <Button size="sm" onPress={() => void cancel()}>
        やめる
      </Button>
    );
  } else if (running) {
    title = offline ? "中断中" : "解析中";
    sub = offline
      ? "通信が戻ると、続きから再開します"
      : `${Math.max(0, (job?.next || 0) - 1)} / ${t.moves.length}手`;
    action = (
      <Button
        size="sm"
        onPress={() =>
          ask({
            title: "解析を中止しますか",
            text: "ここまでの結果は残りません。中止した解析は、回数に数えません。",
            ok: "中止する",
            no: "続ける",
            onOk: () => void cancel(),
          })
        }
      >
        中止
      </Button>
    );
  } else if (saved && row) {
    title = row.text;
    sub = "";
  } else if (saved) {
    title = ending || "読み筋はここまで";
    sub = ending ? "終局" : "この局面の候補手はありません";
  } else if (
    analysis?.error &&
    !(
      quota &&
      (quota.totalRemaining === 0 ||
        (quota.paid && kind === "precise" && quota.preciseRemaining === 0))
    )
  ) {
    title = "解析を終えられませんでした";
    sub = analysis.error.replace(/^解析を終えられませんでした。?/, "");
    action = (
      <Button kind="pri" size="sm" onPress={() => start(kind)}>
        もう一度
      </Button>
    );
  } else if (quota && quota.totalRemaining === 0) {
    title = "今週の解析は残り0局";
    sub = `月曜の午前0時に、また${quota.paid ? 100 : 10}局使えます`;
    if (!quota.paid)
      action = (
        <Button size="sm" kind="pri" onPress={preciseInfo}>
          プランを見る
        </Button>
      );
  } else if (
    quota?.paid &&
    kind === "precise" &&
    quota.preciseRemaining === 0
  ) {
    title = "今週の精密解析は残り0局";
    sub = "ふつうの解析（候補1手）は使えます";
    action = (
      <Button kind="pri" size="sm" onPress={() => start("std")}>
        ふつうで解析
      </Button>
    );
  } else {
    title = "この対局を解析する";
    sub = offline
      ? "通信できません。つながると解析できます"
      : !quota
        ? "解析の残り回数を確認します"
        : !quota.paid
          ? `今週の解析　あと${quota.totalRemaining}局`
          : kind === "precise"
            ? `候補3手　今週あと${Math.min(quota.totalRemaining, quota.preciseRemaining)}局`
            : `候補1手　今週あと${quota.totalRemaining}局`;
    action = (
      <Button kind="pri" size="sm" onPress={() => start(kind)}>
        解析する
      </Button>
    );
  }
  return (
    <View style={{ marginHorizontal: 12 }}>
      <View style={[s.tabs, { minHeight: 29 + u * 0.25 }]}>
        {branch ? (
          tab(row ? "おすすめ" : "分岐")
        ) : t ? (
          <>
            {tab(t.mode === "precise" ? "精密解析" : "解析")}
            {waiting && !quota?.paid && tab("精密", preciseInfo, false, true)}
          </>
        ) : saved ? (
          rows.map((r, i) => tab(r.label, () => onSelect(i), i === selected))
        ) : quota?.paid ? (
          <>
            {tab("精密解析", () => setMode("precise"), kind === "precise")}
            {tab("ふつう", () => setMode("std"), kind === "std")}
          </>
        ) : (
          <>
            {tab("解析")}
            {tab("精密", preciseInfo, false, true)}
          </>
        )}
        {!branch &&
          !t &&
          saved?.mode === "std" &&
          tab(
            "2位・3位",
            () =>
              quota?.paid
                ? ask({
                    title: "精密解析でやり直しますか",
                    text: "精密解析を1局分使います。新しい解析に成功すると、いまの結果に置きかわります。",
                    ok: "精密解析する",
                    onOk: () => start("precise"),
                  })
                : preciseInfo(),
            false,
            true,
          )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="AIに聞く"
          onPress={() =>
            ask({
              title: "AIコーチは準備中です",
              text: "精密解析の結果は保存され、あとから読み返せます。",
              ok: "閉じる",
              single: true,
            })
          }
          style={{
            marginLeft: "auto",
            height: 25,
            marginBottom: 4,
            flexDirection: "row",
            alignItems: "center",
            gap: 3,
            paddingHorizontal: 8,
            borderWidth: line.ol,
            borderColor: colors.ink,
            borderRadius: radius.pill,
            backgroundColor: quota?.paid ? colors.mint : colors.white,
            boxShadow: shadow.small,
          }}
        >
          <Icon name="spark" size={12} />
          <Text style={font(900, 10)}>AIに聞く</Text>
          <Icon name="lock" size={10} />
        </Pressable>
      </View>
      <View
        style={[
          s.card,
          {
            minHeight: 54 + u * 1.4,
            paddingTop: 3 + u * 0.2,
            paddingBottom: 5 + u * 0.2,
          },
        ]}
      >
        <View
          style={{
            flex: 1,
            alignSelf: "stretch",
            justifyContent: "space-around",
            minWidth: 0,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <Text
              numberOfLines={1}
              style={[
                font(
                  900,
                  row && (!t || branch) ? 21 + u * 0.25 : 15.5 + u * 0.15,
                  1.25,
                ),
                { flexShrink: 1 },
              ]}
            >
              {title}
            </Text>
            {running && (
              <Text
                style={font(700, offline ? 9 : 10, 1.3, colors.ink2)}
                numberOfLines={1}
              >
                {sub}
              </Text>
            )}
            {(!t || branch) && row?.mate && (
              <Text style={s.mate}>{row.mate}手詰め</Text>
            )}
            {(!t || branch) && row?.game && row.label !== "本譜" && (
              <Text style={font(700, 9.5, 1.4, colors.ink2)}>本譜</Text>
            )}
          </View>
          {row && (!t || branch) ? (
            <View
              style={{ flexDirection: "row", gap: 5, alignItems: "center" }}
            >
              <Text
                numberOfLines={1}
                style={[
                  font(500, 11.5 + u * 0.06, 1.45, colors.ink2),
                  { flex: 1 },
                ]}
              >
                {(row.reading || row.pv).slice(1).join(" ") || "　"}
              </Text>
              {row.move && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    row.game ? "本譜を1手進める" : "この手を盤で試す"
                  }
                  onPress={() => onTry(row)}
                  style={s.try}
                >
                  <Icon name="play" size={10} />
                  <Text style={font(900, 9.5)}>
                    {row.game ? "次の手" : "試す"}
                  </Text>
                </Pressable>
              )}
            </View>
          ) : running ? null : (
            <Text
              numberOfLines={running && offline ? 2 : 1}
              style={font(500, 11.5 + u * 0.06, 1.45, colors.ink2)}
            >
              {sub}
            </Text>
          )}
          {running && (
            <View style={[s.progress, { backgroundColor: colors.white }]}>
              <View
                style={{
                  width: `${(100 * (job?.next || 0)) / Math.max(1, t.moves.length + 1)}%`,
                  height: "100%",
                  backgroundColor: offline ? colors.orange : colors.mint,
                }}
              />
            </View>
          )}
        </View>
        {row && (!t || branch) ? (
          <ChancePie score={row.score} self={self} u={u} />
        ) : (
          action
        )}
      </View>
    </View>
  );
}
const s = StyleSheet.create({
  tabs: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 4,
    paddingLeft: 16,
    paddingRight: 1,
    marginBottom: -2,
    zIndex: 1,
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    paddingHorizontal: 10,
    borderWidth: line.ol,
    borderColor: colors.ink,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingLeft: 12,
    paddingRight: 9,
    backgroundColor: colors.white,
    borderWidth: line.ol,
    borderColor: colors.ink,
    borderRadius: radius.card,
    boxShadow: shadow.card,
  },
  try: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderWidth: line.thin,
    borderColor: colors.ink,
    borderRadius: radius.pill,
    backgroundColor: colors.sand,
  },
  progress: {
    height: 8,
    borderRadius: 99,
    overflow: "hidden",
    marginVertical: 2,
    borderWidth: 1.5,
    borderColor: colors.ink,
  },
  mate: {
    ...font(900, 9, 1.4),
    paddingHorizontal: 5,
    borderRadius: 99,
    backgroundColor: colors.mintSoft,
    borderWidth: 1,
    borderColor: colors.ink,
  },
});
