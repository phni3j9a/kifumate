import { StyleSheet, Text, View } from "react-native";
import {
  families,
  opposite,
  strategyNames,
  tagName,
  tagsOf,
  unclassified,
  type Dimension,
  type GameFilter,
} from "../core/stats";
import type { Game } from "../storage/repository";
import { Chip } from "./ui";
import { colors, font, line } from "./theme";
export function Tag({
  name,
  mark,
  other = false,
  large = false,
}: {
  name: string;
  mark?: string;
  other?: boolean;
  large?: boolean;
}) {
  return (
    <View
      style={[
        s.tag,
        large && { minHeight: 22, paddingHorizontal: 8 },
        other && { backgroundColor: colors.sky },
        name === unclassified && !other && s.un,
      ]}
    >
      {mark && (
        <Text style={[font(700, 9.5, 1.2, colors.ink2), { marginRight: 3 }]}>
          {mark}
        </Text>
      )}
      <Text
        style={font(
          700,
          large ? 11.5 : 11,
          1.2,
          name === unclassified ? colors.ink2 : colors.ink,
        )}
      >
        {name}
      </Text>
    </View>
  );
}
export function GameTags({ game }: { game: Game }) {
  if (!game.self_side)
    return (
      <>
        {(["black", "white"] as const).map((side) => (
          <Tag
            key={side}
            other
            mark={side === "black" ? "☗" : "☖"}
            name={strategyNames(tagsOf(game, side))[0] ?? unclassified}
          />
        ))}
      </>
    );
  const mine = tagsOf(game, game.self_side),
    op = strategyNames(tagsOf(game, opposite(game.self_side)));
  const names = [
    ...strategyNames(mine),
    ...(mine.castles.length ? [tagName("castles", mine.castles.at(-1)!)] : []),
  ];
  return (
    <>
      {(names.length ? names : [unclassified]).map((n, i) => (
        <Tag key={`${n}-${i}`} name={n} />
      ))}
      {op.length > 0 && <Tag other mark="相手" name={op[0]!} />}
    </>
  );
}
export const dimensionLabels: Record<Dimension, string> = {
  myst: "自分の戦法",
  opst: "相手の戦法",
  mycs: "自分の囲い",
};
export function TagFilterGroups({
  games,
  filter,
  onChange,
}: {
  games: Game[];
  filter: GameFilter;
  onChange: (filter: GameFilter) => void;
}) {
  const own = games.filter((g) => g.self_side);
  return (
    <>
      {(["myst", "mycs", "opst"] as const).map((dim) => {
        const kind = dim === "mycs" ? "castles" : "strategies";
        const ids = new Set(
          own.flatMap(
            (g) =>
              tagsOf(g, dim === "opst" ? opposite(g.self_side!) : g.self_side!)[
                kind
              ],
          ),
        );
        const options = [
          ["", "すべて"],
          ...(kind === "strategies"
            ? families.map((f) => [f, `${f}（全部）`])
            : []),
          ...[...ids].map((id) => [id, tagName(kind, id)]),
          ...(dim === "opst" ? [] : [[unclassified, unclassified]]),
        ];
        return (
          <View key={dim}>
            <Text accessibilityRole="header" style={s.label}>
              {dimensionLabels[dim]}
            </Text>
            <View style={s.options}>
              {options.map(([id, label]) => (
                <Chip
                  key={id}
                  label={label!}
                  selected={(filter[dim] ?? "") === id}
                  onPress={() => onChange({ ...filter, [dim]: id })}
                />
              ))}
            </View>
          </View>
        );
      })}
    </>
  );
}
const s = StyleSheet.create({
  tag: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 20,
    paddingHorizontal: 7,
    borderRadius: 6,
    backgroundColor: colors.sand,
  },
  un: {
    backgroundColor: "transparent",
    borderWidth: line.thin,
    borderStyle: "dashed",
    borderColor: colors.dash,
  },
  label: {
    ...font(900, 12, 1.3),
    marginTop: 14,
    marginHorizontal: 2,
    marginBottom: 7,
  },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
});
