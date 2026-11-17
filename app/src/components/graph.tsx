import { useState } from "react";
import { View } from "react-native";
import Svg, { G, Line, Rect, Text as SvgText } from "react-native-svg";
import { colors, fonts } from "./theme";

const AXIS = [3000, 2000, 1000, 0, -1000, -2000, -3000];
/** 形勢グラフ（モック game.js の buildGraph）。いまは未解析の姿だけ：目盛りと、いまの手数の位置。 */
export function EvalGraph({ ply, total }: { ply: number; total: number }) {
  const [{ W, H }, setSize] = useState({ W: 0, H: 0 });
  const padL = 35,
    padR = 10,
    bot = H - 19,
    y0 = 6,
    y1 = bot - 5,
    xl = padL - 5,
    xr = W - 2;
  const Y = (v: number) => y0 + ((y1 - y0) * (3000 - v)) / 6000;
  const x = padL + (total ? ((W - padL - padR) * ply) / total : 0);
  const hx = Math.max(16, Math.min(W - 16, x));
  const mid = (padL + W - padR) / 2;
  const message = "解析すると、ここに形勢グラフが出ます";
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel="形勢グラフ。まだ解析していません"
      onLayout={(e) =>
        setSize({
          W: e.nativeEvent.layout.width,
          H: e.nativeEvent.layout.height,
        })
      }
      style={{ flex: 1 }}
    >
      {W >= 60 && H >= 50 && (
        <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          {AXIS.map((v) => (
            <G key={v}>
              <Line
                x1={xl}
                x2={xr}
                y1={Y(v)}
                y2={Y(v)}
                stroke={colors.ink}
                opacity={v ? 0.11 : 0.4}
              />
              {/* グラフが低いときは ±2000 の数字を省く（線は残す） */}
              {((y1 - y0) / 6 >= 12 || Math.abs(v) !== 2000) && (
                <SvgText
                  x={xl - 3}
                  y={Y(v) + 0.35 * 9}
                  textAnchor="end"
                  fontFamily={fonts[700]}
                  fontSize={9}
                  fill={colors.ink2}
                >
                  {v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0"}
                </SvgText>
              )}
            </G>
          ))}
          <G textAnchor="middle" fontFamily={fonts[700]} fontSize={10.5}>
            <SvgText
              x={mid}
              y={Y(0) - 13}
              stroke={colors.white}
              strokeWidth={6}
              strokeLinejoin="round"
              fill={colors.white}
            >
              {message}
            </SvgText>
            <SvgText x={mid} y={Y(0) - 13} fill={colors.ink2}>
              {message}
            </SvgText>
          </G>
          <Line
            x1={x}
            x2={x}
            y1={y0 - 3}
            y2={bot + 2}
            stroke={colors.ink}
            strokeWidth={2}
          />
          <G transform={`translate(${hx} ${bot + 2})`}>
            <Rect
              x={-15}
              y={0}
              width={30}
              height={16}
              rx={8}
              fill={colors.ink}
            />
            <SvgText
              y={11.6}
              textAnchor="middle"
              fontFamily={fonts[900]}
              fontSize={10}
              fill={colors.white}
            >
              {ply}
            </SvgText>
          </G>
        </Svg>
      )}
    </View>
  );
}
