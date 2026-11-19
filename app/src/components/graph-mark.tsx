import Svg, { Circle, G, Path, Rect, Text } from "react-native-svg";
import type { Mark } from "../analysis/display";
import { colors, fonts } from "./theme";

type Kind = Mark | "詰みあり";
export function GraphMark({ kind }: { kind: Kind }) {
  const ink = { stroke: colors.ink, strokeWidth: 1.5 };
  const glyph = {
    ...ink,
    strokeWidth: 1.6,
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
          fill={colors.mint}
          {...ink}
        />
        <Text
          textAnchor="middle"
          y={3.1}
          fontFamily={fonts[900]}
          fontSize={8.5}
          fill={colors.ink}
        >
          詰
        </Text>
      </G>
    );
  return (
    <G>
      <Circle
        r={6.3}
        fill={
          kind === "好手"
            ? colors.mint
            : kind === "悪手"
              ? colors.coral
              : colors.orange
        }
        {...ink}
      />
      {kind === "悪手" ? (
        <Path d="M-2.6 -2.6 2.6 2.6 M2.6 -2.6 -2.6 2.6" {...glyph} />
      ) : kind === "好手" ? (
        <G>
          <Circle r={3.12} {...glyph} />
          <Circle r={1.09} fill={colors.ink} />
        </G>
      ) : (
        <Path d="M0 -3.25 3.12 2.21 H-3.12 Z" {...glyph} />
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
