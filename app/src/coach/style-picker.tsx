import { Text, View } from "react-native";
import { Chip, Segmented } from "../components/ui";
import { font } from "../components/theme";
import { focuses, details, type Style } from "./types";
export function StylePicker({
  value,
  onChange,
  profile = false,
}: {
  value: Style;
  onChange: (v: Style) => void;
  profile?: boolean;
}) {
  return (
    <>
      <Text
        style={[
          font(900, 12, 1.3),
          { marginTop: profile ? 8 : 2, marginHorizontal: 2, marginBottom: 7 },
        ]}
      >
        {profile ? "どこを中心に" : "どこを中心に説明しますか"}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {focuses.map((f) => (
          <Chip
            key={f}
            label={f}
            selected={value.focus === f}
            onPress={() => onChange({ ...value, focus: f })}
          />
        ))}
      </View>
      <Text
        style={[
          font(900, 12, 1.3),
          { marginTop: 14, marginHorizontal: 2, marginBottom: 7 },
        ]}
      >
        詳しさ
      </Text>
      <Segmented
        label="詳しさ"
        options={details.map((d) => [d, d] as const)}
        value={value.detail}
        onChange={(detail) => onChange({ ...value, detail })}
      />
    </>
  );
}
