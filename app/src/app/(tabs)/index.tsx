import { useCallback, useState } from "react";
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import { Icon } from "../../components/icons";
import { KifHelpLink } from "../../components/kif-help";
import { Sheet, toast } from "../../components/overlay";
import { colors, font, line, radius, shadow } from "../../components/theme";
import {
  AppBar,
  Button,
  Chip,
  EmptyState,
  Problem,
  RoundButton,
  Screen,
  TextButton,
  Underlined,
} from "../../components/ui";
import { dateParts, dateShort } from "../../core/format";
import { listGames, toggleFavorite, type Game } from "../../storage/repository";

const quicks = [
  ["all", "すべて"],
  ["favorite", "お気に入り"],
  ["win", "勝ち"],
  ["loss", "負け"],
  ["none", "未解析"],
] as const;
type Quick = (typeof quicks)[number][0];
const noFilter = { scope: "", side: "", period: "" };
const groups = [
  [
    "scope",
    "対象",
    [
      ["", "すべて"],
      ["self", "自分の対局"],
      ["other", "自分以外"],
    ],
  ],
  [
    "side",
    "先手・後手",
    [
      ["", "すべて"],
      ["black", "☗先手"],
      ["white", "☖後手"],
    ],
  ],
  [
    "period",
    "期間",
    [
      ["", "すべて"],
      ["90", "90日"],
      ["30", "30日"],
    ],
  ],
] as const;
const stamps = {
  win: ["勝", "勝ち", colors.you],
  loss: ["負", "負け", colors.opp],
  draw: ["分", "引き分け", colors.white],
  unknown: ["？", "結果は不明", "transparent"],
} as const;
const emptyQuick: Record<Quick, string> = {
  all: "条件に合う棋譜がありません",
  favorite: "お気に入りの棋譜はまだありません",
  win: "勝った対局はまだありません",
  loss: "負けた対局はありません",
  none: "未解析の棋譜はありません",
};
const monthOf = (g: Game) => {
  const p = dateParts(g.played_at);
  return p ? `${p.y}年${p.m}月` : "日付なし";
};

export default function Games() {
  const db = useSQLiteContext();
  const [games, setGames] = useState<Game[] | null>(null),
    [error, setError] = useState("");
  const [query, setQuery] = useState(""),
    [searching, setSearching] = useState(false),
    [quick, setQuick] = useState<Quick>("all"),
    [filter, setFilter] = useState(noFilter),
    [sheet, setSheet] = useState(false),
    [today, setToday] = useState(0); // 期間の絞り込みの基準（読み込んだ時点）
  const load = useCallback(async () => {
    try {
      setGames(await listGames(db));
      setToday(Date.now());
      setError("");
    } catch {
      setError("一覧を読めませんでした。もう一度お試しください。");
    }
  }, [db]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  async function favorite(g: Game) {
    try {
      await toggleFavorite(db, g);
      await load();
    } catch {
      toast("お気に入りを保存できませんでした");
    }
  }
  function clear() {
    setFilter(noFilter);
    setQuery("");
    setSearching(false);
    setQuick("all");
  }
  if (error)
    return (
      <Screen>
        <AppBar title="棋譜" />
        <Problem text={error}>
          <Button onPress={() => void load()}>もう一度</Button>
        </Problem>
      </Screen>
    );
  if (!games)
    return (
      <Screen>
        <AppBar title="棋譜" />
      </Screen>
    );
  if (!games.length)
    return (
      <Screen>
        <AppBar title="棋譜" />
        <EmptyState
          image="sys-empty"
          title="まだ棋譜がありません"
          detail="指した将棋のKIFを取り込むと、ここに並びます。盤に並べて、振り返りを始めましょう。"
        >
          <Button
            kind="pri"
            icon="plus"
            style={{ marginTop: 10 }}
            onPress={() => router.push("/import")}
          >
            棋譜を取り込む
          </Button>
          <View style={{ marginTop: 2 }}>
            <KifHelpLink />
          </View>
        </EmptyState>
      </Screen>
    );
  const q = query.normalize("NFKC").trim().toLowerCase();
  const visible = games.filter((g) => {
    if (
      q &&
      !`${g.black} ${g.white} ${g.played_at}`
        .normalize("NFKC")
        .toLowerCase()
        .includes(q)
    )
      return false;
    if (quick === "favorite" && !g.favorite) return false;
    if (
      (quick === "win" || quick === "loss") &&
      !(g.self_side && g.result === quick)
    )
      return false;
    if (filter.scope === "self" && !g.self_side) return false;
    if (filter.scope === "other" && g.self_side) return false;
    if (filter.side && g.self_side !== filter.side) return false;
    if (filter.period) {
      const p = dateParts(g.played_at);
      if (!p || (today - p.time) / 86400000 > Number(filter.period))
        return false;
    }
    return true;
  });
  const active = groups.filter(([key]) => filter[key]).length;
  const parts = [
    filter.scope && (filter.scope === "self" ? "自分の対局" : "自分以外"),
    filter.side && (filter.side === "black" ? "先手" : "後手"),
    filter.period && `直近${filter.period}日`,
    query.trim() && `「${query.trim()}」`,
  ].filter(Boolean);
  const own = visible.filter((g) => g.self_side);
  const count = (r: Game["result"]) => own.filter((g) => g.result === r).length;
  const tally = own.length
    ? `（${count("win")}勝${count("loss")}敗${count("draw") ? `${count("draw")}分` : ""}）`
    : "";
  return (
    <Screen>
      <AppBar title="棋譜" note={`${games.length}局`}>
        {!searching && (
          <RoundButton
            icon="search"
            label="検索"
            onPress={() => setSearching(true)}
          />
        )}
      </AppBar>
      {searching && (
        <View style={s.sf}>
          <Icon name="search" size={16} strokeWidth={2.2} />
          <TextInput
            autoFocus
            accessibilityLabel="棋譜を検索"
            placeholder="対局者名・日付"
            placeholderTextColor="rgba(86,91,133,0.65)"
            value={query}
            onChangeText={setQuery}
            inputMode="search"
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
            style={s.sfInput}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="検索を閉じる"
            onPress={() => {
              setSearching(false);
              setQuery("");
            }}
            style={s.sfClose}
          >
            <Icon name="x" size={16} strokeWidth={2.2} />
          </Pressable>
        </View>
      )}
      <View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          accessibilityLabel="絞り込み"
          contentContainerStyle={s.chs}
        >
          <Chip
            raised
            icon="filter"
            label="絞り込み"
            count={active}
            onPress={() => setSheet(true)}
          />
          {quicks.map(([value, label]) => (
            <Chip
              key={value}
              label={label}
              selected={quick === value}
              onPress={() => setQuick(value)}
            />
          ))}
        </ScrollView>
      </View>
      {parts.length > 0 && (
        <View style={s.fsum}>
          <Text style={[font(700, 11, 1.4), { flex: 1 }]}>
            {parts.join("・")}　{visible.length}局{tally}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={clear}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            style={{ paddingVertical: 7, paddingHorizontal: 8 }}
          >
            <Underlined>解除</Underlined>
          </Pressable>
        </View>
      )}
      <FlatList
        data={visible}
        keyExtractor={(g) => g.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={s.gl}
        ListEmptyComponent={
          <EmptyState
            small
            image="sys-noresults"
            title={
              query.trim()
                ? `「${query.trim()}」に合う棋譜がありません`
                : active
                  ? "条件に合う棋譜がありません"
                  : emptyQuick[quick]
            }
          >
            <Button size="sm" style={{ marginTop: 10 }} onPress={clear}>
              すべての棋譜を表示
            </Button>
          </EmptyState>
        }
        renderItem={({ item: g, index }) => {
          const month = monthOf(g);
          const stamp = g.self_side ? stamps[g.result] : null;
          return (
            <>
              {(index === 0 || monthOf(visible[index - 1]!) !== month) && (
                <Text
                  accessibilityRole="header"
                  style={[s.mh, index === 0 && { marginTop: 2 }]}
                >
                  {month}
                </Text>
              )}
              {/* お気に入りの星はカードの上に重ねる（ボタンの中にボタンを入れない） */}
              <View style={{ marginBottom: 9 }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${g.black} 対 ${g.white}、${g.plies}手を開く`}
                  onPress={() => router.push(`/game/${g.id}`)}
                  style={({ pressed }) => [
                    s.gcd,
                    pressed && {
                      transform: [{ translateY: 2 }],
                      boxShadow: shadow.pressed,
                    },
                  ]}
                >
                  <View
                    accessibilityRole="image"
                    accessibilityLabel={stamp ? stamp[1] : "自分以外の対局"}
                    style={[
                      s.rs,
                      { backgroundColor: stamp ? stamp[2] : "transparent" },
                      // Android は破線の指定を外しても実線に戻らないので、どちらも書く
                      {
                        borderStyle:
                          !stamp || g.result === "unknown" ? "dashed" : "solid",
                      },
                    ]}
                  >
                    <Text
                      style={font(
                        900,
                        17,
                        1,
                        !stamp || g.result === "unknown"
                          ? colors.ink2
                          : colors.ink,
                      )}
                    >
                      {stamp ? stamp[0] : "他"}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={s.g1}>
                      <Text
                        numberOfLines={1}
                        style={[font(900, 14.5, 1.3), { flexShrink: 1 }]}
                      >
                        {g.self_side === "black"
                          ? g.white
                          : g.self_side === "white"
                            ? g.black
                            : `${g.black} 対 ${g.white}`}
                      </Text>
                      <Text style={font(700, 11, 1, colors.ink2)}>
                        {g.self_side
                          ? `あなたは${g.self_side === "black" ? "☗先手" : "☖後手"}`
                          : "自分以外の対局"}
                      </Text>
                    </View>
                    <View style={s.tg}>
                      {g.self_side ? (
                        <View style={[s.t, s.tUn]}>
                          <Text style={font(700, 11, 1, colors.ink2)}>
                            未分類
                          </Text>
                        </View>
                      ) : (
                        ["☗", "☖"].map((mark) => (
                          <View
                            key={mark}
                            style={[s.t, { backgroundColor: colors.sky }]}
                          >
                            <Text
                              style={[
                                font(700, 9.5, 1, colors.ink2),
                                { marginRight: 3 },
                              ]}
                            >
                              {mark}
                            </Text>
                            <Text style={font(700, 11)}>未分類</Text>
                          </View>
                        ))
                      )}
                    </View>
                    <Text style={font(500, 11, 1.2, colors.ink2)}>
                      {dateShort(g.played_at)}・{g.plies}手
                    </Text>
                  </View>
                  <View style={s.gx}>
                    <View style={s.nopill}>
                      <Text style={font(700, 11, 1, colors.ink2)}>未解析</Text>
                    </View>
                    <View style={s.fv} />
                  </View>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    g.favorite ? "お気に入りから外す" : "お気に入りに入れる"
                  }
                  aria-selected={!!g.favorite}
                  onPress={() => void favorite(g)}
                  hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                  style={[s.fv, s.fvOn]}
                >
                  <Icon
                    name="star"
                    size={17}
                    strokeWidth={2}
                    color={g.favorite ? colors.ink : colors.dash}
                    fill={g.favorite ? colors.you : "none"}
                  />
                </Pressable>
              </View>
            </>
          );
        }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="取り込む"
        onPress={() => router.push("/import")}
        style={({ pressed }) => [
          s.fab,
          pressed && { transform: [{ translateY: 3 }], boxShadow: "none" },
        ]}
      >
        <Icon name="plus" size={18} strokeWidth={2.8} />
        <Text style={font(900, 14)}>取り込む</Text>
      </Pressable>
      <Sheet
        auto
        visible={sheet}
        title="絞り込み"
        onClose={() => setSheet(false)}
        footer={
          <>
            <Button kind="pri" wide onPress={() => setSheet(false)}>
              {`${visible.length}局を表示`}
            </Button>
            {active > 0 && (
              <TextButton onPress={() => setFilter(noFilter)}>
                条件をすべて外す
              </TextButton>
            )}
          </>
        }
      >
        {groups.map(([key, label, options], i) => (
          <View key={key}>
            <Text
              accessibilityRole="header"
              style={[s.fgrp, i === 0 && { marginTop: 2 }]}
            >
              {label}
            </Text>
            <View style={s.opt}>
              {options.map(([value, text]) => (
                <Chip
                  key={value}
                  label={text}
                  selected={filter[key] === value}
                  onPress={() => setFilter({ ...filter, [key]: value })}
                />
              ))}
            </View>
          </View>
        ))}
      </Sheet>
    </Screen>
  );
}
const s = StyleSheet.create({
  sf: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 40,
    marginHorizontal: 12,
    marginBottom: 8,
    paddingLeft: 12,
    paddingRight: 6,
    borderWidth: line.ol,
    borderColor: colors.ink,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
  },
  sfInput: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    paddingVertical: 0,
    fontFamily: font(500, 16).fontFamily,
    fontSize: 16,
    color: colors.ink,
    outlineWidth: 0,
    outlineStyle: "solid", // Web: auto のままだと幅0でも既定のフォーカス枠が出る
  },
  sfClose: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  chs: { gap: 6, paddingTop: 2, paddingHorizontal: 12, paddingBottom: 8 },
  fsum: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 12,
    marginBottom: 6,
    paddingVertical: 5,
    paddingLeft: 12,
    paddingRight: 6,
    borderWidth: line.thin,
    borderStyle: "dashed",
    borderColor: colors.dash,
    borderRadius: 12,
  },
  gl: { paddingTop: 9, paddingHorizontal: 12, paddingBottom: 78 },
  mh: {
    ...font(900, 11, 1, colors.ink2),
    letterSpacing: 0.66,
    marginTop: 10,
    marginHorizontal: 4,
    marginBottom: 6,
  },
  gcd: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    paddingLeft: 10,
    paddingRight: 8,
    backgroundColor: colors.white,
    borderWidth: line.ol,
    borderColor: colors.ink,
    borderRadius: radius.card,
    boxShadow: shadow.card,
  },
  rs: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: line.ol,
    borderColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  g1: { flexDirection: "row", alignItems: "center", gap: 6 },
  tg: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: 4,
    rowGap: 3,
    marginVertical: 4,
  },
  t: {
    flexDirection: "row",
    alignItems: "center",
    height: 20,
    paddingHorizontal: 7,
    borderRadius: 6,
    backgroundColor: colors.sand,
  },
  tUn: {
    backgroundColor: "transparent",
    borderWidth: line.thin,
    borderStyle: "dashed",
    borderColor: "rgba(36,40,70,0.4)",
  },
  gx: {
    alignSelf: "stretch",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 3,
  },
  nopill: {
    height: 22,
    justifyContent: "center",
    paddingHorizontal: 8,
    borderWidth: line.thin,
    borderStyle: "dashed",
    borderColor: "rgba(36,40,70,0.5)",
    borderRadius: radius.pill,
  },
  fv: {
    width: 28,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
    marginRight: -2,
    marginBottom: -3,
  },
  // カードの枠＋内側の余白から、上の負の余白（-2, -3）を引いた位置
  fvOn: {
    position: "absolute",
    right: line.ol + 8 - 2,
    bottom: line.ol + 8 - 3,
    marginRight: 0,
    marginBottom: 0,
  },
  fab: {
    position: "absolute",
    right: 14,
    bottom: 12,
    height: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 14,
    paddingRight: 18,
    borderWidth: line.ol,
    borderColor: colors.ink,
    borderRadius: radius.pill,
    backgroundColor: colors.mint,
    boxShadow: shadow.card,
  },
  fgrp: {
    ...font(900, 12, 1.3),
    marginTop: 14,
    marginHorizontal: 2,
    marginBottom: 7,
  },
  opt: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 12 },
});
