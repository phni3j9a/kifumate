import Svg, { Circle, G, Path, Rect, Text } from "react-native-svg";
import type { Mark } from "../analysis/display";
import { colors, fonts } from "./theme";

type Kind = Mark | "詰みあり";
/** hollow は白抜き（白地に良し悪しの色の記号）。形勢グラフで相手・後手の手に使う */
export function GraphMark({ kind, hollow }: { kind: Kind; hollow?: boolean }) {
  const ink = { stroke: colors.ink, strokeWidth: 1.5 };
  const color =
    kind === "好手" || kind === "詰みあり"
      ? colors.mint
      : kind === "悪手"
        ? colors.coral
        : colors.orange;
  const body = hollow ? colors.white : color;
  const sign = hollow ? color : colors.ink;
  // 白地の上の色は墨より薄い。白抜きは線を太くし、△を塗りつぶし、「詰」を大きくして補う
  const glyph = {
    stroke: sign,
    strokeWidth: hollow ? 2.3 : 1.6,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    fill: "none",
  } as const;
  if (kind === "詰みあり")
    return (
      <G>
        <Rect
          x={-6.5}
          y={-6.5}
          width={13}
          height={13}
          rx={3.5}
          fill={body}
          {...ink}
        />
        <Text
          textAnchor="middle"
          y={hollow ? 3.6 : 3.1}
          fontFamily={fonts[900]}
          fontSize={hollow ? 10 : 8.5}
          fill={sign}
        >
          詰
        </Text>
      </G>
    );
  return (
    <G>
      <Circle r={6.3} fill={body} {...ink} />
      {kind === "悪手" ? (
        <Path d="M-2.6 -2.6 2.6 2.6 M2.6 -2.6 -2.6 2.6" {...glyph} />
      ) : kind === "好手" ? (
        <G>
          <Circle r={3.12} {...glyph} />
          <Circle r={1.09} fill={sign} />
        </G>
      ) : (
        <Path
          d="M0 -3.25 3.12 2.21 H-3.12 Z"
          {...glyph}
          fill={hollow ? sign : "none"}
        />
      )}
    </G>
  );
}

export function GraphMarkIcon({ kind, size }: { kind: Kind; size: number }) {
  return (
    <Svg width={size} height={size} viewBox="-8 -8 16 16" aria-hidden>
      <GraphMark kind={kind} />
    </Svg>
  );
}
