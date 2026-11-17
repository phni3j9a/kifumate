import { useCallback, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import {
  Button,
  Chip,
  colors,
  Empty,
  Field,
  IconButton,
  Label,
  Message,
  styles,
} from "../../components/ui";
import { resultLabels } from "../../core/kif";
import { listGames, toggleFavorite, type Game } from "../../storage/repository";
export default function Games() {
  const db = useSQLiteContext();
  const [games, setGames] = useState<Game[]>([]),
    [error, setError] = useState("");
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [side, setSide] = useState("all");
  const load = useCallback(async () => {
    try {
      setGames(await listGames(db));
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
      setError("お気に入りを保存できませんでした。");
    }
  }
  const visible = games.filter(
    (g) =>
      `${g.black} ${g.white} ${g.played_at}`
        .normalize("NFKC")
        .toLowerCase()
        .includes(query.normalize("NFKC").trim().toLowerCase()) &&
      (filter === "all" ||
        filter === "none" ||
        (filter === "favorite"
          ? g.favorite
          : g.self_side && g.result === filter)) &&
      (side === "all" ||
        (side === "other"
          ? !g.self_side
          : side === "self"
            ? !!g.self_side
            : g.self_side === side)),
  );
  return (
    <FlatList
      data={visible}
      keyExtractor={(g) => g.id}
      contentContainerStyle={[styles.page, { gap: 12 }]}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={{ gap: 16 }}>
          <View style={[styles.row, { justifyContent: "space-between" }]}>
            <Label muted>{games.length}局・端末内に保存</Label>
            <Button primary onPress={() => router.push("/import")}>
              ＋ 取り込む
            </Button>
          </View>
          <Field
            accessibilityLabel="棋譜を検索"
            placeholder="対局者名・日付で検索"
            value={query}
            onChangeText={setQuery}
            returnKeyType="search"
          />
          <View style={styles.row}>
            {[
              ["all", "すべて"],
              ["favorite", "お気に入り"],
              ["win", "勝ち"],
              ["loss", "負け"],
              ["none", "未解析"],
            ].map(([value, label]) => (
              <Chip
                key={value}
                label={label!}
                selected={filter === value}
                onPress={() => setFilter(value!)}
              />
            ))}
          </View>
          <View style={styles.row}>
            {[
              ["all", "対象すべて"],
              ["self", "自分の対局"],
              ["other", "自分以外"],
              ["black", "先手"],
              ["white", "後手"],
            ].map(([value, label]) => (
              <Chip
                key={value}
                label={label!}
                selected={side === value}
                onPress={() => setSide(value!)}
              />
            ))}
          </View>
          <Message text={error} error />
          {error ? <Button onPress={() => void load()}>もう一度</Button> : null}
        </View>
      }
      ListEmptyComponent={
        <Empty
          title={
            games.length ? "条件に合う棋譜がありません" : "まだ棋譜がありません"
          }
          detail={
            games.length
              ? "検索や絞り込みの条件を変えてみましょう。"
              : "KIFを取り込んで、指した将棋を振り返りましょう。"
          }
        >
          {games.length ? (
            <Button
              onPress={() => {
                setQuery("");
                setFilter("all");
                setSide("all");
              }}
            >
              条件をすべて外す
            </Button>
          ) : (
            <Button primary onPress={() => router.push("/import")}>
              棋譜を取り込む
            </Button>
          )}
        </Empty>
      }
      renderItem={({ item: g }) => (
        <View
          style={[
            styles.card,
            {
              padding: 12,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
            },
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${g.black} 対 ${g.white}、${g.plies}手を開く`}
            onPress={() => router.push(`/game/${g.id}`)}
            style={{
              flex: 1,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
            }}
          >
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 99,
                borderWidth: 2,
                borderColor: colors.ink,
                backgroundColor: g.self_side
                  ? g.result === "win"
                    ? colors.yellow
                    : colors.blue
                  : colors.background,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text
                style={{ color: colors.ink, fontWeight: "900", fontSize: 18 }}
              >
                {!g.self_side
                  ? "他"
                  : { win: "勝", loss: "負", draw: "分", unknown: "？" }[
                      g.result
                    ]}
              </Text>
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <Text
                numberOfLines={2}
                style={[styles.text, { fontWeight: "800" }]}
              >
                {g.self_side === "black"
                  ? g.white
                  : g.self_side === "white"
                    ? g.black
                    : `${g.black} 対 ${g.white}`}
              </Text>
              <Label muted>
                {g.self_side
                  ? `あなたは${g.self_side === "black" ? "先手" : "後手"}・${resultLabels[g.result]}`
                  : "自分以外・未指定"}
              </Label>
              <Label muted>
                {g.played_at ? g.played_at.split(" ")[0] : "対局日不明"}・
                {g.plies}手
              </Label>
              <Label muted>未分類</Label>
            </View>
          </Pressable>
          <View style={{ alignItems: "center", gap: 8 }}>
            <Text style={{ color: colors.muted, fontSize: 11 }}>未解析</Text>
            <IconButton
              name={g.favorite ? "star" : "star-outline"}
              label={g.favorite ? "お気に入りから外す" : "お気に入りに入れる"}
              onPress={() => void favorite(g)}
            />
          </View>
        </View>
      )}
    />
  );
}
