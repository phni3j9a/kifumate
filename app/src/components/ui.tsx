import { useState, type PropsWithChildren, type ReactNode } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ImageSourcePropType,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "./icons";
import { colors, font, line, mono, radius, shadow } from "./theme";

// 部品はモック app.css のクラスに1対1で対応させる（かっこ内がクラス名）。

// マスコット（mock/assets/mascot）。RN は height だけでは幅が決まらないので縦横比を持つ。
export const mascots = {
  "sys-offline": {
    source: require("../assets/sys-offline.webp"),
    ratio: 193 / 300,
  },
  "sys-limit": {
    source: require("../assets/sys-limit.webp"),
    ratio: 302 / 320,
  },
  "sys-empty": {
    source: require("../assets/sys-empty.webp"),
    ratio: 440 / 423,
  },
  "sys-noresults": {
    source: require("../assets/sys-noresults.webp"),
    ratio: 360 / 337,
  },
  "sys-invalid": {
    source: require("../assets/sys-invalid.webp"),
    ratio: 240 / 300,
  },
  "sys-duplicate": {
    source: require("../assets/sys-duplicate.webp"),
    ratio: 278 / 300,
  },
} satisfies Record<string, { source: ImageSourcePropType; ratio: number }>;
export type Mascot = keyof typeof mascots;
export function MascotImage({
  name,
  height,
}: {
  name: Mascot;
  height: number;
}) {
  return (
    <Image
      source={mascots[name].source}
      resizeMode="contain"
      accessibilityIgnoresInvertColors
      style={{ height, width: Math.round(height * mascots[name].ratio) }}
    />
  );
}

/** 画面の土台。ステータスバーの分だけ上を空ける（モックの .screen） */
export function Screen({
  children,
  bottom = false,
}: PropsWithChildren<{ bottom?: boolean }>) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.bg,
        paddingTop: insets.top,
        paddingBottom: bottom ? insets.bottom : 0,
      }}
    >
      {children}
    </View>
  );
}
/** タブ画面の見出し（.ab） */
export function AppBar({
  title,
  note,
  children,
}: PropsWithChildren<{ title: string; note?: string }>) {
  return (
    <View style={s.ab}>
      <Text accessibilityRole="header" style={s.abTitle}>
        {title}
      </Text>
      <Text style={s.abNote}>{note}</Text>
      {children}
    </View>
  );
}
/** 重ねて開く画面の見出し（.ph）。close は × で閉じる画面 */
export function PageHeader({
  title,
  close = false,
}: {
  title: string;
  close?: boolean;
}) {
  return (
    <View style={s.ph}>
      <RoundButton
        icon={close ? "x" : "prev"}
        label={close ? "閉じる" : "戻る"}
        onPress={() =>
          router.canGoBack() ? router.back() : router.replace("/")
        }
      />
      <Text accessibilityRole="header" numberOfLines={1} style={s.phTitle}>
        {title}
      </Text>
    </View>
  );
}
/** 画面の本文（.pgc）。入力中はキーボードを避ける */
export function PageScroll({ children }: PropsWithChildren) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[s.pgc, { paddingBottom: 22 + insets.bottom }]}
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** 丸いアイコンボタン（.rb） */
export function RoundButton({
  icon,
  label,
  onPress,
  warn = false,
  disabled = false,
  size = 34,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  warn?: boolean;
  disabled?: boolean;
  size?: number;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={{ top: 4, bottom: 4, left: 2, right: 2 }}
      style={({ pressed }) => [
        s.rb,
        { width: size, height: size },
        warn && { backgroundColor: colors.coralSoft },
        pressed && s.down2,
      ]}
    >
      <Icon name={icon} size={17} strokeWidth={2.4} />
    </Pressable>
  );
}
const buttonSizes = {
  lg: { height: 46, pad: 20, text: 14.5, drop: 3 },
  md: { height: 40, pad: 8, text: 13, drop: 3 },
  sm: { height: 34, pad: 14, text: 12.5, drop: 2 },
};
/** ピル型のボタン（.bt / .pri / .sm / .wide）。md はダイアログと2つ並びの大きさ */
export function Button({
  children,
  onPress,
  kind = "plain",
  size = "lg",
  icon,
  wide = false,
  disabled = false,
  style,
}: {
  children: string;
  onPress: () => void;
  kind?: "plain" | "pri" | "danger";
  size?: keyof typeof buttonSizes;
  icon?: IconName;
  wide?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const z = buttonSizes[size];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={
        size === "sm" ? { top: 4, bottom: 4, left: 2, right: 2 } : undefined
      }
      style={({ pressed }) => [
        s.bt,
        {
          height: z.height,
          paddingHorizontal: z.pad,
          boxShadow: z.drop === 3 ? shadow.card : shadow.small,
        },
        kind === "pri" && { backgroundColor: colors.mint },
        kind === "danger" && { backgroundColor: colors.coral },
        wide && { alignSelf: "stretch" },
        pressed && { transform: [{ translateY: z.drop }], boxShadow: "none" },
        disabled && { opacity: 0.45, boxShadow: "none" },
        style,
      ]}
    >
      {icon && <Icon name={icon} size={16} strokeWidth={2.4} />}
      <Text numberOfLines={1} style={font(900, z.text)}>
        {children}
      </Text>
    </Pressable>
  );
}
/** 下線つきの文字。RN は下線の位置を選べないので、枠線で text-underline-offset:3px と同じ位置に引く */
export function Underlined({
  children,
  weight = 900,
  size = 11,
}: {
  children: string;
  weight?: 700 | 900;
  size?: number;
}) {
  return (
    <View style={s.underline}>
      <Text style={font(weight, size)}>{children}</Text>
    </View>
  );
}
/** 下線だけのボタン（.tx-b） */
export function TextButton({
  children,
  onPress,
}: {
  children: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
      style={{ paddingVertical: 8, paddingHorizontal: 6 }}
    >
      <Underlined weight={700} size={12}>
        {children}
      </Underlined>
    </Pressable>
  );
}
/** 選べるピル（.ch）。raised は「絞り込み」のようにシートを開くもの（.act）、block は縦に並べる大きい形（.opt.rows） */
export function Chip({
  label,
  selected = false,
  onPress,
  icon,
  count = 0,
  raised = false,
  block = false,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  icon?: IconName;
  count?: number;
  raised?: boolean;
  block?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      aria-selected={raised ? undefined : selected}
      onPress={onPress}
      hitSlop={{ top: 4, bottom: 4, left: 2, right: 2 }}
      style={[
        s.ch,
        selected && { backgroundColor: colors.ink },
        raised && { boxShadow: shadow.small, paddingRight: 11 },
        block && { height: 44, justifyContent: "center" },
      ]}
    >
      {icon && <Icon name={icon} size={13} strokeWidth={2.2} />}
      <Text
        numberOfLines={1}
        style={font(
          700,
          block ? 13.5 : 12,
          1,
          selected ? colors.white : colors.ink,
        )}
      >
        {label}
      </Text>
      {count > 0 && (
        <View style={s.chCount}>
          <Text style={[font(900, 10, 1.6), { textAlign: "center" }]}>
            {count}
          </Text>
        </View>
      )}
    </Pressable>
  );
}
/** どれか1つを選ぶ切り替え（.sg） */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly (readonly [T, string])[];
  value: T | null;
  onChange: (value: T) => void;
  label?: string;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={s.sg}
    >
      {options.map(([v, text]) => (
        <Pressable
          key={v}
          accessibilityRole="radio"
          aria-checked={value === v}
          onPress={() => onChange(v)}
          hitSlop={{ top: 4, bottom: 4, left: 2, right: 2 }}
          style={[s.sgItem, value === v && { backgroundColor: colors.ink }]}
        >
          <Text
            numberOfLines={1}
            style={font(900, 12, 1, value === v ? colors.white : colors.ink2)}
          >
            {text}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
/** 白いカード（.cd） */
export function Card({
  children,
  style,
}: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return <View style={[s.cd, style]}>{children}</View>;
}
/** カードの上の小見出し（.st） */
export function SectionTitle({
  children,
  first = false,
}: {
  children: string;
  first?: boolean;
}) {
  return (
    <Text accessibilityRole="header" style={[s.st, first && { marginTop: 4 }]}>
      {children}
    </Text>
  );
}
/** カードの中の、次の画面へ進む行（.rw） */
export function Row({
  icon,
  title,
  sub,
  onPress,
  first = false,
}: {
  icon?: IconName;
  title: string;
  sub?: string;
  onPress: () => void;
  first?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[s.rw, !first && s.hairTop]}
    >
      {icon && (
        <View style={s.rwIcon}>
          <Icon name={icon} size={15} strokeWidth={2.2} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={font(700, 13.5, 1.35)}>{title}</Text>
        {sub ? (
          <Text numberOfLines={1} style={font(500, 11, 1.45, colors.ink2)}>
            {sub}
          </Text>
        ) : null}
      </View>
      <Icon name="next" size={15} strokeWidth={2.4} color={colors.ink2} />
    </Pressable>
  );
}
/** 補足の文章（.hint） */
export function Hint({
  children,
  style,
}: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return (
    <View style={[{ marginTop: 8, marginHorizontal: 4 }, style]}>
      <Text style={font(500, 11.5, 1.65, colors.ink2)}>{children}</Text>
    </View>
  );
}
/** カードの中の「まだありません」（.empty） */
export function EmptyNote({ children }: { children: string }) {
  return (
    <Text style={[font(700, 12.5, 1.7, colors.ink2), s.emptyNote]}>
      {children}
    </Text>
  );
}
function useFocusRing() {
  const [focused, setFocused] = useState(false);
  return {
    focused,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  };
}
/** 1行の入力（.inp） */
// フォーカスの輪（影）は外側の View に描く。Android は TextInput の影を変えると内側の余白が消える。
export function Input({
  style,
  ...props
}: Omit<TextInputProps, "style"> & { style?: StyleProp<ViewStyle> }) {
  const ring = useFocusRing();
  return (
    <View style={[s.inpBox, ring.focused && s.ring, style]}>
      <TextInput
        placeholderTextColor={placeholder}
        {...props}
        onFocus={ring.onFocus}
        onBlur={ring.onBlur}
        style={s.inp}
      />
    </View>
  );
}
/** KIFの本文を入れる・見せる欄（.ta.kif / .kifx）。invalid は読み取れないとき（.ng） */
export function KifArea({
  invalid = false,
  height = 132,
  size = 12,
  ...props
}: TextInputProps & { invalid?: boolean; height?: number; size?: number }) {
  const ring = useFocusRing();
  return (
    <View
      style={[
        s.kifBox,
        invalid && {
          outlineWidth: 2,
          outlineStyle: "solid",
          outlineColor: colors.coralSoft,
        },
        ring.focused && s.ring,
      ]}
    >
      <TextInput
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        placeholderTextColor={placeholder}
        {...props}
        onFocus={ring.onFocus}
        onBlur={ring.onBlur}
        style={[
          s.kif,
          { height, fontSize: size, lineHeight: size * 1.5 },
          invalid && { borderColor: colors.coral },
        ]}
      />
    </View>
  );
}
/** マスコット付きの空の状態（.emp）。small は一覧の中に出す小さい形（.emp.sm） */
export function EmptyState({
  image,
  title,
  detail,
  small = false,
  children,
}: PropsWithChildren<{
  image: Mascot;
  title: string;
  detail?: string;
  small?: boolean;
}>) {
  return (
    <View style={small ? s.empSmall : s.emp}>
      <View style={{ marginBottom: 6 }}>
        <MascotImage name={image} height={small ? 112 : 172} />
      </View>
      <Text
        accessibilityRole="header"
        style={[font(900, small ? 14.5 : 17, 1.4), s.center]}
      >
        {title}
      </Text>
      {detail ? (
        <Text
          style={[
            font(500, 12.5, 1.75, colors.ink2),
            s.center,
            { maxWidth: 312 },
          ]}
        >
          {detail}
        </Text>
      ) : null}
      {children}
    </View>
  );
}
/** マスコット付きの知らせカード（.cd.vri）。bad は読み取れない、warn は重複 */
export function NoticeCard({
  kind,
  image,
  title,
  detail,
}: {
  kind: "bad" | "warn";
  image: Mascot;
  title: string;
  detail: string;
}) {
  return (
    <Card
      style={[
        s.vri,
        { backgroundColor: kind === "bad" ? colors.badCard : colors.warnCard },
      ]}
    >
      <MascotImage name={image} height={88} />
      <View accessibilityLiveRegion="polite" style={{ flex: 1 }}>
        <Text style={font(900, 13.5, 1.4)}>{title}</Text>
        <Text
          selectable
          style={[font(500, 11.5, 1.6, colors.ink2), { marginTop: 3 }]}
        >
          {detail}
        </Text>
      </View>
    </Card>
  );
}
/** 画面を開けなかったときの説明（マスコットなしの .emp） */
export function Problem({
  text,
  children,
}: {
  text: string;
  children?: ReactNode;
}) {
  return (
    <View style={s.emp}>
      <Text
        accessibilityLiveRegion="polite"
        style={[font(700, 12.5, 1.7, colors.ink2), s.center]}
      >
        {text}
      </Text>
      {children}
    </View>
  );
}

const placeholder = "rgba(86,91,133,0.65)"; // ::placeholder は --ink2 の 65%
const pill = {
  borderWidth: line.ol,
  borderColor: colors.ink,
  borderRadius: radius.pill,
  backgroundColor: colors.white,
} as const;
export const s = StyleSheet.create({
  center: { textAlign: "center" },
  underline: {
    borderBottomWidth: 1,
    borderBottomColor: colors.ink,
    paddingBottom: 1.5,
    marginBottom: -2.5,
  },
  hairTop: { borderTopWidth: line.thin, borderTopColor: colors.hair },
  down2: { transform: [{ translateY: 2 }], boxShadow: "none" },
  // .inp:focus-visible の box-shadow 2px。Android は影だと角丸に沿わないので輪郭線で描く
  ring: { outlineWidth: 2, outlineStyle: "solid", outlineColor: colors.mint },
  ab: {
    height: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 16,
    paddingRight: 12,
  },
  abTitle: { ...font(900, 22), letterSpacing: 0.44 },
  abNote: {
    ...font(700, 11, 1, colors.ink2),
    paddingTop: 5,
    marginRight: "auto",
  },
  ph: {
    height: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
  },
  phTitle: { ...font(900, 16, 1.2), flex: 1 },
  pgc: { paddingTop: 9, paddingHorizontal: 14 },
  rb: {
    ...pill,
    alignItems: "center",
    justifyContent: "center",
    boxShadow: shadow.small,
  },
  bt: {
    ...pill,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  ch: {
    height: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    borderWidth: line.thin,
    borderColor: colors.ink,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
  },
  chCount: {
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: colors.coral,
  },
  sg: { ...pill, flexDirection: "row", padding: 3, gap: 3 },
  sgItem: {
    flex: 1,
    height: 32,
    paddingHorizontal: 6,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  cd: {
    backgroundColor: colors.white,
    borderWidth: line.ol,
    borderColor: colors.ink,
    borderRadius: radius.card,
    boxShadow: shadow.card,
  },
  st: {
    ...font(900, 11.5, 1.3, colors.ink2),
    letterSpacing: 0.46,
    marginTop: 16,
    marginHorizontal: 4,
    marginBottom: 6,
  },
  rw: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 50,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  rwIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: line.ol,
    borderColor: colors.ink,
    backgroundColor: colors.sand,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyNote: {
    paddingVertical: 40,
    paddingHorizontal: 20,
    textAlign: "center",
  },
  // 背景色がないと Android は角丸を輪郭線に使わない（中の欄と同じ白で隠れる）
  inpBox: { borderRadius: radius.pill, backgroundColor: colors.white },
  kifBox: { borderRadius: radius.field, backgroundColor: colors.white },
  inp: {
    ...pill,
    ...font(500, 16),
    lineHeight: undefined,
    height: 42,
    paddingHorizontal: 14,
    paddingVertical: 0,
    outlineWidth: 0,
    outlineStyle: "solid", // Web: auto のままだと幅0でも既定のフォーカス枠が出る
  },
  kif: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: line.ol,
    borderColor: colors.ink,
    borderRadius: radius.field,
    backgroundColor: colors.white,
    color: colors.ink,
    fontFamily: mono,
    textAlignVertical: "top",
    outlineWidth: 0,
    outlineStyle: "solid", // Web: auto のままだと幅0でも既定のフォーカス枠が出る
  },
  emp: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingTop: 10,
    paddingHorizontal: 30,
    paddingBottom: 44,
  },
  empSmall: {
    alignItems: "center",
    gap: 8,
    paddingTop: 26,
    paddingHorizontal: 30,
    paddingBottom: 30,
  },
  vri: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 12,
    paddingVertical: 10,
    paddingLeft: 10,
    paddingRight: 14,
  },
});
