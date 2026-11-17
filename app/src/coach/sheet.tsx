import { useRef, useState, type ComponentRef } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { randomUUID } from "expo-crypto";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Color, Position } from "tsshogi";
import type { Game } from "../storage/repository";
import { listAliases } from "../storage/repository";
import { useSQLiteContext } from "expo-sqlite";
import { useAnalysis } from "../analysis/provider";
import { readingText, scoreText } from "../analysis/display";
import {
  Button,
  Hint,
  MascotImage,
  RoundButton,
  TextButton,
} from "../components/ui";
import { ask, toast } from "../components/overlay";
import { Icon } from "../components/icons";
import { colors, font, line, radius, shadow } from "../components/theme";
import { useCoach, setCoachVisible } from "./provider";
import { coachInput } from "./privacy";
import { StylePicker } from "./style-picker";
import {
  quotaNotice,
  type Message,
  type Reference,
  type Section,
} from "./types";
export function CoachSheet({
  game,
  onClose,
  halfTop,
  fullTop,
  ply,
  branch,
  start,
  jump,
  tryLine,
  onFullChange,
}: {
  game: Game;
  onClose: () => void;
  halfTop: number;
  fullTop: number;
  ply: number;
  branch: boolean;
  start: () => void;
  jump: (p: number) => void;
  tryLine: (p: number, pv: string[]) => void;
  onFullChange: (full: boolean) => void;
}) {
  const db = useSQLiteContext(),
    insets = useSafeAreaInsets(),
    { height } = useWindowDimensions();
  const { records, overview, profile, offline, controller } = useCoach();
  const { records: analyses, quota: analysisQuota } = useAnalysis();
  const analysis = analyses[game.id],
    saved = analysis?.saved,
    r = records[game.id];
  const [full, setFull] = useState(false),
    [setup, setSetup] = useState(false),
    [style, setStyle] = useState(profile.style),
    [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  useFocusEffect(
    useCallback(() => {
      setCoachVisible(game.id, true);
      void controller.sync();
      return () => setCoachVisible(game.id, false);
    }, [controller, game.id]),
  );
  const answers = r?.answers ?? [],
    attempt = r?.attempt;
  const paid = overview?.paid ?? analysisQuota?.paid ?? false;
  const q = overview?.quota ?? null,
    limit = !!q && q.remaining === 0;
  const hasAnswers = answers.length > 0;
  const stage = attempt
    ? "gen"
    : hasAnswers && !setup
      ? "ready"
      : !paid
        ? "lock"
        : analysis?.attempt || !saved
          ? "need"
          : saved.mode !== "precise" ||
              !saved.coachProof ||
              r?.error?.includes("精密解析の証明")
            ? "redo"
            : limit
              ? "cap"
              : "setup";
  const face =
    stage === "gen"
      ? "chat-thinking"
      : stage === "ready"
        ? "chat-explaining"
        : stage === "setup"
          ? "chat-listening"
          : "chat-default";
  async function send(text?: string) {
    if (sending || controller.busy) {
      toast("別の解説や質問を作っています。終わってからお試しください");
      return;
    }
    if (
      !saved ||
      saved.mode !== "precise" ||
      !saved.coachProof ||
      analysis?.attempt
    ) {
      toast("先に、この対局の精密解析が必要です");
      return;
    }
    setSending(true);
    try {
      const aliases = (await listAliases(db)).map((a) => a.name);
      const history: Message[] =
        text === undefined
          ? []
          : answers.flatMap((a) => [
              ...(a.question
                ? [{ role: "user" as const, content: a.question }]
                : []),
              {
                role: "assistant" as const,
                content: a.sections
                  .map((s) => `${s.title}\n${s.text}`)
                  .join("\n\n"),
              },
            ]);
      await controller.start(
        game.id,
        coachInput(
          randomUUID(),
          saved,
          game,
          aliases,
          profile,
          text === undefined ? style : answers[0]!.style,
          history,
          text,
        ),
      );
      setQuestion("");
      setSetup(false);
      if (text) scroll.current?.scrollToEnd({ animated: true });
    } catch {
      toast("依頼を保存できませんでした。もう一度お試しください");
    } finally {
      setSending(false);
    }
  }
  function cancel() {
    ask({
      title: "解説の作成を中止しますか",
      text: "中止した解説や質問は、回数に数えません。すでに完成した場合は、その解説を受け取ります。",
      ok: "中止する",
      no: "続ける",
      onOk: () =>
        void controller
          .cancel(game.id)
          .catch(() => toast("中止を保存できませんでした")),
    });
  }
  const notice = quotaNotice(q);
  const retry = () => {
    if (attempt) void controller.sync();
    else void send(r?.failedQuestion);
  };
  const pendingQuestion = attempt?.input.question;
  const statusTitle =
    stage === "lock"
      ? "AIコーチは有料プランの機能です"
      : stage === "cap"
        ? "今月のAIコーチは上限に達しました"
        : stage === "redo"
          ? "AIコーチは、精密解析した対局で使えます"
          : analysis?.attempt
            ? "解析しています"
            : "先に、この対局の精密解析が必要です";
  const statusDetail =
    stage === "lock"
      ? "解析結果をもとに、対局の流れと改善点を文章で説明します。続けて質問もできます。"
      : stage === "cap"
        ? "月が変わると、また使えます。これまでに作った解説は、そのまま読めます。"
        : stage === "redo"
          ? saved?.coachProof
            ? "この対局は「ふつうの解析」です。精密解析でやり直すと、候補が3手まで出て、解説も作れます。"
            : "この対局の精密解析の証明がありません。精密解析でやり直すと、解説を作れます。"
          : analysis?.attempt
            ? analysis.attempt.mode === "precise"
              ? "解析が終わると、ここで解説を作れます。"
              : "ふつうの解析をしています。AIコーチは、精密解析した対局で使えます。"
            : "AIコーチは、精密解析で出た評価値・候補手・詰みをもとに説明します。";
  return (
    <KeyboardAvoidingView
      testID="coach-sheet"
      accessibilityViewIsModal
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[
        s.sheet,
        {
          top: Math.min(
            Math.max(
              insets.top + (full ? fullTop : halfTop),
              full ? height * 0.08 : 0,
            ),
            height - 250,
          ),
          paddingBottom: insets.bottom,
        },
      ]}
    >
      <View style={s.header}>
        <View style={{ marginLeft: -4 }}>
          <MascotImage name={face} height={30} />
        </View>
        <Text accessibilityRole="header" style={font(900, 15)}>
          AIコーチ
        </Text>
        <View style={{ flex: 1 }} />
        {stage === "ready" && paid && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="解説スタイルを変更"
            onPress={() => {
              if (limit) {
                toast(notice);
                return;
              }
              setStyle(answers[0]!.style);
              setSetup(true);
            }}
            style={s.style}
          >
            <Icon name="filter" size={12} />
            <Text style={font(700, 11)}>
              {answers[0]!.style.focus}・{answers[0]!.style.detail}
            </Text>
          </Pressable>
        )}
        <RoundButton
          icon={full ? "down" : "expand"}
          label={full ? "小さくする" : "大きくする"}
          onPress={() => {
            setFull(!full);
            onFullChange(!full);
          }}
        />
        <RoundButton icon="x" label="AIコーチを閉じる" onPress={onClose} />
      </View>
      <ScrollView
        ref={scroll}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingTop: 8,
          paddingHorizontal: 12,
          paddingBottom: 10,
        }}
      >
        {(offline || r?.error) && (
          <View accessibilityLiveRegion="polite" style={s.error}>
            <Text style={font(700, 12, 1.6)}>
              {offline
                ? "通信できません。保存済みの解説は読めます。つながってから、もう一度試してください。"
                : r?.error}
            </Text>
            <TextButton onPress={retry}>もう一度試す</TextButton>
          </View>
        )}
        {stage === "setup" && (
          <>
            <StylePicker value={style} onChange={setStyle} />
            <View style={s.profile}>
              <View style={{ flex: 1 }}>
                <Text style={font(900, 11.5, 1.4)}>学習プロフィール</Text>
                <Text style={font(500, 11, 1.5, colors.ink2)}>
                  練習中：{profile.practice.join("・") || "なし"}
                  {profile.goal ? `\n目標：${profile.goal}` : ""}
                </Text>
              </View>
              <TextButton onPress={() => router.push("/profile")}>
                変更
              </TextButton>
            </View>
            {hasAnswers && (
              <Hint>
                作り直すと、いまの解説と質問の履歴は新しいものに置きかわります。
              </Hint>
            )}
          </>
        )}
        {stage === "gen" && pendingQuestion === undefined && (
          <>
            <Text
              style={[font(900, 12, 1.3), { marginTop: 2, marginBottom: 7 }]}
            >
              解説を作っています…
            </Text>
            {[100, 100, 100, 62, 100, 80].map((w, i) => (
              <View
                key={i}
                style={{
                  height: 11,
                  marginTop: i === 4 ? 20 : 9,
                  marginHorizontal: 2,
                  borderRadius: 6,
                  backgroundColor: colors.skeleton,
                  width: `${w}%`,
                  maxWidth: "99%",
                }}
              />
            ))}
            <Hint>
              解説を作っています。画面を離れても続きます。通常は40秒ほど、長いときは1〜2分かかります。
            </Hint>
          </>
        )}
        {(stage === "ready" ||
          (stage === "gen" && pendingQuestion !== undefined)) && (
          <>
            {answers.map((a, i) => (
              <View key={a.requestId}>
                {a.question && (
                  <Text selectable style={s.question}>
                    {a.question}
                  </Text>
                )}
                <View style={a.question ? s.chat : undefined}>
                  {a.question && (
                    <MascotImage name="chat-explaining" height={28} />
                  )}
                  <View style={{ flex: 1 }}>
                    {a.sections.map((section, j) => (
                      <SectionView
                        key={j}
                        section={section}
                        saved={saved}
                        self={
                          game.self_side === "white" ? Color.WHITE : Color.BLACK
                        }
                        jump={(p) => {
                          setFull(false);
                          onFullChange(false);
                          jump(p);
                        }}
                        tryLine={(p, pv) => {
                          onClose();
                          tryLine(p, pv);
                        }}
                      />
                    ))}
                  </View>
                </View>
                {i === 0 && (
                  <Text
                    style={[
                      font(500, 11, 1.6, colors.ink2),
                      { marginHorizontal: 2, marginBottom: 10 },
                    ]}
                  >
                    数字と指し手は、解析結果のままです。説明の文章はAIが書いています。
                  </Text>
                )}
              </View>
            ))}
            {pendingQuestion !== undefined && (
              <>
                <Text style={s.question}>{pendingQuestion}</Text>
                <View style={s.chat}>
                  <MascotImage name="chat-thinking" height={28} />
                  <Text style={font(700, 12, 1.7)}>
                    考えています… 画面を離れても続きます。
                  </Text>
                </View>
              </>
            )}
            {stage === "ready" && paid && !limit && (
              <View style={{ gap: 6, marginTop: 4 }}>
                {[
                  "いまの局面について教えて",
                  "詰みがあった局面を教えて",
                  "次に何を練習するといい？",
                ]
                  .filter((t) => !answers.some((a) => a.question === t))
                  .map((t) => (
                    <Pressable
                      key={t}
                      accessibilityRole="button"
                      onPress={() => {
                        if (branch && t.startsWith("いま")) {
                          toast(
                            "分岐の局面は解説できません。本譜に戻ってから質問してください",
                          );
                          return;
                        }
                        void send(
                          t.startsWith("いま")
                            ? ply
                              ? `${ply}手目の局面について教えて`
                              : "開始局面について教えて"
                            : t,
                        );
                      }}
                      style={s.suggestion}
                    >
                      <Text style={font(700, 11.5, 1.3)}>{t}</Text>
                    </Pressable>
                  ))}
              </View>
            )}
          </>
        )}
        {["lock", "need", "redo", "cap"].includes(stage) && (
          <View style={s.lock}>
            <MascotImage
              name={
                stage === "lock"
                  ? "onb-5"
                  : stage === "cap"
                    ? "sys-limit"
                    : "chat-default"
              }
              height={stage === "lock" || stage === "cap" ? 104 : 64}
            />
            <Text style={[font(700, 13.5, 1.4), { textAlign: "center" }]}>
              {statusTitle}
            </Text>
            <Text
              style={[
                font(500, 11.5, 1.6, colors.ink2),
                { textAlign: "center", maxWidth: 322 },
              ]}
            >
              {statusDetail}
            </Text>
          </View>
        )}
      </ScrollView>
      {(!!notice ||
        stage === "setup" ||
        stage === "gen" ||
        stage === "lock" ||
        (stage === "ready" && !paid) ||
        (["need", "redo"].includes(stage) && !analysis?.attempt)) && (
        <View style={s.footer}>
          {!!notice && (
            <Text
              style={[
                font(700, 11.5, 1.5, colors.ink2),
                { textAlign: "center", marginBottom: 6 },
              ]}
            >
              {notice}
            </Text>
          )}
          {stage === "gen" && (
            <TextButton onPress={cancel}>
              {attempt?.cancel ? "中止を確認しています…" : "中止"}
            </TextButton>
          )}
          {stage === "setup" && (
            <>
              <Button
                wide
                kind="pri"
                icon="spark"
                disabled={sending}
                onPress={() => void send()}
              >
                {hasAnswers ? "このスタイルで作り直す" : "解説をつくる"}
              </Button>
              {hasAnswers && (
                <TextButton onPress={() => setSetup(false)}>
                  いまの解説に戻る
                </TextButton>
              )}
            </>
          )}
          {(stage === "need" || stage === "redo") && !analysis?.attempt && (
            <>
              {analysisQuota?.preciseRemaining === 0 ? (
                <Text style={font(700, 11.5, 1.5, colors.ink2)}>
                  今週の精密解析は残り0局です。
                  {new Date(analysisQuota.resetsAt).toLocaleString("ja-JP", {
                    timeZone: "Asia/Tokyo",
                  })}
                  に、また使えます。
                </Text>
              ) : (
                <>
                  <Text
                    style={[
                      font(700, 11.5, 1.5, colors.ink2),
                      { marginBottom: 6 },
                    ]}
                  >
                    精密解析を1局分使います
                    {analysisQuota
                      ? `（今週あと${analysisQuota.preciseRemaining}局）`
                      : ""}
                  </Text>
                  <Button wide kind="pri" onPress={start}>
                    {stage === "redo" ? "精密解析でやり直す" : "精密解析する"}
                  </Button>
                </>
              )}
            </>
          )}
          {(stage === "lock" || (stage === "ready" && !paid)) && (
            <Button
              wide
              kind="pri"
              onPress={() =>
                ask({
                  title: "有料プランは準備中です",
                  text: "精密解析・分岐中の解析・AIコーチが使えるプランを準備しています。購入はまだできません。",
                  ok: "閉じる",
                  single: true,
                })
              }
            >
              有料プランを見る
            </Button>
          )}
        </View>
      )}
      {stage === "ready" && paid && !limit && (
        <View style={s.inputRow}>
          <TextInput
            accessibilityLabel="AIコーチへの質問"
            placeholder="この対局について質問する"
            value={question}
            onChangeText={setQuestion}
            maxLength={1000}
            onSubmitEditing={() => {
              if (question.trim()) void send(question.trim());
            }}
            style={s.input}
          />
          <RoundButton
            icon="send"
            style={{ backgroundColor: colors.mint }}
            label="質問を送る"
            disabled={!question.trim() || sending || controller.busy}
            onPress={() => void send(question.trim())}
          />
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
function SectionView({
  section,
  saved,
  self,
  jump,
  tryLine,
}: {
  section: Section;
  saved: ReturnType<typeof useAnalysis>["records"][string]["saved"] | undefined;
  self: Color;
  jump: (p: number) => void;
  tryLine: (p: number, pv: string[]) => void;
}) {
  return (
    <View
      style={[
        s.section,
        section.kind === "advice" && { backgroundColor: colors.advice },
      ]}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          marginBottom: 5,
        }}
      >
        <Text
          accessibilityRole="header"
          style={[font(900, 12.5, 1.3), { flexShrink: 1 }]}
        >
          {section.title}
        </Text>
        <Text
          style={[
            font(700, 10.5, 1),
            {
              marginLeft: "auto",
              borderWidth: line.thin,
              borderColor: colors.ink,
              borderRadius: radius.pill,
              paddingHorizontal: 7,
              paddingTop: 3,
              paddingBottom: 4,
              backgroundColor:
                section.kind === "advice" ? colors.mint : colors.sand,
            },
          ]}
        >
          {section.kind === "advice"
            ? "学習プロフィールにもとづく助言"
            : "解析結果にもとづく説明"}
        </Text>
      </View>
      <Text selectable style={font(500, 12.5, 1.7)}>
        {section.text}
      </Text>
      {section.references.map((ref, i) => (
        <ReferenceView
          key={`${ref.id}-${i}`}
          reference={ref}
          saved={saved}
          self={self}
          jump={jump}
          tryLine={tryLine}
        />
      ))}
    </View>
  );
}
function ReferenceView({
  reference: r,
  saved,
  self,
  jump,
  tryLine,
}: {
  reference: Reference;
  saved: ReturnType<typeof useAnalysis>["records"][string]["saved"] | undefined;
  self: Color;
  jump: (p: number) => void;
  tryLine: (p: number, pv: string[]) => void;
}) {
  const position = new Position();
  let words: string[] = [];
  if (
    saved &&
    position.resetBySFEN(
      saved.initial === "startpos" ? new Position().sfen : saved.initial,
    )
  ) {
    for (const usi of saved.moves.slice(0, r.ply)) {
      const m = position.createMoveByUSI(usi);
      if (!m || !position.doMove(m)) break;
    }
    words = readingText(position, r.pv);
  }
  return (
    <View style={{ marginTop: 6, gap: 5 }}>
      <Pressable
        accessibilityRole="button"
        onPress={() => jump(r.ply)}
        style={s.reference}
      >
        <Text style={font(700, 11, 1.4)}>
          {r.ply ? `${r.ply}手目の局面` : "開始局面"}　評価値{" "}
          {scoreText(r.score, self)}
          {r.provenMate ? "・詰みあり" : ""}
        </Text>
      </Pressable>
      {words.length > 0 && (
        <>
          <Text selectable style={font(500, 11.5, 1.7)}>
            {words.join(" ")}
          </Text>
          <TextButton onPress={() => tryLine(r.ply, r.pv)}>
            この読み筋を試す
          </TextButton>
        </>
      )}
    </View>
  );
}
const s = StyleSheet.create({
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 5,
    backgroundColor: colors.bg,
    borderTopWidth: line.ol,
    borderColor: colors.ink,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
  },
  header: {
    height: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 14,
    paddingRight: 10,
  },
  style: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    borderWidth: line.thin,
    borderColor: colors.ink,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
    boxShadow: shadow.small,
  },
  lock: {
    alignItems: "center",
    gap: 6,
    paddingTop: 18,
    paddingHorizontal: 10,
    paddingBottom: 8,
  },
  footer: {
    alignItems: "center",
    gap: 2,
    paddingTop: 8,
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderColor: colors.hair,
  },
  profile: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginVertical: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: line.thin,
    borderStyle: "dashed",
    borderColor: colors.dash,
    borderRadius: 12,
  },
  section: {
    marginBottom: 9,
    paddingVertical: 9,
    paddingHorizontal: 11,
    backgroundColor: colors.white,
    borderWidth: line.ol,
    borderColor: colors.ink,
    borderRadius: radius.field,
  },
  reference: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.sand,
  },
  question: {
    ...font(700, 12.5, 1.5, colors.white),
    alignSelf: "flex-end",
    maxWidth: "86%",
    marginTop: 10,
    marginBottom: 6,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderBottomRightRadius: 4,
    backgroundColor: colors.ink,
  },
  chat: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 7,
    marginBottom: 9,
  },
  suggestion: {
    alignSelf: "flex-start",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: line.thin,
    borderColor: colors.ink,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 7,
    paddingHorizontal: 10,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderColor: colors.hair,
  },
  input: {
    ...font(500, 16),
    lineHeight: undefined,
    flex: 1,
    minWidth: 0,
    height: 38,
    paddingHorizontal: 14,
    borderWidth: line.ol,
    borderColor: colors.ink,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
  },
  error: {
    alignItems: "flex-start",
    padding: 10,
    gap: 4,
    backgroundColor: colors.warnCard,
    borderRadius: radius.field,
    marginBottom: 8,
  },
});
