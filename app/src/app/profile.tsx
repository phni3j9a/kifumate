import { Text, View } from "react-native";
import { useCoach } from "../coach/provider";
import { practices } from "../coach/types";
import { StylePicker } from "../coach/style-picker";
import {
  Chip,
  Hint,
  PageHeader,
  PageScroll,
  Screen,
  SectionTitle,
  TextArea,
} from "../components/ui";
import { colors, font, line } from "../components/theme";
import { toast } from "../components/overlay";
export default function ProfileScreen() {
  const { profile, controller, overview } = useCoach();
  const save = (p: typeof profile) =>
    void controller
      .setProfile(p)
      .catch(() => toast("保存できませんでした。もう一度お試しください"));
  return (
    <Screen>
      <PageHeader title="学習プロフィール" />
      <PageScroll>
        {!overview?.paid && (
          <Text
            style={[
              font(500, 10.5, 1.5, colors.ink2),
              {
                paddingVertical: 6,
                paddingHorizontal: 10,
                borderWidth: line.thin,
                borderStyle: "dashed",
                borderColor: colors.dash,
                borderRadius: 10,
              },
            ]}
          >
            AIコーチ（有料プラン）の解説に使われる設定です。
          </Text>
        )}
        <SectionTitle>練習中の戦法（いくつでも）</SectionTitle>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {practices.map((p) => (
            <Chip
              key={p}
              label={p}
              multiple
              selected={profile.practice.includes(p)}
              onPress={() => {
                if (
                  !profile.practice.includes(p) &&
                  profile.practice.length >= 10
                ) {
                  toast("練習中の戦法は10個まで選べます");
                  return;
                }
                save({
                  ...profile,
                  practice: profile.practice.includes(p)
                    ? profile.practice.filter((x) => x !== p)
                    : [...profile.practice, p],
                });
              }}
            />
          ))}
        </View>
        <SectionTitle>目標</SectionTitle>
        <TextArea
          accessibilityLabel="目標"
          height={92}
          maxLength={200}
          placeholder="例：初段になりたい、終盤を強くしたい"
          value={profile.goal}
          onChangeText={(goal) => save({ ...profile, goal })}
        />
        <SectionTitle>いつもの解説スタイル</SectionTitle>
        <StylePicker
          profile
          value={profile.style}
          onChange={(style) => save({ ...profile, style })}
        />
        <Hint>
          変更はすぐに保存され、次に作る解説から反映されます。解説を作るときに、その対局だけ別のスタイルにもできます。
        </Hint>
      </PageScroll>
    </Screen>
  );
}
