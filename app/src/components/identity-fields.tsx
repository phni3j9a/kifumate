import { View } from "react-native";
import { resultLabels, sideLabels, type Result, type Side } from "../core/kif";
import { Chip, Label, styles } from "./ui";
export function IdentityFields({
  side,
  result,
  onSide,
  onResult,
}: {
  side: Side;
  result: Result;
  onSide: (s: Side) => void;
  onResult: (r: Result) => void;
}) {
  return (
    <>
      <Label>自分はどちら？</Label>
      <View style={styles.row}>
        {(["black", "white", null] as const).map((s) => (
          <Chip
            key={s ?? "none"}
            label={sideLabels[s ?? "none"]}
            selected={side === s}
            onPress={() => onSide(s)}
          />
        ))}
      </View>
      <Label>自分から見た結果</Label>
      <View style={styles.row}>
        {(Object.keys(resultLabels) as Result[]).map((r) => (
          <Chip
            key={r}
            label={resultLabels[r]}
            selected={result === r}
            onPress={() => onResult(r)}
          />
        ))}
      </View>
      {!side && (
        <Label muted>自分以外・未指定の棋譜は、戦績に含めません。</Label>
      )}
    </>
  );
}
