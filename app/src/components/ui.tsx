import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
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
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import type { ComponentProps, PropsWithChildren } from "react";

// モック .vc の固定ライトパレット。カード16・入力12・操作はピル。
export const colors = {
  ink: "#242846",
  muted: "#565B85",
  background: "#FFF8E8",
  mint: "#19C6A5",
  yellow: "#FFD23F",
  blue: "#A9C1FF",
  coral: "#FF6464",
  white: "#FFFFFF",
  line: "#DDDBD7",
};
export function Icon({
  name,
  color = colors.ink,
  size = 22,
}: {
  name: ComponentProps<typeof MaterialCommunityIcons>["name"];
  color?: string;
  size?: number;
}) {
  return <MaterialCommunityIcons name={name} color={color} size={size} />;
}
export function Label({
  children,
  muted = false,
  title = false,
}: PropsWithChildren<{ muted?: boolean; title?: boolean }>) {
  return (
    <Text
      selectable
      style={[styles.text, muted && styles.muted, title && styles.title]}
    >
      {children}
    </Text>
  );
}
export function Button({
  children,
  onPress,
  primary,
  disabled,
  label,
  style,
}: PropsWithChildren<{
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  label?: string;
  style?: ViewStyle;
}>) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary && { backgroundColor: colors.mint },
        pressed && {
          transform: [{ translateY: 2 }],
          boxShadow: "0 1px 0 #242846",
        },
        disabled && { opacity: 0.45 },
        style,
      ]}
    >
      <Text style={styles.buttonText}>{children}</Text>
    </Pressable>
  );
}
export function IconButton({
  name,
  label,
  onPress,
  disabled = false,
}: {
  name: ComponentProps<typeof Icon>["name"];
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        disabled && { opacity: 0.35 },
        pressed && { backgroundColor: colors.yellow },
      ]}
    >
      <Icon name={name} />
    </Pressable>
  );
}
export function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && { backgroundColor: colors.ink }]}
    >
      <Text style={[styles.chipText, selected && { color: colors.white }]}>
        {label}
      </Text>
    </Pressable>
  );
}
export function Card({ children }: PropsWithChildren) {
  return <View style={styles.card}>{children}</View>;
}
export function Field(props: TextInputProps) {
  return (
    <TextInput
      placeholderTextColor={colors.muted}
      {...props}
      style={[
        styles.field,
        props.multiline && { minHeight: 160, textAlignVertical: "top" },
        props.style,
      ]}
    />
  );
}
export function Message({
  text,
  error = false,
}: {
  text: string;
  error?: boolean;
}) {
  if (!text) return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        styles.message,
        error && { borderColor: "#AC2727", backgroundColor: "#FFF0ED" },
      ]}
    >
      <Text selectable style={[styles.text, error && { color: "#922424" }]}>
        {text}
      </Text>
    </View>
  );
}
export function Empty({
  title,
  detail,
  children,
}: PropsWithChildren<{ title: string; detail: string }>) {
  return (
    <View style={styles.empty}>
      <Image
        source={require("../assets/sys-empty.webp")}
        style={{ width: 152, height: 152 }}
        accessibilityIgnoresInvertColors
      />
      <Label title>{title}</Label>
      <Label muted>{detail}</Label>
      {children}
    </View>
  );
}
export function Page({ children }: PropsWithChildren) {
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.page}
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
export const styles = StyleSheet.create({
  page: {
    padding: 16,
    gap: 16,
    paddingBottom: 40,
    flexGrow: 1,
    width: "100%",
    maxWidth: 620,
    alignSelf: "center",
  },
  text: { fontSize: 15, lineHeight: 23, color: colors.ink, fontWeight: "500" },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 21 },
  title: { fontSize: 23, lineHeight: 32, fontWeight: "900" },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  button: {
    minHeight: 46,
    borderRadius: 99,
    borderCurve: "continuous",
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.white,
    paddingHorizontal: 18,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 3px 0 #242846",
  },
  buttonText: { fontSize: 15, fontWeight: "800", color: colors.ink },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 99,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.white,
    justifyContent: "center",
    alignItems: "center",
  },
  chip: {
    minHeight: 44,
    borderWidth: 1.5,
    borderColor: colors.ink,
    borderRadius: 99,
    paddingVertical: 10,
    paddingHorizontal: 14,
    justifyContent: "center",
    backgroundColor: colors.white,
  },
  chipText: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  card: {
    backgroundColor: colors.white,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 16,
    borderCurve: "continuous",
    padding: 16,
    gap: 12,
    boxShadow: "0 3px 0 #242846",
  },
  field: {
    borderWidth: 1.5,
    borderColor: colors.ink,
    borderRadius: 12,
    borderCurve: "continuous",
    backgroundColor: colors.white,
    color: colors.ink,
    padding: 12,
    fontSize: 15,
    minHeight: 48,
  },
  message: {
    borderWidth: 1.5,
    borderRadius: 12,
    borderColor: colors.muted,
    backgroundColor: "#EFFBF7",
    padding: 12,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 20,
    paddingVertical: 36,
  },
});
