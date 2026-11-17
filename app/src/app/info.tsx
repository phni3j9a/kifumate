import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { Button, Card, Label, Message, Page } from "../components/ui";
import { IdentityFields } from "../components/identity-fields";
import { useGame } from "../components/use-game";
import { type Side, type Result } from "../core/kif";
import { updateInfo } from "../storage/repository";
export default function Info() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { game, error, db } = useGame(id);
  const [side, setSide] = useState<Side | undefined>(),
    [result, setResult] = useState<Result | undefined>(),
    [message, setMessage] = useState(""),
    [failure, setFailure] = useState(""),
    [busy, setBusy] = useState(false);
  const shownSide = side === undefined ? (game?.self_side ?? null) : side;
  const shownResult = result ?? game?.result ?? "unknown";
  async function save() {
    setBusy(true);
    setFailure("");
    setMessage("");
    try {
      await updateInfo(db, id, shownSide, shownResult);
      setMessage("対局情報を保存しました。");
    } catch {
      setFailure("保存できませんでした。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page>
      <Message text={error || failure} error />
      {game && (
        <>
          <Card>
            <Label>先手：{game.black}</Label>
            <Label>後手：{game.white}</Label>
            <Label muted>
              {game.played_at || "対局日不明"}・{game.plies}手
            </Label>
          </Card>
          <IdentityFields
            side={shownSide}
            result={shownResult}
            onSide={setSide}
            onResult={setResult}
          />
          <Label muted>
            結果はアプリ内の手動修正です。元のKIFの終局理由は変えません。
          </Label>
          <Message text={message} />
          <Button primary disabled={busy} onPress={() => void save()}>
            対局情報を保存
          </Button>
        </>
      )}
    </Page>
  );
}
