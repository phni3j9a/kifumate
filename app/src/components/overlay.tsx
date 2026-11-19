import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentRef,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ensureVisibleY } from "../core/scroll";
import { Icon, type IconName } from "./icons";
import { colors, font, line, radius, shadow } from "./theme";
import { Button, MascotImage, RoundButton, type Mascot } from "./ui";

// モックの core.js と同じく、知らせ（toast）・シート・確認ダイアログは1種類ずつ。

/* ---------- 知らせ（.toast）。label を付けると下に出て、操作を1つ添える（.toast.act） ---------- */
type Toast = { text: string; label?: string; onPress?: () => void };
let current: { toast: Toast | null; top: string } = { toast: null, top: "" };
let timer: ReturnType<typeof setTimeout> | undefined;
let hosts: string[] = [];
const listeners = new Set<() => void>();
function set(toast: Toast | null) {
  current = { toast, top: hosts[hosts.length - 1] ?? "" };
  listeners.forEach((f) => f());
}
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
};
export function toast(
  text: string,
  action?: { label: string; onPress: () => void },
) {
  clearTimeout(timer);
  set({ text, ...action });
  timer = setTimeout(() => set(null), action ? 6000 : 2600);
  AccessibilityInfo.announceForAccessibility(text);
}
export function hideToast(onPress?: Toast["onPress"]) {
  if (onPress && current.toast?.onPress !== onPress) return;
  clearTimeout(timer);
  if (current.toast) set(null);
}
/** 知らせの表示先。シートやダイアログ（別ウィンドウ）の中にも置き、いちばん手前の1つだけが描く */
export function ToastHost() {
  const id = useId();
  const insets = useSafeAreaInsets();
  const state = useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
  useEffect(() => {
    hosts.push(id);
    set(current.toast);
    return () => {
      hosts = hosts.filter((h) => h !== id);
      set(current.toast);
    };
  }, [id]);
  const t = state.toast;
  if (!t || state.top !== id) return null;
  if (!t.label)
    return (
      <View pointerEvents="none" style={s.toastArea}>
        <View accessibilityLiveRegion="polite" style={[s.toast, s.toastPlain]}>
          <Text
            style={[
              font(700, 11.5, 1.45, colors.white),
              { textAlign: "center" },
            ]}
          >
            {t.text}
          </Text>
        </View>
      </View>
    );
  return (
    <View
      pointerEvents="box-none"
      style={[s.toastActArea, { bottom: 128 + insets.bottom }]}
    >
      <View accessibilityLiveRegion="polite" style={[s.toast, s.toastAct]}>
        <Text
          numberOfLines={1}
          style={[font(700, 11.5, 1.45, colors.white), { flexShrink: 1 }]}
        >
          {t.text}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            hideToast();
            t.onPress?.();
          }}
          style={s.toastButton}
        >
          <Text style={font(900, 12)}>{t.label}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function useSlideUp(visible: boolean) {
  const [y] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!visible) return;
    let live = true;
    // モックの c-up（28px 下から .2s）。「視差効果を減らす」設定のときは動かさない。
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (!live || reduce) return;
      y.setValue(28);
      Animated.timing(y, {
        toValue: 0,
        duration: 200,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }).start();
    });
    return () => {
      live = false;
    };
  }, [visible, y]);
  return y;
}

/* ---------- 下から出るシート（.shw / .shb）。高さは既定で画面の58%、auto は中身に合わせる ---------- */
export function Sheet({
  visible,
  title,
  onClose,
  children,
  height = "58%",
  auto = false,
  footer,
  scrollRow,
}: PropsWithChildren<{
  visible: boolean;
  title: string;
  onClose: () => void;
  height?: `${number}%`;
  auto?: boolean;
  footer?: ReactNode;
  /** スクロール内容内で実測した、開いたときに見せる行（棋譜のいまの手）。 */
  scrollRow?: { y: number; height: number } | null;
}>) {
  const insets = useSafeAreaInsets();
  const y = useSlideUp(visible);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const [viewport, setViewport] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const positioned = useRef(false);
  useEffect(() => {
    if (
      !visible ||
      !scrollRow ||
      !viewport ||
      !contentHeight ||
      positioned.current
    )
      return;
    const y = ensureVisibleY(scrollRow.y, scrollRow.height, 0, viewport);
    positioned.current = true;
    if (y > 0)
      scroll.current?.scrollTo({
        y: Math.min(y, Math.max(0, contentHeight - viewport)),
        animated: false,
      });
  }, [visible, scrollRow, viewport, contentHeight]);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable
          focusable={false}
          aria-hidden
          onPress={onClose}
          style={s.scrim}
        />
        <Animated.View
          accessibilityViewIsModal
          style={[
            s.shb,
            auto ? { maxHeight: "86%" } : { height },
            { paddingBottom: insets.bottom, transform: [{ translateY: y }] },
          ]}
        >
          <View style={s.shh}>
            <Text
              accessibilityRole="header"
              numberOfLines={1}
              style={[font(900, 15), { flex: 1 }]}
            >
              {title}
            </Text>
            <RoundButton icon="x" label="閉じる" onPress={onClose} />
          </View>
          <ScrollView
            ref={scroll}
            keyboardShouldPersistTaps="handled"
            onLayout={
              scrollRow === undefined
                ? undefined
                : (e) => setViewport(e.nativeEvent.layout.height)
            }
            onContentSizeChange={
              scrollRow === undefined
                ? undefined
                : (_, height) => setContentHeight(height)
            }
            onScrollBeginDrag={
              scrollRow === undefined
                ? undefined
                : () => {
                    positioned.current = true;
                  }
            }
            contentContainerStyle={[
              s.shc,
              footer ? { paddingBottom: 8 } : null,
            ]}
          >
            {children}
          </ScrollView>
          {footer ? <View style={s.shFooter}>{footer}</View> : null}
        </Animated.View>
        <ToastHost />
      </View>
    </Modal>
  );
}
/** シートの中のメニュー行（.mn2）。tone は丸の色（on＝選択中、danger＝削除） */
export function MenuRow({
  icon,
  label,
  sub,
  onPress,
  tone,
  first = false,
}: {
  icon: IconName;
  label: string;
  sub?: string;
  onPress: () => void;
  tone?: "on" | "danger";
  first?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[
        s.mn2,
        !first && {
          borderTopWidth: line.thin,
          borderTopColor: colors.hair,
          borderRadius: 0,
        },
      ]}
    >
      <View
        style={[
          s.mi,
          tone === "on" && { backgroundColor: colors.you },
          tone === "danger" && { backgroundColor: colors.coralSoft },
        ]}
      >
        <Icon name={icon} size={16} strokeWidth={2.2} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={font(700, 14, 1.3)}>{label}</Text>
        {sub ? (
          <Text style={font(500, 10.5, 1.4, colors.ink2)}>{sub}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/* ---------- 確認ダイアログ（.dlg / .dlb）。モックの ask() と同じ引数 ---------- */
type Ask = {
  title: string;
  lead?: string;
  text: string;
  ok: string;
  onOk?: () => void;
  no?: string;
  single?: boolean;
  danger?: boolean;
  image?: Mascot;
};
let asking: Ask | null = null;
const askListeners = new Set<() => void>();
let confirming = 0;
function notifyAsk() {
  askListeners.forEach((f) => f());
}
function setAsk(next: Ask | null) {
  asking = next;
  notifyAsk();
}
/** 自動で出す案内は、利用者のダイアログと確認操作の完了を待つ。 */
export function whenDialogIdle(): Promise<void> | undefined {
  if (!asking && !confirming) return;
  return new Promise((resolve) => {
    const listener = () => {
      if (asking || confirming) return;
      askListeners.delete(listener);
      resolve();
    };
    askListeners.add(listener);
  });
}
export function ask(options: Ask) {
  hideToast();
  setAsk(options);
}
export function DialogHost() {
  const a = useSyncExternalStore(
    (f) => {
      askListeners.add(f);
      return () => {
        askListeners.delete(f);
      };
    },
    () => asking,
    () => asking,
  );
  const close = () => setAsk(null);
  return (
    <Modal
      visible={!!a}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={close}
    >
      <View style={s.dlg}>
        <Pressable
          focusable={false}
          aria-hidden
          onPress={close}
          style={s.scrim}
        />
        {a && (
          <View
            accessibilityRole="alert"
            accessibilityViewIsModal
            style={s.dlb}
          >
            {a.image && (
              <View
                style={{
                  alignItems: "center",
                  marginTop: -4,
                  marginBottom: 10,
                }}
              >
                <MascotImage name={a.image} height={116} />
              </View>
            )}
            <Text accessibilityRole="header" style={font(900, 15, 1.4)}>
              {a.title}
            </Text>
            {a.lead && (
              <Text
                style={[font(900, 15, 1.4), { marginTop: 6, marginBottom: 6 }]}
              >
                {a.lead}
              </Text>
            )}
            <Text
              style={[
                font(500, 12.5, 1.65, colors.ink2),
                { marginTop: a.lead ? 0 : 6 },
              ]}
            >
              {a.text}
            </Text>
            <View style={s.dla}>
              {!a.single && (
                <Button size="md" style={{ flex: 1 }} onPress={close}>
                  {a.no ?? "やめる"}
                </Button>
              )}
              <Button
                size="md"
                kind={a.danger ? "danger" : "pri"}
                style={{ flex: 1 }}
                onPress={async () => {
                  confirming++;
                  close();
                  try {
                    await a.onOk?.();
                  } finally {
                    confirming--;
                    notifyAsk();
                  }
                }}
              >
                {a.ok}
              </Button>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  toastArea: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    height: "88%", // 中央が画面の44%（.toast の top:44%）
    alignItems: "center",
    justifyContent: "center",
  },
  toast: {
    maxWidth: "84%",
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 18,
    backgroundColor: colors.ink,
    boxShadow: "0 3px 0 rgba(36,40,70,0.3)",
  },
  // モックの通常通知は left:50% の絶対配置＋幅 auto で残り半分に折り返す。
  toastPlain: { maxWidth: "50%" },
  toastActArea: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  toastAct: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 7,
    paddingLeft: 16,
    paddingRight: 7,
    borderRadius: radius.pill,
  },
  toastButton: {
    height: 30,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.mint,
    justifyContent: "center",
  },
  scrim: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.scrim,
  },
  shb: {
    backgroundColor: colors.bg,
    borderTopWidth: line.ol,
    borderColor: colors.ink,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
  },
  shh: {
    height: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingLeft: 16,
    paddingRight: 12,
  },
  shc: { paddingTop: 6, paddingHorizontal: 12, paddingBottom: 16 },
  shFooter: {
    gap: 2,
    alignItems: "center",
    paddingTop: 10,
    paddingHorizontal: 12,
    paddingBottom: 14,
    borderTopWidth: line.thin,
    borderTopColor: colors.hair,
  },
  mn2: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 50,
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: 12,
  },
  mi: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: line.ol,
    borderColor: colors.ink,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
  },
  dlg: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 26,
  },
  dlb: {
    alignSelf: "stretch",
    paddingTop: 18,
    paddingHorizontal: 16,
    paddingBottom: 14,
    backgroundColor: colors.bg,
    borderWidth: line.ol,
    borderColor: colors.ink,
    borderRadius: radius.dialog,
    boxShadow: shadow.card,
  },
  dla: { flexDirection: "row", gap: 8, marginTop: 14 },
});
