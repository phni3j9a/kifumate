import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import { classificationCatalog } from "../core/classify";
import {
  edited,
  families,
  strategyNames,
  tagName,
  tagsOf,
  unclassified,
  type PlayerSide,
  type TagKind,
  type Tags,
} from "../core/stats";
import { resetTags, setTags } from "../storage/classifications";
import type { Game } from "../storage/repository";
import { Sheet } from "./overlay";
import {
  Button,
  Card,
  Chip,
  Hint,
  SectionTitle,
  Segmented,
  TextButton,
  Underlined,
} from "./ui";
import { Tag } from "./classification-tags";
import { colors, font, line, radius } from "./theme";
const ranging = new Set([
  "fourth-file-rook",
  "third-file-rook",
  "central-rook",
  "opposing-rook",
  "double-ranging",
  "bishop-exchange-ranging",
]);
export function ClassificationEditor({
  game,
  db,
  save,
}: {
  game: Game;
  db: SQLiteDatabase;
  save: (change: () => Promise<void>) => void;
}) {
  const [editing, setEditing] = useState<{
    side: PlayerSide;
    kind: TagKind;
  } | null>(null);
  const [draft, setDraft] = useState<Tags>({
    family: unclassified,
    strategies: [],
    castles: [],
  });
  const open = (side: PlayerSide, kind: TagKind) => {
    setDraft(tagsOf(game, side));
    setEditing({ side, kind });
  };
  const change = (next: Tags) => {
    if (!editing) return;
    setDraft(next);
    const { side, kind } = editing;
    save(() => setTags(db, game.id, side, kind, next[kind], next.family));
  };
  const order = [
    "yagura",
    "bishop-exchange",
    "double-wing",
    "side-pawn",
    "gangi",
    "climbing-silver",
    "right-fourth-file-rook",
    "anti-fourth-file-quick-attack",
    "anti-ranging-slow-game",
    "sleeve-rook",
    "rapid-silver",
    "reclining-silver",
    "fourth-file-rook",
    "third-file-rook",
    "central-rook",
    "opposing-rook",
    "double-ranging",
    "bishop-exchange-ranging",
  ];
  return (
    <>
      <SectionTitle>戦法と囲い</SectionTitle>
      <Card style={{ padding: 0 }}>
        {(["black", "white"] as const).map((side, index) => {
          const t = tagsOf(game, side),
            mine = game.self_side === side;
          return (
            <View
              key={side}
              style={[
                s.side,
                index > 0 && { borderTopWidth: 1, borderColor: colors.hair },
              ]}
            >
              <View style={s.head}>
                <View
                  style={[
                    s.avatar,
                    { backgroundColor: mine ? colors.you : colors.opp },
                  ]}
                >
                  <Text style={font(900, 8, 1.3)}>
                    {side === "black" ? "☗" : "☖"}
                  </Text>
                </View>
                <Text style={[font(900, 12.5, 1.3), { flex: 1 }]}>
                  {game[side]}
                  {mine ? "（あなた）" : ""}
                </Text>
                <Text style={s.edited}>
                  {edited(game, side) ? "手で修正" : "自動判定"}
                </Text>
              </View>
              {(["strategies", "castles"] as const).map((kind) => {
                const names =
                  kind === "strategies"
                    ? strategyNames(t)
                    : t.castles.map((id) => tagName(kind, id));
                return (
                  <View key={kind} style={s.row}>
                    <Text
                      style={[font(900, 10.5, 1.3, colors.ink2), { width: 34 }]}
                    >
                      {kind === "strategies" ? "戦法" : "囲い"}
                    </Text>
                    <View style={s.tags}>
                      {(names.length ? names : [unclassified]).map(
                        (name, i) => (
                          <View
                            key={`${name}-${i}`}
                            style={{
                              flexDirection: "row",
                              alignItems: "center",
                              gap: 4,
                            }}
                          >
                            {kind === "castles" && i > 0 && (
                              <Text style={font(900, 10, 1.3, colors.ink2)}>
                                →
                              </Text>
                            )}
                            <Tag
                              large
                              name={name}
                              other={!mine && name !== unclassified}
                            />
                          </View>
                        ),
                      )}
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${side === "black" ? "先手" : "後手"}の${kind === "strategies" ? "戦法" : "囲い"}を修正`}
                      onPress={() => open(side, kind)}
                      style={{ paddingVertical: 7, paddingHorizontal: 4 }}
                      hitSlop={4}
                    >
                      <Underlined>修正</Underlined>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          );
        })}
      </Card>
      <Hint>
        {game.classification_error ||
          "自動判定がちがうときは「修正」から直せます。分からないものは「未分類」のままにできます。囲いが途中で変わった対局は、通った形を順に記録します。"}
      </Hint>
      <Sheet
        auto
        visible={!!editing}
        title={
          editing
            ? `${editing.side === "black" ? "☗" : "☖"} ${game[editing.side]} の${editing.kind === "strategies" ? "戦法" : "囲い"}`
            : ""
        }
        onClose={() => setEditing(null)}
      >
        {editing?.kind === "strategies" ? (
          <>
            <Text style={s.label}>大きな分類</Text>
            <Segmented
              label="大きな分類"
              options={[
                ...families.map((f) => [f, f] as const),
                [unclassified, unclassified],
              ]}
              value={draft.family}
              onChange={(family) =>
                change({ ...draft, family, strategies: [] })
              }
            />
            {draft.family === unclassified ? (
              <Hint>分からないときは「未分類」のままにできます。</Hint>
            ) : (
              <>
                <Text style={[s.label, { marginTop: 14 }]}>
                  戦法（当てはまるものをいくつでも）
                </Text>
                <View style={s.options}>
                  {classificationCatalog.strategies
                    .filter(
                      (t) =>
                        ranging.has(t.id) === (draft.family === "振り飛車"),
                    )
                    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
                    .map((t) => (
                      <Chip
                        key={t.id}
                        multiple
                        label={t.name}
                        selected={draft.strategies.includes(t.id)}
                        onPress={() =>
                          change({
                            ...draft,
                            strategies: draft.strategies.includes(t.id)
                              ? draft.strategies.filter((id) => id !== t.id)
                              : [...draft.strategies, t.id],
                          })
                        }
                      />
                    ))}
                </View>
              </>
            )}
          </>
        ) : (
          <>
            <Text style={s.label}>
              囲い（組んだ順にタップ。途中で変わったものも選べます）
            </Text>
            <View style={s.options}>
              {classificationCatalog.castles.map((t) => (
                <Chip
                  key={t.id}
                  multiple
                  label={`${draft.castles.includes(t.id) && draft.castles.length > 1 ? `${draft.castles.indexOf(t.id) + 1} ` : ""}${t.name}`}
                  selected={draft.castles.includes(t.id)}
                  onPress={() =>
                    change({
                      ...draft,
                      castles: draft.castles.includes(t.id)
                        ? draft.castles.filter((id) => id !== t.id)
                        : [...draft.castles, t.id],
                    })
                  }
                />
              ))}
            </View>
            <Hint>
              いまの記録：
              {draft.castles.map((id) => tagName("castles", id)).join(" → ") ||
                unclassified}
            </Hint>
          </>
        )}
        <View style={{ marginTop: 16, gap: 8, alignItems: "center" }}>
          <Button kind="pri" wide onPress={() => setEditing(null)}>
            これでよい
          </Button>
          {editing && edited(game, editing.side) && (
            <TextButton
              onPress={() => {
                const side = editing.side;
                setDraft(
                  tagsOf({ ...game, classification_manual: null }, side),
                );
                save(() => resetTags(db, game.id, side));
              }}
            >
              自動判定に戻す
            </TextButton>
          )}
        </View>
      </Sheet>
    </>
  );
}
const s = StyleSheet.create({
  side: { paddingTop: 10, paddingHorizontal: 12, paddingBottom: 12 },
  head: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 },
  avatar: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: line.thin,
    borderColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  edited: {
    ...font(700, 10.5, 1.3, colors.ink2),
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderWidth: line.thin,
    borderStyle: "dashed",
    borderColor: colors.dash,
    borderRadius: radius.pill,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  tags: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 4,
  },
  label: {
    ...font(900, 11, 1.3, colors.ink2),
    marginTop: 4,
    marginHorizontal: 2,
    marginBottom: 6,
  },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 12 },
});
