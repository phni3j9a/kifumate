import { useEffect, useState } from "react";
import { useSQLiteContext } from "expo-sqlite";
import { Button, Card, Field, Label, Message, Page } from "../components/ui";
import { listAliases, saveAliases } from "../storage/repository";
export default function Names() {
  const db = useSQLiteContext();
  const [text, setText] = useState(""),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    listAliases(db)
      .then((a) => {
        setText(a.map((n) => n.name).join("\n"));
        setReady(true);
      })
      .catch(() =>
        setError("登録名を読めませんでした。前の画面から開き直してください。"),
      );
  }, [db]);
  async function save() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await saveAliases(db, text.split("\n"));
      setMessage("保存しました。自動判定の棋譜を更新しました。");
    } catch {
      setError(
        "保存できませんでした。登録名や棋譜は変更していません。もう一度お試しください。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page>
      <Label title>いつもの名前を教えてください</Label>
      <Label muted>
        1行に1つ、複数登録できます。全角・半角の英数字や前後の空白、大文字・小文字は同じと見なします。
      </Label>
      <Field
        multiline
        accessibilityLabel="自分の対局者名"
        placeholder={"つばめ\ntsubame"}
        value={text}
        onChangeText={setText}
        editable={ready && !busy}
      />
      <Card>
        <Label muted>
          両方の対局者に一致したときは自動で決めません。対局情報から直せます。手動で直した先後・結果は、登録名を変えても維持します。
        </Label>
      </Card>
      <Message text={error} error />
      <Message text={message} />
      <Button primary disabled={!ready || busy} onPress={() => void save()}>
        {busy ? "保存中…" : "登録名を保存"}
      </Button>
    </Page>
  );
}
