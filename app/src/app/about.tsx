import { Image, Text, View } from "react-native";
import { router } from "expo-router";
import Constants from "expo-constants";
import { colors, font, line, shadow } from "../components/theme";
import {
  Card,
  Hint,
  PageHeader,
  PageScroll,
  Row,
  Screen,
} from "../components/ui";
export default function About() {
  return (
    <Screen>
      <PageHeader title="このアプリについて" />
      <PageScroll>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            marginTop: 2,
            marginHorizontal: 2,
            marginBottom: 14,
          }}
        >
          <View style={{ borderRadius: 15, boxShadow: shadow.small }}>
            <Image
              source={require("../assets/app-icon.png")}
              accessibilityIgnoresInvertColors
              style={{
                width: 56,
                height: 56,
                borderRadius: 15,
                borderWidth: line.ol,
                borderColor: colors.ink,
              }}
            />
          </View>
          <View>
            <Text style={[font(900, 18, 1.2), { letterSpacing: 0.36 }]}>
              kifumate
            </Text>
            <Text style={[font(500, 11.5, 1.3, colors.ink2), { marginTop: 4 }]}>
              棋譜の記録と振り返り
            </Text>
          </View>
        </View>
        <Card>
          <Row
            first
            title="ライセンス"
            sub="このアプリに含まれるソフトウェア"
            onPress={() => router.push("/licenses")}
          />
        </Card>
        <Hint>バージョン {Constants.expoConfig?.version}</Hint>
      </PageScroll>
    </Screen>
  );
}
