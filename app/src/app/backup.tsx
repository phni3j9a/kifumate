import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Platform,
  Text,
  View,
} from "react-native";
import {
  useNavigation,
  useLocalSearchParams,
  usePreventRemove,
} from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import { randomUUID } from "expo-crypto";
import { useAnalysis } from "../analysis/provider";
import { useCoach } from "../coach/provider";
import { useAppData } from "../components/data-provider";
import { ask, Sheet, toast } from "../components/overlay";
import {
  Button,
  Card,
  Hint,
  MascotImage,
  PageHeader,
  PageScroll,
  Screen,
} from "../components/ui";
import { colors, font } from "../components/theme";
import {
  clearPreparedBackup,
  exportBackup,
  prepareBackup,
  restoreBackup,
  type BackupPreview,
} from "../storage/backup";
import {
  clearExpiredBackups,
  discardBackup,
  pickBackup,
  saveBackup,
  shareBackup,
  writeBackupFile,
  type BackupFile,
  type BackupInput,
} from "../storage/backup-file";
import { dataPaused, pauseData, resumeData } from "../storage/maintenance";
export default function Backup() {
  const db = useSQLiteContext(),
    { restore } = useLocalSearchParams<{ restore?: string }>(),
    navigation = useNavigation();
  const analysis = useAnalysis(),
    coach = useCoach(),
    app = useAppData();
  const [count, setCount] = useState(0),
    [last, setLast] = useState(""),
    [busy, setBusy] = useState(""),
    [progress, setProgress] = useState(0),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<BackupPreview | null>(null),
    [output, setOutput] = useState<BackupFile | null>(null);
  const delivering = useRef(false);
  const allowNavigation = usePreventRemove(!!busy);
  useEffect(() => {
    clearExpiredBackups();
    void db
      .getFirstAsync<{ n: number }>("SELECT count(*) AS n FROM games")
      .then((r) => setCount(r?.n ?? 0));
    void db
      .getFirstAsync<{ value: string }>(
        "SELECT value FROM settings WHERE key='lastBackupAt'",
      )
      .then((r) => setLast(r?.value ?? ""));
    return () => {
      void clearPreparedBackup(db).catch(() => {});
    };
  }, [db]);
  useEffect(
    () => () => {
      if (output) discardBackup(output);
    },
    [output],
  );
  useEffect(() => {
    if (!busy) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => sub.remove();
  }, [busy]);
  function fail(e: unknown) {
    setError(
      e instanceof Error
        ? e.message
        : "操作できませんでした。データは変更していません。",
    );
  }
  async function exclusive<T>(label: string, run: () => Promise<T>) {
    if (dataPaused) throw new Error("別のデータ操作が終わるまでお待ちください");
    setBusy(label);
    let paused = false;
    setProgress(0);
    setError("");
    try {
      await pauseData();
      paused = true;
      return await run();
    } finally {
      if (paused) resumeData();
      setBusy("");
    }
  }
  async function out() {
    try {
      await exclusive("バックアップを書き出しています", () =>
        db.withTransactionAsync(async () => {
          setOutput(await writeBackupFile(exportBackup(db, setProgress)));
        }),
      );
    } catch (e) {
      fail(e);
    }
  }
  async function deliver(save: boolean) {
    if (!output || delivering.current) return;
    delivering.current = true;
    try {
      const confirmed = await (save ? saveBackup(output) : shareBackup(output));
      if (!confirmed) {
        setOutput(null);
        toast(
          "保存・共有は未確認です。保存先にファイルがあるか確かめてください",
        );
        return;
      }
      const now = new Date().toISOString();
      await db.runAsync(
        "INSERT INTO settings VALUES ('lastBackupAt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        now,
      );
      setLast(now);
      setOutput(null);
      toast("バックアップを書き出しました。保存先のファイルを確かめてください");
    } catch (e) {
      setOutput(null);
      fail(e);
    } finally {
      delivering.current = false;
    }
  }
  async function pick() {
    if (busy) return;
    let lines: BackupInput | null = null;
    setBusy("バックアップファイルを読み込んでいます");
    setProgress(0);
    try {
      setError("");
      lines = await pickBackup();
      if (!lines) return;
      const p = await exclusive("バックアップの中身を確かめています", () =>
        prepareBackup(db, lines!, setProgress),
      );
      if (p) setPreview(p);
    } catch (e) {
      fail(e);
    } finally {
      lines?.dispose();
      setBusy("");
    }
  }
  useEffect(() => {
    if (restore === "1")
      ask({
        title: "バックアップから復元",
        text: "前の端末で書き出したファイルを選ぶと、棋譜・解析結果・設定がこの端末に戻ります。",
        ok: "ファイルを選ぶ",
        image: "sys-backup",
        onOk: () => void pick(),
      }); /* 初回の入口だけ */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function apply(mode: "merge" | "replace") {
    if (!preview) return;
    const p = preview;
    setPreview(null);
    ask({
      title:
        mode === "replace"
          ? "このバックアップで置きかえますか"
          : "このバックアップを統合しますか",
      lead:
        mode === "replace"
          ? `${new Date(p.createdAt).toLocaleDateString("ja-JP", { dateStyle: "long" })}のバックアップ（棋譜 ${p.games}局）`
          : undefined,
      text:
        mode === "replace"
          ? `いまこの端末にある棋譜 ${count}局と設定は消えて、この内容に置きかわります。元には戻せません。`
          : `棋譜 ${p.games}局を取り込みます。同じ開始局面・指し手の棋譜は重複として省き、この端末の修正・解析・解説を保ちます。登録名は追加し、設定・学習プロフィールはこの端末の内容を優先します。`,
      ok: mode === "replace" ? "置きかえる" : "統合する",
      image: "sys-backup",
      danger: mode === "replace",
      onOk: () => {
        setPreview(null);
        void exclusive(
          "復元しています。アプリを閉じずにお待ちください",
          async () => {
            if (
              Object.values(analysis.controller.snapshot.records).some(
                (a) => a.attempt,
              ) ||
              coach.controller.busy
            )
              throw new Error(
                "解析・AIコーチの依頼が残っています。完了か中止を確認してから復元してください。",
              );
            return restoreBackup(db, p, mode, randomUUID, setProgress);
          },
        )
          .then(async (r) => {
            await app.reload();
            allowNavigation();
            navigation.dispatch({
              type: "RESET",
              payload: {
                ...navigation.getState(),
                index: 0,
                routes: [{ name: "(tabs)", key: randomUUID() }],
              },
            });
            ask({
              title: "復元しました",
              text: `棋譜 ${r.added}局を復元しました。同じ棋譜 ${r.skipped}局は省きました。\n招待コードの権利・購入情報は引き継がれません。精密解析の署名は保持しますが、端末が変わると新しいAI解説には精密解析のやり直しが必要です。保存済みの結果・解説は読めます。`,
              ok: "OK",
              single: true,
              image: "sys-backup",
            });
          })
          .catch(fail);
      },
    });
  }
  return (
    <Screen>
      <PageHeader title="バックアップと復元" />
      <PageScroll>
        <Card
          style={{
            paddingTop: 12,
            paddingHorizontal: 14,
            paddingBottom: 14,
            marginBottom: 12,
          }}
        >
          <Text style={font(900, 14, 1.4)}>バックアップを書き出す</Text>
          <Text
            style={[
              font(500, 11.5, 1.65, colors.ink2),
              { marginTop: 4, marginBottom: 12 },
            ]}
          >
            棋譜 {count}
            局、解析結果、戦法と囲いの修正、AIコーチの解説と質問の履歴、学習プロフィール、設定を、1つのファイルにまとめます。
          </Text>
          <Button
            kind="pri"
            wide
            icon="export"
            disabled={!!busy}
            onPress={() => void out()}
          >
            書き出す
          </Button>
          <Text
            style={[
              font(500, 11, 1.4, colors.ink2),
              { textAlign: "center", marginTop: 8 },
            ]}
          >
            {last
              ? `最後に書き出した日：${new Date(last).toLocaleDateString("ja-JP", { dateStyle: "long" })}`
              : "まだ書き出していません"}
          </Text>
        </Card>
        <Card
          style={{ paddingTop: 12, paddingHorizontal: 14, paddingBottom: 14 }}
        >
          <Text style={font(900, 14, 1.4)}>バックアップから復元する</Text>
          <Text
            style={[
              font(500, 11.5, 1.65, colors.ink2),
              { marginTop: 4, marginBottom: 12 },
            ]}
          >
            書き出したファイルを選ぶと、中身を確かめてから、この端末のデータを置きかえます。iPhone
            と Android の間でも、棋譜や設定を移せます。
          </Text>
          <Button
            wide
            icon="file"
            disabled={!!busy}
            onPress={() => void pick()}
          >
            ファイルを選ぶ
          </Button>
        </Card>
        <Hint>
          データはこの端末の中だけに保存されています。アカウント登録や自動の同期はありません。機種変更の前に、ここから書き出してください。
        </Hint>
        <Hint>
          端末トークン、招待コードの権利、購入情報は、バックアップには入りません。招待コードは端末ごとです。保存した結果と解説は、復元後も通信なしで読めます。
        </Hint>
        <Hint>
          ファイルには対局者名・目標・質問などの個人情報が含まれます。安全な場所に保管してください。送信中の依頼は引き継がず、新しい端末で勝手に再送しません。
        </Hint>
        {!!error && (
          <Text
            accessibilityRole="alert"
            style={font(700, 12, 1.7, colors.promoted)}
          >
            {error}
          </Text>
        )}
      </PageScroll>
      <Sheet
        auto
        visible={!!preview}
        title="バックアップの内容"
        onClose={() => {
          setPreview(null);
          void clearPreparedBackup(db);
        }}
      >
        <View style={{ alignItems: "center" }}>
          <MascotImage name="sys-backup" height={116} />
        </View>
        <Text style={font(900, 14, 1.5)}>
          {preview
            ? new Date(preview.createdAt).toLocaleDateString("ja-JP")
            : ""}
          のバックアップ
        </Text>
        <Text
          style={[font(500, 12.5, 1.7, colors.ink2), { marginVertical: 10 }]}
        >
          棋譜 {preview?.games}局・重複 {preview?.duplicates}
          局。復元する方法を選んでください。
        </Text>
        <View style={{ gap: 10 }}>
          <Button kind="pri" wide onPress={() => apply("merge")}>
            既存データと統合する
          </Button>
          <Button wide onPress={() => apply("replace")}>
            すべて置きかえる
          </Button>
        </View>
      </Sheet>
      <Sheet
        auto
        visible={!!output}
        title="バックアップを書き出す"
        onClose={() => setOutput(null)}
      >
        <Hint>
          1つのファイルにまとめました。保存先か共有先を選んでください。共有画面を閉じるだけでは保存されないことがあります。アプリを削除する前に、保存先にファイルがあるか確かめてください。
        </Hint>
        <View style={{ gap: 10 }}>
          <Button
            kind="pri"
            wide
            icon="file"
            onPress={() => void deliver(true)}
          >
            ファイルに保存
          </Button>
          {Platform.OS !== "web" && (
            <Button wide icon="export" onPress={() => void deliver(false)}>
              共有する
            </Button>
          )}
        </View>
      </Sheet>
      {!!busy && (
        <View
          accessibilityViewIsModal
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: colors.bg,
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            padding: 24,
          }}
        >
          <ActivityIndicator color={colors.ink} />
          <Text accessibilityLiveRegion="polite" style={font(700, 13, 1.7)}>
            {busy}… {progress}局
          </Text>
        </View>
      )}
    </Screen>
  );
}
