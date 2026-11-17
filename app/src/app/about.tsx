import { Image, Text, View } from "react-native";
import { router } from "expo-router";
import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { ask, toast } from "../components/overlay";
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
            title="利用規約"
            onPress={() =>
              router.push({ pathname: "/legal", params: { kind: "terms" } })
            }
          />
          <Row
            title="プライバシーポリシー"
            onPress={() =>
              router.push({ pathname: "/legal", params: { kind: "privacy" } })
            }
          />
          <Row
            title="お問い合わせ"
            onPress={() =>
              ask({
                title: "お問い合わせ",
                text: "配布者へ直接ご連絡ください。不具合は公開の報告先にも送れますが、棋譜・名前・招待コード・バックアップなどの個人情報を載せないでください。",
                ok: "公開の報告先を開く",
                onOk: () => {
                  void Linking.openURL(
                    "https://github.com/phni3j9a/kifumate/issues",
                  ).catch(() =>
                    toast("開けませんでした。配布者へご連絡ください"),
                  );
                },
              })
            }
          />
          <Row
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
