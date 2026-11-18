import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentRef,
} from "react";
import {
  AccessibilityInfo,
  Animated,
  BackHandler,
  Image,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  ScrollView,
  Text,
  View,
} from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import { useCoach } from "../coach/provider";
import { practices } from "../coach/types";
import { useAppData } from "../components/data-provider";
import { Icon } from "../components/icons";
import { toast } from "../components/overlay";
import {
  Button,
  Chip,
  Hint,
  Input,
  mascots,
  RoundButton,
  Screen,
  TextButton,
  type Mascot,
} from "../components/ui";
import { colors, font, line, radius, shadow } from "../components/theme";
import { listAliases, saveAliases } from "../storage/repository";
const scenes = [
  [
    "kifumateへ ようこそ",
    "指した将棋を取り込んで、形勢がどこで動いたかを振り返るアプリです。できることを順に紹介します。",
  ],
  [
    "棋譜を取り込む",
    "KIF形式の棋譜を、貼り付けるかファイルを選んで取り込みます。対局サービスへのログインは要りません。",
  ],
  [
    "形勢グラフを読む",
    "解析すると、形勢の動きがグラフになります。線が上にあるほど、あなたが有利です。印をタップすると、その手に移ります。",
  ],
  [
    "分岐を試す",
    "盤の駒を動かして、「こう指していたら？」を確かめられます。本譜（実際に指した手順）や戦績は変わりません。",
  ],
  [
    "コーチに質問",
    "解析結果をもとに、AIコーチが対局を言葉で解説します。気になったことは、続けて質問できます。",
  ],
  [
    "目標を決める",
    "練習中の戦法と目標を教えてください。コーチ（有料プラン）の解説に反映します。",
  ],
  ["さあ、はじめよう", "準備ができました。まずは1局、取り込んでみましょう。"],
] as const;
export default function Onboarding() {
  const db = useSQLiteContext(),
    app = useAppData(),
    coach = useCoach(),
    replay = app.completed;
  const [step, setStep] = useState(0),
    [name, setName] = useState(""),
    [practice, setPractice] = useState<string[]>([]),
    [goal, setGoal] = useState(""),
    [saving, setSaving] = useState(false);
  const [x] = useState(() => new Animated.Value(0));
  const initialized = useRef(false),
    scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  useEffect(() => {
    if (coach.ready && !initialized.current) {
      initialized.current = true;
      setPractice([...coach.profile.practice]);
      setGoal(coach.profile.goal);
    }
  }, [coach.ready, coach.profile]);
  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
  }, [step]);
  function go(direction: number) {
    if (step + direction < 0 || step + direction > 6 || saving) return;
    setStep(step + direction);
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (reduce) return;
      x.setValue(direction * 28);
      Animated.timing(x, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }).start();
    });
  }
  const swipe = PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) =>
      Math.abs(g.dx) > 48 && Math.abs(g.dy) < 30,
    onPanResponderRelease: (_, g) => {
      if (Math.abs(g.dx) > 48 && Math.abs(g.dy) < 60) go(g.dx < 0 ? 1 : -1);
    },
  });
  async function finish(toImport: boolean) {
    if (saving || !coach.ready) return;
    setSaving(true);
    try {
      const n = name.trim();
      if (n)
        await saveAliases(db, [
          ...(await listAliases(db)).map((a) => a.name),
          n,
        ]);
      await coach.controller.setProfile({
        ...coach.profile,
        practice,
        goal: goal.trim(),
      });
      await app.complete();
      if (replay && !toImport) router.back();
      else router.replace(toImport ? "/import" : "/");
    } catch {
      toast("保存できませんでした。もう一度お試しください");
      setSaving(false);
    }
  }
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        if (saving) return true;
        if (step > 0) {
          setStep(step - 1);
          return true;
        }
        return false;
      });
      return () => sub.remove();
    }, [step, saving]),
  );
  const last = step === 6,
    scene = scenes[step]!,
    image = mascots[`onb-${step + 1}` as Mascot];
  const alt =
    step === 0
      ? replay
        ? ""
        : "バックアップから復元する"
      : step === 5
        ? "あとで決める"
        : last
          ? replay
            ? "閉じる"
            : "あとで"
          : "";
  return (
    <Screen bottom>
      <View
        style={{
          height: 50,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 14,
        }}
      >
        <View style={{ width: 84 }}>
          {step ? (
            <RoundButton
              icon="prev"
              label="前へ"
              disabled={saving}
              onPress={() => go(-1)}
            />
          ) : (
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 7 }}
            >
              <Image
                source={require("../assets/app-icon.png")}
                style={{
                  width: 28,
                  height: 28,
                  borderWidth: line.ol,
                  borderColor: colors.ink,
                  borderRadius: 8,
                }}
              />
              <Text style={font(900, 14.5)}>kifumate</Text>
            </View>
          )}
        </View>
        <View
          accessibilityLabel={`7枚中 ${step + 1}枚目`}
          accessibilityRole="image"
          style={{
            flex: 1,
            flexDirection: "row",
            justifyContent: "center",
            gap: 5,
          }}
        >
          {scenes.map((_, i) => (
            <View
              key={i}
              style={{
                width: i === step ? 22 : 8,
                height: 8,
                borderWidth: line.thin,
                borderColor: colors.ink,
                borderRadius: radius.pill,
                backgroundColor:
                  i === step
                    ? colors.you
                    : i < step
                      ? colors.ink
                      : colors.white,
              }}
            />
          ))}
        </View>
        <View style={{ width: 84, alignItems: "flex-end" }}>
          {!last && (
            <TextButton onPress={() => void finish(false)}>スキップ</TextButton>
          )}
        </View>
      </View>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          ref={scroll}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            flexGrow: 1,
            paddingTop: 4,
            paddingHorizontal: 20,
            paddingBottom: 8,
          }}
        >
          <Animated.View style={{ flex: 1, transform: [{ translateX: x }] }}>
            <View
              {...swipe.panHandlers}
              style={{
                flex: 1,
                minHeight: 120,
                maxHeight: 430,
                borderWidth: line.ol,
                borderColor: colors.ink,
                borderRadius: 28,
                boxShadow: shadow.card,
                backgroundColor: [colors.sand, colors.mintSoft, colors.sky][
                  step % 3
                ],
                overflow: "hidden",
              }}
            >
              <Image
                source={image.source}
                resizeMode="contain"
                accessibilityIgnoresInvertColors
                style={{
                  position: "absolute",
                  bottom: -3,
                  height: "91%",
                  width: "88%",
                  alignSelf: "center",
                }}
              />
            </View>
            <Text
              accessibilityRole="header"
              style={[
                font(900, 23, 1.35),
                { marginTop: 18, letterSpacing: 0.23 },
              ]}
            >
              {scene[0]}
            </Text>
            <Text
              style={[font(500, 13.5, 1.75, colors.ink2), { marginTop: 6 }]}
            >
              {scene[1]}
            </Text>
            {step === 1 && (
              <View style={{ marginTop: 12 }}>
                <Text style={[font(700, 12, 1.5), { marginBottom: 6 }]}>
                  対局で使っている名前
                </Text>
                <Input
                  accessibilityLabel="対局で使っている名前"
                  maxLength={30}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="例：tsubame"
                  value={name}
                  onChangeText={setName}
                />
                <Hint>
                  棋譜の中のあなたを見分けて、勝ち負けを数えるために使います（この端末の中だけ）。空のままでも進めます。あとで追加や変更ができます。
                </Hint>
              </View>
            )}
            {step === 2 && (
              <View
                style={{
                  marginTop: 12,
                  flexDirection: "row",
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                {[
                  ["×", "悪手"],
                  ["?", "疑問手"],
                  ["!", "好手"],
                  ["詰", "詰みあり"],
                ].map(([mark, label], i) => (
                  <View
                    key={label}
                    style={{
                      height: 24,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 5,
                      marginRight: 6,
                    }}
                  >
                    <View
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: i === 3 ? 4 : 9,
                        borderWidth: line.thin,
                        borderColor: colors.ink,
                        backgroundColor: [
                          colors.coral,
                          colors.orange,
                          colors.mint,
                          colors.you,
                        ][i],
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Text style={font(900, i === 3 ? 10 : 14)}>{mark}</Text>
                    </View>
                    <Text style={font(700, 12)}>{label}</Text>
                  </View>
                ))}
              </View>
            )}
            {step === 4 && (
              <View
                style={{
                  marginTop: 12,
                  paddingVertical: 7,
                  paddingHorizontal: 9,
                  borderWidth: line.thin,
                  borderStyle: "dashed",
                  borderColor: colors.dash,
                  borderRadius: 12,
                  flexDirection: "row",
                  gap: 7,
                  alignItems: "center",
                }}
              >
                <Icon name="lock" size={14} />
                <Text style={[font(700, 11, 1.5, colors.ink2), { flex: 1 }]}>
                  AIコーチは有料プランの機能です。解析（週10局まで）と分岐は、無料で使えます。
                </Text>
              </View>
            )}
            {step === 5 && (
              <View style={{ marginTop: 12 }}>
                <Text style={[font(700, 12, 1.5), { marginBottom: 6 }]}>
                  練習中の戦法（いくつでも）
                </Text>
                <View
                  accessibilityLabel="練習中の戦法"
                  style={{
                    flexDirection: "row",
                    flexWrap: "wrap",
                    gap: 6,
                    marginBottom: 10,
                  }}
                >
                  {practices.map((p) => (
                    <Chip
                      key={p}
                      label={p}
                      multiple
                      selected={practice.includes(p)}
                      onPress={() => {
                        if (!practice.includes(p) && practice.length >= 10) {
                          toast("練習中の戦法は10個まで選べます");
                          return;
                        }
                        setPractice(
                          practice.includes(p)
                            ? practice.filter((v) => v !== p)
                            : [...practice, p],
                        );
                      }}
                    />
                  ))}
                </View>
                <Text
                  style={[
                    font(700, 12, 1.5),
                    { marginTop: 4, marginBottom: 6 },
                  ]}
                >
                  目標
                </Text>
                <Input
                  accessibilityLabel="目標"
                  maxLength={60}
                  placeholder="例：初段になりたい"
                  value={goal}
                  onChangeText={setGoal}
                />
              </View>
            )}
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
      <View style={{ paddingTop: 8, paddingHorizontal: 20, paddingBottom: 12 }}>
        <Button
          kind="pri"
          wide
          disabled={saving || !coach.ready}
          onPress={() => (last ? void finish(true) : go(1))}
        >
          {step === 0
            ? "はじめる"
            : last
              ? replay
                ? "棋譜を取り込む"
                : "最初の棋譜を取り込む"
              : "次へ"}
        </Button>
        <View
          style={{ height: 38, alignItems: "center", justifyContent: "center" }}
        >
          {!!alt && (
            <TextButton
              onPress={() => {
                if (step === 0)
                  router.push({
                    pathname: "/backup",
                    params: { restore: "1" },
                  });
                else if (last) void finish(false);
                else {
                  if (!replay) {
                    setPractice([]);
                    setGoal("");
                  }
                  go(1);
                }
              }}
            >
              {alt}
            </TextButton>
          )}
        </View>
      </View>
    </Screen>
  );
}
