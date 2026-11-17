import { Platform, type TextStyle } from "react-native";

// モック mock/src/app/app.css の `.vc`（ポップ案の固定ライト配色）と同じ値。画面側で色を直書きしない。
export const colors = {
  ink: "#242846",
  ink2: "#565B85",
  bg: "#FFF8E8",
  you: "#FFD23F",
  opp: "#A9C1FF",
  mint: "#19C6A5",
  coral: "#FF6464",
  orange: "#FFA347",
  white: "#FFFFFF",
  // `.vc` の変数以外で、app.css が部品をまたいで使っている色
  hair: "rgba(36,40,70,0.14)", // --hair
  dash: "rgba(36,40,70,0.45)", // 破線の枠
  scrim: "rgba(36,40,70,0.36)",
  trend: "#FFE27A", // 戦績グラフの面
  sand: "#FFE9A8", // タグ・行アイコン・選ばれていないタブ
  sky: "#DCE6FF", // 相手側のタグ
  advice: "#E4F8F3", // AIコーチの助言
  skeleton: "#F1E8CF",
  mintSoft: "#C9F3EA", // 分岐・進行中
  coralSoft: "#FFD9D4", // 注意（本譜に戻る・削除）
  badCard: "#FFE9E6",
  warnCard: "#FFF1DE",
  oppPiece: "#CFDBFF",
  oppKing: "#8EADFF",
  promoted: "#DB2F45",
};
// --ol（2px）と --hair・細い枠（1.5px）、角丸、影（ぼかしなしで下に落とす）
export const line = { ol: 2, thin: 1.5 };
export const radius = { pill: 99, card: 16, sheet: 22, dialog: 20, field: 14 };
export const shadow = {
  card: `0 3px 0 ${colors.ink}`, // --sh
  small: `0 2px 0 ${colors.ink}`,
  pressed: `0 1px 0 ${colors.ink}`,
};

// --f-maru。太さごとに別ファミリーで読み込む（fontWeight を重ねると合成ボールドになる）。
export const fonts = {
  500: "ZenMaruGothic_500Medium",
  700: "ZenMaruGothic_700Bold",
  900: "ZenMaruGothic_900Black",
} as const;
export type Weight = keyof typeof fonts;
// CSS の `font: <weight> <size>px/<line> var(--f-maru)` と同じ並び。
export function font(
  weight: Weight,
  size: number,
  lineHeight = 1,
  color: string = colors.ink,
): TextStyle {
  return {
    fontFamily: fonts[weight],
    fontSize: size,
    lineHeight: size * lineHeight,
    color,
    includeFontPadding: false,
  };
}
// --f-mono（KIFの本文）
export const mono = Platform.select({ ios: "Menlo", default: "monospace" });
