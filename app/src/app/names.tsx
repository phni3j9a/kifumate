import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSQLiteContext } from "expo-sqlite";
import { Icon } from "../components/icons";
import { toast } from "../components/overlay";
import { font } from "../components/theme";
import {
  Button,
  Card,
  EmptyNote,
  Hint,
  Input,
  PageHeader,
  PageScroll,
  Screen,
  s as ui,
} from "../components/ui";
import { normalizeName } from "../core/kif";
import { listAliases, saveAliases } from "../storage/repository";

export default function Names() {
  const db = useSQLiteContext();
  const [names, setNames] = useState<string[] | null>(null),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    listAliases(db)
      .then((a) => setNames(a.map((n) => n.name)))
      .catch(() =>
        toast("登録名を読めませんでした。前の画面から開き直してください"),
      );
  }, [db]);
  // 足す・外すのたびに保存し、自動で見分けた棋譜を判定し直す。
  async function save(next: string[]) {
    setBusy(true);
    try {
      await saveAliases(db, next);
      setNames((await listAliases(db)).map((n) => n.name));
      return true;
    } catch {
      toast("保存できませんでした。登録名や棋譜は変えていません");
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function add() {
    const name = text.trim();
    if (!name || !names || busy) return;
    if (names.some((n) => normalizeName(n) === normalizeName(name))) {
      toast("その名前は登録済みです");
      return;
    }
    if (await save([...names, name])) {
      setText("");
      toast(`「${name}」を登録しました`);
    }
  }
  async function remove(name: string) {
    if (!names || busy) return;
    const before = names;
    if (await save(names.filter((n) => n !== name)))
      toast(`「${name}」を外しました`, {
        label: "元に戻す",
        onPress: () => void save(before),
      });
  }
  return (
    <Screen>
      <PageHeader title="自分の対局者名" />
      <PageScroll>
        <Hint style={{ marginTop: 0, marginBottom: 10 }}>
          棋譜に書かれた対局者名と照らし合わせて、あなたが先手か後手か、勝ったか負けたかを判定します。名前はいくつでも登録できます。この端末の中だけで使い、サーバーには送りません。
        </Hint>
        <Card>
          {names?.length ? (
            names.map((n, i) => (
              <View key={n} style={[row, i > 0 && ui.hairTop]}>
                <Text
                  numberOfLines={1}
                  style={[font(900, 14, 1.3), { flex: 1 }]}
                >
                  {n}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${n} を削除`}
                  onPress={() => void remove(n)}
                  style={{
                    width: 34,
                    height: 34,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon name="x" size={15} strokeWidth={2.4} />
                </Pressable>
              </View>
            ))
          ) : (
            <EmptyNote>
              {names ? "まだ登録がありません。" : "読み込んでいます…"}
            </EmptyNote>
          )}
        </Card>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
          <Input
            accessibilityLabel="追加する対局者名"
            placeholder="対局者名を追加"
            value={text}
            onChangeText={setText}
            onSubmitEditing={() => void add()}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            style={{ flex: 1 }}
          />
          <Button
            kind="pri"
            size="md"
            style={{ height: 42, paddingHorizontal: 16 }}
            onPress={() => void add()}
          >
            追加
          </Button>
        </View>
        <Hint>
          どの名前にも当てはまらない棋譜や、先手と後手の両方に当てはまる棋譜は、取り込むときにどちらかを選べます。
        </Hint>
        <Hint>
          名前を足したり外したりすると、自動で見分けた棋譜は判定し直します。手で直した先後と結果は変わりません。
        </Hint>
        <Hint>
          全角と半角、大文字と小文字のちがいは、同じ名前として扱います。
        </Hint>
      </PageScroll>
    </Screen>
  );
}
const row = {
  flexDirection: "row",
  alignItems: "center",
  gap: 10,
  minHeight: 48,
  paddingVertical: 4,
  paddingLeft: 12,
  paddingRight: 6,
} as const;
