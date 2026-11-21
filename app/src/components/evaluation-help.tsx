import { StyleSheet, Text, View } from "react-native";
import { GraphMarkIcon } from "./graph-mark";
import { Sheet } from "./overlay";
import { colors, font, line } from "./theme";

const levels = [
  ["±150", "くらいまで", "ほぼ互角"],
  ["500", "前後", "有利"],
  ["1000", "以上", "大きな差"],
];
const marks = [
  ["好手", "解析のおすすめと同じ手で、ほかの手より良かった手"],
  ["疑問手", "候補1位ではなく、指した側の勝つ見込みが10ポイント以上下がった手"],
  ["悪手", "候補1位ではなく、指した側の勝つ見込みが20ポイント以上下がった手"],
  ["詰みあり", "1手か3手で詰む手があった局面"],
] as const;

export function EvaluationHelp({
  visible,
  close,
  you,
  opponent,
}: {
  visible: boolean;
  close: () => void;
  you: string;
  opponent: string;
}) {
  return (
    <Sheet auto visible={visible} title="評価値と印の見かた" onClose={close}>
      <Text style={font(500, 12.5, 1.75)}>
        評価値は、解析が出した形勢の点数です。
        <Text style={font(900, 12.5, 1.75)}>プラスは{you}が有利</Text>
        、マイナスは{opponent}が有利です。
      </Text>
      <View style={s.levels}>
        {levels.map(([value, qualifier, label]) => (
          <View style={s.level} key={value}>
            <Text style={font(900, 13, 1.3)}>{value}</Text>
            <Text style={font(500, 10.5, 1.4, colors.ink2)}>{qualifier}</Text>
            <Text style={font(900, 11, 1.4)}>{label}</Text>
          </View>
        ))}
      </View>
      <Text style={[font(500, 12.5, 1.75), { marginTop: 8 }]}>
        上の「{you}{" "}
        ○%」は、評価値から見積もった勝つ見込みです。戦績の勝率とは別のものです。
      </Text>
      {marks.map(([kind, detail]) => (
        <View key={kind} style={s.mark}>
          <GraphMarkIcon kind={kind} size={26} />
          <View style={{ flex: 1 }}>
            <Text style={font(900, 12.5, 1.4)}>{kind}</Text>
            <Text style={font(500, 11.5, 1.5, colors.ink2)}>{detail}</Text>
          </View>
        </View>
      ))}
      <Text style={[font(500, 11.5, 1.5, colors.ink2), { marginTop: 8 }]}>
        グラフには深く読んだ局面の評価値が優先して出ます。印は、前後の局面を同じ条件で読んだ結果どうしで比べて付けます。
      </Text>
      <Text style={[font(500, 11.5, 1.5, colors.ink2), { marginTop: 8 }]}>
        3000を超える大きな差は、「3000以上」と表します。
      </Text>
    </Sheet>
  );
}

const s = StyleSheet.create({
  levels: { flexDirection: "row", gap: 6, marginTop: 10 },
  level: {
    flex: 1,
    alignItems: "center",
    padding: 6,
    borderWidth: line.thin,
    borderColor: colors.ink,
    borderRadius: 10,
    backgroundColor: colors.white,
  },
  mark: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10 },
});
