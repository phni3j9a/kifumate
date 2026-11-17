import { useRef, useState, type ReactNode } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import type { Record as ShogiRecord } from "tsshogi";
import { Icon, type IconName } from "../components/icons";
import { KifHelpLink } from "../components/kif-help";
import { toast } from "../components/overlay";
import { colors, font, line } from "../components/theme";
import {
  Button,
  Card,
  Hint,
  KifArea,
  NoticeCard,
  PageHeader,
  PageScroll,
  Screen,
  Segmented,
  TextButton,
  s as ui,
} from "../components/ui";
import { dateLong } from "../core/format";
import {
  decodeKif,
  describe,
  gameOutcome,
  matchNames,
  MAX_BYTES,
  outcomeText,
  readKif,
  resultFor,
  type Side,
} from "../core/kif";
import { useAnalysis } from "../analysis/provider";
import { analysisInput } from "../analysis/display";
import type { Mode } from "../analysis/types";
import { findDuplicate, importGame, listAliases } from "../storage/repository";

// input は読み取った本文。今の入力と同じときだけ、この結果で保存できる。
type Preview =
  | { input: string; error: string }
  | {
      input: string;
      record: ShogiRecord;
      auto: Side;
      ambiguous: boolean;
      names: number;
      duplicate: string | null;
    };
/** 読み取り結果の1行（.vl）。tone は丸の色（.ck / .ck.wn） */
function Line({
  icon = "check",
  warn = false,
  title,
  children,
}: {
  icon?: IconName;
  warn?: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <View style={s.vl}>
      <View style={[s.ck, warn && { backgroundColor: colors.orange }]}>
        <Icon name={icon} size={11} strokeWidth={3.2} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={font(900, 13, 1.4)}>{title}</Text>
        {children}
      </View>
    </View>
  );
}
const body = font(500, 11.5, 1.55, colors.ink2);

export default function Import() {
  const { quota, offline, controller } = useAnalysis();
  const [mode, setMode] = useState<Mode>("precise");
  const db = useSQLiteContext();
  const [tab, setTab] = useState<"paste" | "file">("paste"),
    [text, setText] = useState(""),
    [file, setFile] = useState<{ name: string; text: string } | null>(null),
    [view, setView] = useState<Preview | null>(null),
    // undefined＝まだ選んでいない、null＝自分ではない
    [pick, setPick] = useState<Side | undefined>(undefined),
    [busy, setBusy] = useState(false);
  const job = useRef(0);
  // 入力が変わるたびに読み取り直す。貼り付け・入力中は少し待ってからまとめて読む。
  function read(input: string, wait = 0) {
    const id = ++job.current;
    setPick(undefined);
    if (!input.trim()) {
      setView(null);
      return;
    }
    setTimeout(async () => {
      if (id !== job.current) return;
      let next: Preview;
      try {
        const record = readKif(input),
          d = describe(record),
          names = await listAliases(db),
          match = matchNames(
            d.black,
            d.white,
            names.map((n) => n.name),
          );
        next = {
          input,
          record,
          auto: match.side,
          ambiguous: match.ambiguous,
          names: names.length,
          duplicate: await findDuplicate(db, record),
        };
      } catch (e) {
        next = {
          input,
          error: e instanceof Error ? e.message : "読み取れませんでした。",
        };
      }
      if (id === job.current) setView(next);
    }, wait);
  }
  function fail(e: unknown, fallback: string) {
    job.current++;
    setPick(undefined);
    setView({ input: "", error: e instanceof Error ? e.message : fallback });
  }
  async function paste() {
    try {
      const pasted = await Clipboard.getStringAsync();
      if (!pasted.trim()) {
        toast("クリップボードに文字がありません");
        return;
      }
      setText(pasted);
      read(pasted);
    } catch {
      toast("貼り付けできませんでした。入力欄に貼り付けてください");
    }
  }
  async function choose() {
    try {
      let buffer: ArrayBuffer, name: string;
      if (Platform.OS === "web") {
        const picked = await DocumentPicker.getDocumentAsync({
          type: "*/*",
          base64: false,
        });
        if (picked.canceled) return;
        const asset = picked.assets[0]!;
        if ((asset.size ?? 0) > MAX_BYTES)
          throw new Error("ファイルは2MB以内にしてください。");
        buffer = await asset.file!.arrayBuffer();
        name = asset.name;
      } else {
        // File自身のピッカーで読み取り権限を受け取る（共有キャッシュのパスに依存しない）。
        const picked = await File.pickFileAsync({ mimeTypes: ["*/*"] });
        if (picked.canceled) return;
        if (picked.result.size > MAX_BYTES)
          throw new Error("ファイルは2MB以内にしてください。");
        buffer = await picked.result.arrayBuffer();
        name = picked.result.name;
      }
      const decoded = decodeKif(new Uint8Array(buffer));
      setFile({ name, text: decoded });
      read(decoded);
    } catch (e) {
      setFile(null);
      fail(e, "ファイルを開けませんでした。");
    }
  }
  const ok = view && "record" in view ? view : null;
  // 入力を変えた瞬間から、読み取りと照合が終わるまでは前の結果で保存しない
  const fresh = view?.input === (tab === "paste" ? text : (file?.text ?? ""));
  const side = pick !== undefined ? pick : (ok?.auto ?? null);
  const decided = pick !== undefined || !!ok?.auto;
  async function save(analyze = false) {
    if (!ok || !fresh || !decided || busy) return;
    setBusy(true);
    try {
      const saved = await importGame(
        db,
        ok.record,
        side,
        resultFor(side, gameOutcome(ok.record)),
        // 登録名どおりの自動判定をそのまま使うときだけ、あとの再照合の対象にする。
        !(ok.auto && side === ok.auto),
        false,
      );
      if (saved.duplicate) setView({ ...ok, duplicate: saved.id });
      else {
        router.replace({ pathname: "/game/[id]", params: { id: saved.id } });
        toast("保存しました");
        if (analyze)
          void controller
            .start(
              saved.id,
              analysisInput(ok.record, quota?.paid ? mode : "std"),
            )
            .catch(() =>
              toast("棋譜は保存しましたが、解析を依頼できませんでした"),
            );
      }
    } catch {
      toast("棋譜を保存できませんでした。もう一度お試しください");
    } finally {
      setBusy(false);
    }
  }
  const d = ok ? describe(ok.record) : null;
  const who = d && (
    <View style={{ marginTop: 6 }}>
      <Segmented
        label="あなたはどちら"
        options={[
          ["black", `☗ ${d.black}`],
          ["white", `☖ ${d.white}`],
          ["none", "自分ではない"],
        ]}
        value={!decided ? null : (side ?? "none")}
        onChange={(v) => setPick(v === "none" ? null : v)}
      />
    </View>
  );
  return (
    <Screen>
      <PageHeader close title="棋譜を取り込む" />

      <PageScroll>
        <Segmented
          options={[
            ["paste", "テキスト"],
            ["file", "ファイル"],
          ]}
          value={tab}
          onChange={(next) => {
            setTab(next);
            read(next === "paste" ? text : (file?.text ?? ""));
          }}
        />
        {tab === "paste" ? (
          <View style={{ marginTop: 10 }}>
            <KifArea
              accessibilityLabel="KIF形式の棋譜"
              placeholder="KIF形式の棋譜をここに貼り付けます"
              value={text}
              invalid={!!view && "error" in view}
              onChangeText={(t) => {
                setText(t);
                read(t, 250);
              }}
            />
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
              <Button size="sm" icon="paste" onPress={() => void paste()}>
                クリップボードから貼り付け
              </Button>
              {text ? (
                <Button
                  size="sm"
                  onPress={() => {
                    setText("");
                    read("");
                  }}
                >
                  消す
                </Button>
              ) : null}
            </View>
          </View>
        ) : (
          <View style={s.fpick}>
            {file ? (
              <>
                <View style={s.fchip}>
                  <Icon name="file" size={14} />
                  <Text
                    numberOfLines={1}
                    style={[font(700, 12), { flexShrink: 1 }]}
                  >
                    {file.name}
                  </Text>
                </View>
                <TextButton onPress={() => void choose()}>
                  ほかのファイルを選ぶ
                </TextButton>
              </>
            ) : (
              <>
                <Button size="sm" icon="file" onPress={() => void choose()}>
                  ファイルを選ぶ
                </Button>
                <Text style={font(500, 11.5, 1.6, colors.ink2)}>
                  .kif / .kifu のファイルを選べます
                </Text>
              </>
            )}
          </View>
        )}
        {!view ? (
          <>
            <Hint>
              対局サービスへのログインや連携は要りません。棋譜のテキストかファイルがあれば取り込めます。
            </Hint>
            <View style={s.lnk}>
              <KifHelpLink />
            </View>
          </>
        ) : "error" in view ? (
          <>
            <NoticeCard
              kind="bad"
              image="sys-invalid"
              title="棋譜として読み取れませんでした"
              detail={view.error}
            />
            <View style={s.lnk}>
              <KifHelpLink />
            </View>
          </>
        ) : (
          <>
            <Card style={s.vr}>
              <Line title="棋譜を読み取れました">
                <View style={{ marginTop: 3, gap: 2 }}>
                  {[
                    ["日付", dateLong(d!.date)],
                    ["先手", `☗ ${d!.black}`],
                    ["後手", `☖ ${d!.white}`],
                    ["結果", outcomeText(view.record)],
                  ].map(([label, value]) => (
                    <View key={label} style={{ flexDirection: "row", gap: 8 }}>
                      <Text style={font(900, 10, 1.8, colors.ink2)}>
                        {label}
                      </Text>
                      <Text style={[font(700, 12, 1.5), { flex: 1 }]}>
                        {value}
                      </Text>
                    </View>
                  ))}
                </View>
              </Line>
              {view.duplicate ? null : (
                <>
                  <View style={ui.hairTop}>
                    {!decided ? (
                      <Line warn icon="info" title="あなたはどちらですか？">
                        <Text style={body}>
                          {view.ambiguous
                            ? "先手と後手のどちらも、登録した名前に当てはまります。"
                            : view.names
                              ? "登録した名前に当てはまる対局者がいません。"
                              : "対局者名がまだ登録されていません。"}
                        </Text>
                        {who}
                      </Line>
                    ) : !side ? (
                      <Line title="自分の対局ではない">
                        <Text style={body}>
                          保存と再生はできます。戦績には数えません。
                        </Text>
                        {who}
                      </Line>
                    ) : (
                      <Line
                        title={`あなたは${side === "black" ? "先手" : "後手"}`}
                      >
                        <Text style={body}>
                          {side === view.auto
                            ? `登録した名前「${side === "black" ? d!.black : d!.white}」と一致しました。`
                            : "手で指定しました。"}
                        </Text>
                        {who}
                      </Line>
                    )}
                  </View>
                  <View style={ui.hairTop}>
                    <Line title="重複はありません">
                      <Text style={body}>
                        保存済みの棋譜に、同じ対局は見つかりませんでした。
                      </Text>
                    </Line>
                  </View>
                </>
              )}
            </Card>
            {view.duplicate ? (
              <NoticeCard
                kind="warn"
                image="sys-duplicate"
                title="同じ棋譜がすでに保存されています"
                detail="二重に保存すると戦績も二重に数えられるため、取り込みません。"
              />
            ) : null}
            <View style={{ marginTop: 16 }}>
              {view.duplicate ? (
                <Button
                  kind="pri"
                  wide
                  disabled={!fresh}
                  onPress={() =>
                    router.replace({
                      pathname: "/game/[id]",
                      params: { id: view.duplicate! },
                    })
                  }
                >
                  保存済みの棋譜を開く
                </Button>
              ) : (
                <View style={{ gap: 10 }}>
                  {quota?.paid && (
                    <Segmented
                      label="解析の種類"
                      options={[
                        [
                          "precise",
                          `精密解析（今週あと${Math.min(quota.totalRemaining, quota.preciseRemaining)}局）`,
                        ],
                        ["std", "ふつうの解析"],
                      ]}
                      value={mode}
                      onChange={setMode}
                    />
                  )}
                  {(!quota || quota.totalRemaining > 0) && (
                    <>
                      <Button
                        kind="pri"
                        wide
                        disabled={
                          !fresh ||
                          !decided ||
                          busy ||
                          offline ||
                          (mode === "precise" &&
                            !!quota?.paid &&
                            quota.preciseRemaining === 0)
                        }
                        onPress={() => void save(true)}
                      >
                        保存して解析する
                      </Button>
                      <Text style={font(500, 11, 1.5, colors.ink2)}>
                        {offline
                          ? "通信できません。解析はつながってから始められます"
                          : quota?.paid && mode === "precise"
                            ? "精密解析を1局分使います（候補3手・深い読み）"
                            : "候補1手です"}
                      </Text>
                    </>
                  )}
                  <Button
                    wide
                    disabled={!fresh || !decided || busy}
                    onPress={() => void save()}
                  >
                    保存だけする
                  </Button>
                </View>
              )}
            </View>
          </>
        )}
      </PageScroll>
    </Screen>
  );
}
const s = StyleSheet.create({
  fpick: {
    alignItems: "center",
    gap: 10,
    marginTop: 10,
    paddingVertical: 22,
    paddingHorizontal: 12,
    borderWidth: line.ol,
    borderStyle: "dashed",
    borderColor: colors.dash,
    borderRadius: 16,
  },
  fchip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: "100%",
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: colors.sand,
  },
  lnk: { flexDirection: "row", marginTop: 6 },
  vr: { marginTop: 12, paddingTop: 4, paddingHorizontal: 12, paddingBottom: 6 },
  vl: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 9,
    paddingVertical: 8,
  },
  ck: {
    width: 20,
    height: 20,
    marginTop: 1,
    borderRadius: 10,
    borderWidth: line.thin,
    borderColor: colors.ink,
    backgroundColor: colors.mint,
    alignItems: "center",
    justifyContent: "center",
  },
});
