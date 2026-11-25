import { COACH_ENABLED } from "../analysis/environment";
import { useRef, useState } from "react";
import { Platform, Text, View } from "react-native";
import { useAnalysis } from "../analysis/provider";
import {
  Button,
  Card,
  Hint,
  Input,
  PageHeader,
  PageScroll,
  Screen,
  SectionTitle,
} from "../components/ui";
import { font } from "../components/theme";
import { useEntitlements } from "../entitlements/provider";
import { EntitlementStatus } from "../entitlements/status";
import {
  formatInvitation,
  invitationError,
  normalizeInvitation,
  validInvitation,
} from "../entitlements/invitation";
export default function Invitation() {
  const { controller } = useEntitlements();
  const { controller: analysis } = useAnalysis();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [message, setMessage] = useState("");
  async function redeem() {
    if (sending.current) return;
    if (!validInvitation(code)) {
      setMessage(
        "コードは半角英数字16文字です。文字数と入力を確かめてください。",
      );
      return;
    }
    sending.current = true;
    setBusy(true);
    setMessage("");
    try {
      const value = await controller.redeem(normalizeInvitation(code));
      setCode("");
      setMessage(
        value.paid
          ? "招待コードを確認しました。有料機能が使えるようになりました。"
          : "コードを確認しました。今は有効な権利がありません。発行した人にご相談ください。",
      );
      void analysis.sync();
    } catch (error) {
      setMessage(invitationError(error));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <Screen bottom>
      <PageHeader title="招待コード" />
      <PageScroll>
        <Card style={{ padding: 14 }}>
          <EntitlementStatus />
        </Card>
        <SectionTitle>コードを入力</SectionTitle>
        <Hint style={{ marginTop: 0 }}>
          {COACH_ENABLED
            ? "招待コードで、精密解析・リアルタイム解析・AIコーチが使えます。この端末で有効になります。"
            : "招待コードで、精密解析・リアルタイム解析が使えます。この端末で有効になります。"}
        </Hint>
        <Input
          accessibilityLabel="招待コード"
          placeholder="ABCD-EFGH-JKMN-PQRS"
          value={code}
          onChangeText={(value) => {
            setCode(formatInvitation(value));
            setMessage("");
          }}
          keyboardType={
            Platform.OS === "ios" ? "ascii-capable" : "visible-password"
          }
          autoCapitalize="characters"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          editable={!busy}
          returnKeyType="done"
          onSubmitEditing={() => void redeem()}
        />
        <Hint>
          大文字・小文字や全角・半角は、どちらでも入力できます。区切りは自動で入ります。
        </Hint>
        <Button
          wide
          kind="pri"
          disabled={busy || !code}
          onPress={() => void redeem()}
        >
          {busy ? "確認しています…" : "コードを使う"}
        </Button>
        {!!message && (
          <View accessibilityLiveRegion="polite" style={{ marginTop: 14 }}>
            <Text selectable style={font(700, 13, 1.6)}>
              {message}
            </Text>
          </View>
        )}
        <Hint>
          機種変更やアプリの削除で、別の端末に権利を引き継ぐことはできません。コードには期限や使える端末数の上限があります。
        </Hint>
      </PageScroll>
    </Screen>
  );
}
