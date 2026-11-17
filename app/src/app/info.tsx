import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Sheet, toast } from "../components/overlay";
import { colors, font, line, radius } from "../components/theme";
import {
  Button,
  Card,
  Chip,
  Hint,
  PageHeader,
  PageScroll,
  Problem,
  Screen,
  SectionTitle,
  Segmented,
  Underlined,
} from "../components/ui";
import { useGame } from "../components/use-game";
import { dateLong } from "../core/format";
import {
  gameOutcome,
  outcomeText,
  readStoredKif,
  resultFor,
  type Result,
  type Side,
} from "../core/kif";
import { updateInfo } from "../storage/repository";

const other = (side: "black" | "white") =>
  side === "black" ? "white" : "black";
export default function Info() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { game, error, db, reload } = useGame(id);
  const record = useMemo(() => (game ? readStoredKif(game.kif) : null), [game]);
  const [sheet, setSheet] = useState(false);
  if (!game || !record)
    return (
      <Screen>
        <PageHeader title="対局情報" />
        <Problem text={error || "棋譜を読み込んでいます…"} />
      </Screen>
    );
  const outcome = gameOutcome(record);
  const self = game.self_side;
  // 保存している結果は「自分から見た勝ち負け」。画面ではモックと同じく、どちらが勝ったかで見せる。
  const winner: Side | "draw" = !self
    ? outcome
    : game.result === "draw"
      ? "draw"
      : game.result === "win"
        ? self
        : game.result === "loss"
          ? other(self)
          : null;
  const fromRecord = winner === outcome;
  const resultText = fromRecord
    ? outcomeText(record).replace("手で", "手・")
    : `${game.plies}手・${winner === "draw" ? "引き分け" : winner ? `${winner === "black" ? "先手" : "後手"}の勝ち` : "結果は不明"}`;
  async function save(side: Side, result: Result) {
    try {
      await updateInfo(db, id, side, result);
      await reload();
    } catch {
      toast("保存できませんでした。もう一度お試しください");
    }
  }
  function setSide(next: Side) {
    // 手で直した結果は「どちらが勝ったか」を保つ。それ以外は棋譜の結果から決め直す。
    const kept =
      game!.result_manual && self && next
        ? game!.result === "win" || game!.result === "loss"
          ? next === self
            ? game!.result
            : game!.result === "win"
              ? "loss"
              : "win"
          : game!.result
        : resultFor(next, outcome);
    void save(next, kept);
  }
  const choices: [Side | "draw", string][] = [
    ["black", `☗ ${game.black} の勝ち`],
    ["white", `☖ ${game.white} の勝ち`],
    ["draw", "引き分け"],
    [null, "わからない"],
  ];
  return (
    <Screen>
      <PageHeader title="対局情報" />
      <PageScroll>
        <Card style={s.kv}>
          {[
            ["日付", dateLong(game.played_at)],
            ["結果", resultText],
            ["解析", "まだ解析していません"],
          ].map(([label, value]) => (
            <View key={label} style={{ flexDirection: "row", gap: 12 }}>
              <Text style={font(900, 10.5, 1.8, colors.ink2)}>{label}</Text>
              <View style={s.kvValue}>
                <Text style={font(700, 12.5, 1.5)}>{value}</Text>
                {label === "結果" && self && !fromRecord && (
                  <View style={s.edm}>
                    <Text style={font(700, 9.5, 1, colors.ink2)}>手で修正</Text>
                  </View>
                )}
                {label === "結果" && self && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="結果を修正"
                    onPress={() => setSheet(true)}
                    hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                    style={{ marginLeft: 8 }}
                  >
                    <Underlined>修正</Underlined>
                  </Pressable>
                )}
              </View>
            </View>
          ))}
        </Card>
        <SectionTitle>あなたはどちら</SectionTitle>
        <Segmented
          label="あなたはどちら"
          options={[
            ["black", `☗ ${game.black}`],
            ["white", `☖ ${game.white}`],
            ["none", "自分ではない"],
          ]}
          value={self ?? "none"}
          onChange={(v) => setSide(v === "none" ? null : v)}
        />
        <Hint>
          登録した対局者名から自動で見分けています。ちがうときはここで直せます。「自分ではない」にすると、戦績には数えません。
        </Hint>
      </PageScroll>
      <Sheet
        auto
        visible={sheet}
        title="結果を直す"
        onClose={() => setSheet(false)}
      >
        {/* モックは .opt の下余白12と .hint の上余白8が重なって12（RN は重ならない） */}
        <View style={{ gap: 6, marginBottom: 4 }}>
          {choices.map(([value, label]) => (
            <Chip
              key={label}
              block
              label={label}
              selected={winner === value}
              onPress={() =>
                void save(
                  self,
                  value === "draw"
                    ? "draw"
                    : !value
                      ? "unknown"
                      : value === self
                        ? "win"
                        : "loss",
                )
              }
            />
          ))}
        </View>
        <Hint>
          棋譜に結果が書かれていないときや、ちがっているときに直せます。引き分けと「わからない」は、勝率に数えません。
        </Hint>
        <View style={{ marginTop: 16 }}>
          <Button kind="pri" wide onPress={() => setSheet(false)}>
            これでよい
          </Button>
        </View>
      </Sheet>
    </Screen>
  );
}
const s = StyleSheet.create({
  kv: { gap: 7, paddingVertical: 11, paddingHorizontal: 14 },
  kvValue: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
  },
  edm: {
    marginLeft: 6,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderWidth: line.thin,
    borderStyle: "dashed",
    borderColor: "rgba(36,40,70,0.5)",
    borderRadius: radius.pill,
  },
});
