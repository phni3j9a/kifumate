import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import Svg, { Circle, Line, Path, Text as SvgText } from "react-native-svg";
import {
  AppBar,
  Button,
  Card,
  EmptyState,
  EmptyNote,
  Hint,
  PageScroll,
  Problem,
  RoundButton,
  Screen,
  SectionTitle,
  Segmented,
  TextButton,
} from "../../components/ui";
import { Sheet } from "../../components/overlay";
import { Icon } from "../../components/icons";
import { colors, font, line } from "../../components/theme";
import {
  TagFilterGroups,
  dimensionLabels,
} from "../../components/classification-tags";
import { useClassifications } from "../../components/classifications-provider";
import {
  matchesGame,
  statRows,
  tally,
  winLoss,
  type Dimension,
  type GameFilter,
} from "../../core/stats";
import { dateParts, dateShort } from "../../core/format";
import { listGameSummaries, type Game } from "../../storage/repository";

function Bar({ rate }: { rate: number }) {
  return (
    <View style={s.bar}>
      {rate > 0 && (
        <View
          style={{
            height: "100%",
            width: `${rate}%`,
            backgroundColor: colors.you,
            borderRightWidth: rate < 100 ? line.thin : 0,
            borderColor: colors.ink,
          }}
        />
      )}
    </View>
  );
}
function Donut({ rate }: { rate: number }) {
  return (
    <View style={{ width: 78, height: 78 }}>
      <Svg width={78} height={78} viewBox="0 0 78 78">
        <Circle
          cx={39}
          cy={39}
          r={38}
          fill={colors.opp}
          stroke={colors.ink}
          strokeWidth={2}
        />
        <Circle
          cx={39}
          cy={39}
          r={31}
          fill="none"
          stroke={colors.you}
          strokeWidth={12}
          strokeDasharray={`${(rate * (Math.PI * 62)) / 100} ${Math.PI * 62}`}
          transform="rotate(-90 39 39)"
        />
        <Circle
          cx={39}
          cy={39}
          r={24}
          fill={colors.white}
          stroke={colors.ink}
          strokeWidth={2}
        />
      </Svg>
      <View style={s.donutLabel}>
        <Text style={font(900, 15, 1.15)}>{rate}%</Text>
        <Text style={font(700, 10, 1.2, colors.ink2)}>勝率</Text>
      </View>
    </View>
  );
}
function Trend({ games }: { games: Game[] }) {
  const [point, setPoint] = useState<number | null>(null);
  const [width, setWidth] = useState(320);
  const points = games.slice(4).map((g, i) => ({
    game: g,
    games: games.slice(Math.max(0, i - 5), i + 5),
    rate: tally(games.slice(Math.max(0, i - 5), i + 5)).r,
  }));
  if (points.length < 2)
    return <EmptyNote>5局以上になると表示されます。</EmptyNote>;
  const X = (i: number) => 30 + (254 * i) / (points.length - 1),
    Y = (r: number) => 10 + (80 * (100 - r)) / 100;
  const d = points
    .map((p, i) => `${i ? "L" : "M"}${X(i)} ${Y(p.rate)}`)
    .join("");
  const last = points.at(-1)!;
  const label = (g: Game) => {
    const p = dateParts(g.played_at);
    return p ? `${p.m}/${p.d}` : "日付なし";
  };
  const selected = point === null ? null : points[point];
  const select = (x: number) =>
    setPoint(
      Math.max(
        0,
        Math.min(
          points.length - 1,
          Math.round((((x / width) * 320 - 30) / 254) * (points.length - 1)),
        ),
      ),
    );
  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => true}
      onResponderGrant={(e) => select(e.nativeEvent.locationX)}
      onResponderMove={(e) => select(e.nativeEvent.locationX)}
      onResponderRelease={() => setPoint(null)}
    >
      <Svg
        width="100%"
        viewBox="0 0 320 108"
        accessibilityLabel={`直近10局の勝率の推移。最新は${last.rate}%`}
      >
        {[0, 50, 100].map((r) => (
          <Line
            key={`l${r}`}
            x1={30}
            x2={284}
            y1={Y(r)}
            y2={Y(r)}
            stroke={colors.ink}
            opacity={r === 50 ? 0.4 : 0.12}
            strokeDasharray={r === 50 ? "3 3" : undefined}
          />
        ))}
        {[0, 50, 100].map((r) => (
          <SvgText
            key={r}
            x={25}
            y={Y(r) + 3}
            textAnchor="end"
            fill={colors.ink2}
            fontFamily={font(700, 9.5).fontFamily}
            fontSize={9.5}
          >
            {r}%
          </SvgText>
        ))}
        <Path d={`${d}L284 90L30 90Z`} fill={colors.trend} opacity={0.55} />
        <Path d={d} fill="none" stroke={colors.ink} strokeWidth={2} />
        {points.map((p, i) => (
          <Circle
            key={i}
            cx={X(i)}
            cy={Y(p.rate)}
            r={i === points.length - 1 ? 4.5 : 2.3}
            fill={i === points.length - 1 ? colors.you : colors.white}
            stroke={colors.ink}
            strokeWidth={i === points.length - 1 ? 2 : 1.5}
          />
        ))}
        <SvgText
          x={292}
          y={Y(last.rate) + 3}
          fontFamily={font(900, 11).fontFamily}
          fontSize={11}
          fill={colors.ink}
        >
          {last.rate}%
        </SvgText>
        <SvgText
          x={30}
          y={104}
          fontFamily={font(700, 9.5).fontFamily}
          fontSize={9.5}
          fill={colors.ink2}
        >
          {label(points[0]!.game)}
        </SvgText>
        <SvgText
          x={284}
          y={104}
          textAnchor="end"
          fontFamily={font(700, 9.5).fontFamily}
          fontSize={9.5}
          fill={colors.ink2}
        >
          {label(last.game)}
        </SvgText>
      </Svg>
      {selected && (
        <Text style={s.tooltip}>
          {selected.rate}%　{label(selected.game)} までの{selected.games.length}
          局
        </Text>
      )}
    </View>
  );
}
export default function Stats() {
  const db = useSQLiteContext();
  const { revision, pending } = useClassifications();
  const [games, setGames] = useState<Game[] | null>(null),
    [error, setError] = useState("");
  const [filter, setFilter] = useState<GameFilter>({}),
    [dimension, setDimension] = useState<Dimension>("myst"),
    [sheet, setSheet] = useState(false);
  const [now, setNow] = useState(0);
  const load = useCallback(async () => {
    try {
      setGames(await listGameSummaries(db));
      setNow(Date.now());
      setError("");
    } catch {
      setError("戦績を読めませんでした。もう一度お試しください。");
    }
  }, [db]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  useEffect(() => {
    if (!revision) return;
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load, revision]);
  if (error)
    return (
      <Screen>
        <AppBar title="戦績" />
        <Problem text={error}>
          <Button onPress={() => void load()}>もう一度</Button>
        </Problem>
      </Screen>
    );
  if (!games)
    return (
      <Screen>
        <AppBar title="戦績" />
      </Screen>
    );
  if (!games.some((g) => g.self_side))
    return (
      <Screen>
        <AppBar title="戦績" />
        <EmptyState
          image="sys-empty"
          title="まだ集計できる対局がありません"
          detail="自分の対局を取り込むと、勝率や、戦法・囲いごとの成績がここに出ます。"
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
  const visible = games.filter(
      (g) => g.self_side && matchesGame(g, filter, now),
    ),
    t = tally(visible);
  const chron = [...visible].sort(
    (a, b) =>
      (dateParts(a.played_at)?.time ?? 0) - (dateParts(b.played_at)?.time ?? 0),
  );
  const open = (extra: Record<string, string> = {}) =>
    router.push({
      pathname: "/records",
      params: { ...filter, title: "対局の一覧", ...extra },
    });
  const rows = statRows(visible, dimension);
  return (
    <Screen>
      <AppBar title="戦績" note={t.n ? `自分の対局 ${t.n}局` : undefined}>
        <RoundButton
          icon="filter"
          label="戦績の絞り込み"
          onPress={() => setSheet(true)}
        />
      </AppBar>
      <PageScroll>
        <View style={s.filters}>
          <View style={{ flex: 1 }}>
            <Segmented
              small
              label="戦績の期間"
              options={[
                ["", "全期間"],
                ["90", "90日"],
                ["30", "30日"],
              ]}
              value={filter.period ?? ""}
              onChange={(period) => setFilter({ ...filter, period })}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Segmented
              small
              label="戦績の先後"
              options={[
                ["", "両方"],
                ["black", "先手"],
                ["white", "後手"],
              ]}
              value={filter.side ?? ""}
              onChange={(side) => setFilter({ ...filter, side })}
            />
          </View>
        </View>
        {pending && (
          <Hint>戦法と囲いを判定しています。終わった対局から反映します。</Hint>
        )}
        {!t.n ? (
          <>
            <EmptyNote>この条件の対局はありません。</EmptyNote>
            {(filter.myst || filter.mycs || filter.opst) && (
              <TextButton onPress={() => setFilter({})}>
                条件をすべて外す
              </TextButton>
            )}
          </>
        ) : (
          <>
            <Card style={s.summary}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`勝率${t.r}%の対局を表示`}
                onPress={() =>
                  open({ result: "decided", title: "勝敗が決まった対局" })
                }
              >
                <Donut rate={t.r} />
              </Pressable>
              <View style={{ flex: 1, gap: 4 }}>
                <View style={s.bigRow}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${t.w}勝の対局を表示`}
                    onPress={() => open({ result: "win", title: "勝った対局" })}
                  >
                    <Text style={font(900, 24, 1.1)}>{t.w}勝</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${t.l}敗の対局を表示`}
                    onPress={() =>
                      open({ result: "loss", title: "負けた対局" })
                    }
                  >
                    <Text style={font(900, 24, 1.1)}>{t.l}敗</Text>
                  </Pressable>
                  {t.d > 0 && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="引き分けの対局を表示"
                      onPress={() =>
                        open({ result: "draw", title: "引き分けの対局" })
                      }
                    >
                      <Text style={font(900, 24, 1.1)}>{t.d}分</Text>
                    </Pressable>
                  )}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${t.n}局を表示`}
                    onPress={() => open()}
                  >
                    <Text style={font(700, 12.5, 1.2, colors.ink2)}>
                      {t.n}局
                    </Text>
                  </Pressable>
                </View>
                {(["black", "white"] as const).map((side) => {
                  const half = tally(
                    visible.filter((g) => g.self_side === side),
                  );
                  return (
                    <Pressable
                      key={side}
                      accessibilityRole="button"
                      accessibilityLabel={`${side === "black" ? "先手" : "後手"}の対局を表示`}
                      onPress={() =>
                        open({
                          side,
                          title: side === "black" ? "先手の対局" : "後手の対局",
                        })
                      }
                      style={s.half}
                    >
                      <Text style={font(700, 10.5, 1.2)}>
                        {side === "black" ? "☗先手" : "☖後手"}
                      </Text>
                      <View style={{ flex: 1 }}>
                        <Bar rate={half.r} />
                      </View>
                      <Text style={font(700, 10.5, 1.2)}>{winLoss(half)}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </Card>
            <SectionTitle>最近の勝敗（左が古い対局）</SectionTitle>
            <Card style={s.history}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 3 }}>
                {chron.slice(-20).map((g) => (
                  <Pressable
                    key={g.id}
                    accessibilityRole="button"
                    accessibilityLabel={`${dateShort(g.played_at)} ${g.black} 対 ${g.white}を開く`}
                    onPress={() => router.push(`/game/${g.id}`)}
                    hitSlop={{ top: 8, bottom: 8 }}
                    style={[
                      s.dot,
                      {
                        backgroundColor:
                          g.result === "win"
                            ? colors.you
                            : g.result === "loss"
                              ? colors.opp
                              : g.result === "draw"
                                ? colors.white
                                : "transparent",
                        borderStyle:
                          g.result === "unknown" ? "dashed" : "solid",
                      },
                    ]}
                  />
                ))}
              </View>
              <View style={s.legend}>
                {[
                  ["win", "勝ち"],
                  ["loss", "負け"],
                  ...(t.d ? [["draw", "引き分け"]] : []),
                  ...(t.u ? [["unknown", "結果不明"]] : []),
                ].map(([r, l]) => (
                  <Pressable
                    key={r}
                    accessibilityRole="button"
                    onPress={() => open({ result: r!, title: l! })}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    <View
                      style={[
                        s.dot,
                        {
                          width: 10,
                          height: 10,
                          backgroundColor:
                            r === "win"
                              ? colors.you
                              : r === "loss"
                                ? colors.opp
                                : "transparent",
                          borderStyle: r === "unknown" ? "dashed" : "solid",
                        },
                      ]}
                    />
                    <Text style={font(700, 11, 1, colors.ink2)}>{l}</Text>
                  </Pressable>
                ))}
              </View>
            </Card>
            {(t.d > 0 || t.u > 0) && (
              <Hint>
                引き分けと、結果がわからない対局は、勝率に数えていません。
              </Hint>
            )}
            <SectionTitle>勝率の移り変わり（直近10局ごと）</SectionTitle>
            <Card
              style={{ paddingTop: 8, paddingHorizontal: 8, paddingBottom: 4 }}
            >
              <Trend games={chron} />
            </Card>
            <SectionTitle>戦法・囲いごとの成績</SectionTitle>
            <Segmented
              label="戦績の内訳"
              options={Object.entries(dimensionLabels) as [Dimension, string][]}
              value={dimension}
              onChange={setDimension}
            />
            <Card style={s.rows}>
              {rows.map((row, i) => (
                <Pressable
                  key={`${row.id}-${i}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${row.name} ${row.total.n}局 ${winLoss(row.total)} ${row.total.r}%の対局を表示`}
                  onPress={() =>
                    open({
                      dim: dimension,
                      value: row.id,
                      family: row.family ?? "",
                      title: row.name,
                    })
                  }
                  style={[
                    s.row,
                    i > 0 && { borderTopWidth: 1, borderColor: colors.hair },
                  ]}
                >
                  <View style={s.rowTop}>
                    <Text
                      numberOfLines={1}
                      style={[
                        font(
                          row.depth ? 700 : 900,
                          row.depth ? 12.5 : 13.5,
                          1.3,
                          row.id === "未分類" ? colors.ink2 : colors.ink,
                        ),
                        { flex: 1, paddingLeft: row.depth * 16 },
                      ]}
                    >
                      {row.depth ? "└ " : ""}
                      {row.name}
                    </Text>
                    <Text style={font(700, 11, 1, colors.ink2)}>
                      {row.total.n}局 {winLoss(row.total)}
                    </Text>
                    <Text
                      style={[
                        font(900, 13.5, 1.2),
                        { minWidth: 36, textAlign: "right" },
                      ]}
                    >
                      {row.total.r}%
                    </Text>
                    <Icon
                      name="next"
                      size={13}
                      color={colors.ink2}
                      strokeWidth={2.4}
                    />
                  </View>
                  <Bar rate={row.total.r} />
                </Pressable>
              ))}
            </Card>
            <Hint>
              行をタップすると、その対局の一覧が開きます。複数の戦法や囲いに当てはまる対局は、それぞれの行に数えます（合計の対局数は重複しません）。
            </Hint>
            <Hint>
              戦法や囲いの判定がちがうときは、対局を開いて「…」→「対局情報」から直せます。
            </Hint>
          </>
        )}
      </PageScroll>
      <Sheet
        auto
        visible={sheet}
        title="戦績の絞り込み"
        onClose={() => setSheet(false)}
        footer={
          <>
            <Button
              kind="pri"
              wide
              onPress={() => setSheet(false)}
            >{`${visible.length}局を表示`}</Button>
            <TextButton onPress={() => setFilter({})}>
              条件をすべて外す
            </TextButton>
          </>
        }
      >
        <TagFilterGroups games={games} filter={filter} onChange={setFilter} />
      </Sheet>
    </Screen>
  );
}
const s = StyleSheet.create({
  filters: { flexDirection: "row", gap: 8, marginBottom: 10 },
  summary: {
    flexDirection: "row",
    gap: 14,
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  donutLabel: {
    position: "absolute",
    inset: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
  },
  bigRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: 5,
    rowGap: 3,
  },
  half: { flexDirection: "row", alignItems: "center", gap: 7 },
  bar: {
    height: 9,
    borderWidth: line.thin,
    borderColor: colors.ink,
    borderRadius: 99,
    backgroundColor: colors.opp,
    overflow: "hidden",
  },
  history: { gap: 7, paddingTop: 10, paddingHorizontal: 12, paddingBottom: 11 },
  dot: {
    width: 12,
    height: 12,
    borderWidth: line.thin,
    borderColor: colors.ink,
    borderRadius: 6,
  },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  rows: {
    paddingTop: 2,
    paddingHorizontal: 12,
    paddingBottom: 4,
    marginTop: 10,
  },
  row: { gap: 4, paddingVertical: 9 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  tooltip: {
    ...font(700, 11, 1.4),
    position: "absolute",
    top: 6,
    alignSelf: "center",
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.ink,
    padding: 4,
    borderRadius: 6,
  },
});
