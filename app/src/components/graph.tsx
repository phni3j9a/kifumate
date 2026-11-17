import { useState } from "react";
import { View } from "react-native";
import Svg, {
  Circle,
  ClipPath,
  Defs,
  G,
  Line,
  Path,
  Rect,
  Text as SvgText,
} from "react-native-svg";
import type { Point } from "../analysis/display";
import { colors, fonts } from "./theme";
const AXIS = [3000, 2000, 1000, 0, -1000, -2000, -3000];
export function EvalGraph({
  ply,
  total,
  points = [],
  sign = 1,
  onPly,
  phases = [],
  labels = ["あなた", "相手"],
}: {
  ply: number;
  total: number;
  points?: Point[];
  sign?: number;
  onPly?: (ply: number) => void;
  labels?: string[];
  phases?: { name: string; a: number; b: number }[];
}) {
  const [{ W, H }, setSize] = useState({ W: 0, H: 0 });
  const padL = 35,
    padR = 10,
    bot = H - 19,
    y0 = 6,
    y1 = bot - 5,
    xl = padL - 5,
    xr = W - 2;
  const X = (i: number) => padL + ((W - padL - padR) * i) / Math.max(1, total);
  const Y = (v: number) =>
    y0 + ((y1 - y0) * (3000 - Math.max(-3000, Math.min(3000, v)))) / 6000;
  const x = X(ply),
    hx = Math.max(16, Math.min(W - 16, x)),
    mid = Y(0);
  const available = points.some((p) => p.value !== null);
  let d = "",
    areas: string[] = [],
    segment = "",
    first = 0,
    last = 0;
  points.forEach((p, i) => {
    if (p.value === null) {
      if (segment)
        areas.push(`${segment}L${X(last)} ${mid}L${X(first)} ${mid}Z`);
      segment = "";
      return;
    }
    const step = `${X(i)} ${Y(sign * p.value)}`;
    if (!segment) {
      first = i;
      segment = `M${step}`;
      d += `M${step}`;
    } else {
      segment += `L${step}`;
      d += `L${step}`;
    }
    last = i;
  });
  if (segment) areas.push(`${segment}L${X(last)} ${mid}L${X(first)} ${mid}Z`);
  function choose(locationX: number, snap: boolean) {
    let i = Math.max(
      0,
      Math.min(
        total,
        Math.round(((locationX - padL) / (W - padL - padR)) * total),
      ),
    );
    if (snap)
      for (const delta of [0, -1, 1, -2, 2])
        if (points[i + delta]?.mark || points[i + delta]?.mate) {
          i += delta;
          break;
        }
    onPly?.(i);
  }
  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel={
        available
          ? "形勢グラフ。タップして手数を移動"
          : "形勢グラフ。まだ解析していません"
      }
      accessibilityValue={{ min: 0, max: total, now: ply }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) =>
        onPly?.(
          Math.max(
            0,
            Math.min(
              total,
              ply + (e.nativeEvent.actionName === "increment" ? 1 : -1),
            ),
          ),
        )
      }
      onStartShouldSetResponder={() => !!onPly}
      onResponderGrant={(e) => choose(e.nativeEvent.locationX, true)}
      onResponderMove={(e) => choose(e.nativeEvent.locationX, false)}
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
          <Defs>
            <ClipPath id="above">
              <Rect width={W} height={Math.max(0, mid)} />
            </ClipPath>
            <ClipPath id="below">
              <Rect y={mid} width={W} height={H} />
            </ClipPath>
          </Defs>
          {available &&
            phases.map((p, i) => (
              <G key={p.name}>
                {i % 2 === 0 && (
                  <Rect
                    x={i ? X(p.a) - (X(1) - X(0)) / 2 : xl}
                    y={y0}
                    width={Math.max(0, X(p.b) - X(p.a) + (X(1) - X(0)))}
                    height={Math.max(0, y1 - y0)}
                    fill={colors.sand}
                    opacity={0.2}
                  />
                )}
                <SvgText
                  x={(X(p.a) + X(p.b)) / 2}
                  y={H - 5}
                  textAnchor="middle"
                  fontFamily={fonts[700]}
                  fontSize={9}
                  fill={colors.ink2}
                >
                  {Math.abs((X(p.a) + X(p.b)) / 2 - hx) < 30 ? "" : p.name}
                </SvgText>
              </G>
            ))}
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
              {((y1 - y0) / 6 >= 12 || Math.abs(v) !== 2000) && (
                <SvgText
                  x={xl - 3}
                  y={Y(v) + 3.15}
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
          {areas.map((a, i) => (
            <G key={i}>
              <Path
                d={a}
                fill={colors.you}
                opacity={0.45}
                clipPath="url(#above)"
              />
              <Path
                d={a}
                fill={colors.opp}
                opacity={0.45}
                clipPath="url(#below)"
              />
            </G>
          ))}
          {d && <Path d={d} fill="none" stroke={colors.ink} strokeWidth={2} />}
          {!available ? (
            <G textAnchor="middle" fontFamily={fonts[700]} fontSize={10.5}>
              <SvgText
                x={(padL + W - padR) / 2}
                y={mid - 13}
                stroke={colors.white}
                strokeWidth={6}
                fill={colors.white}
              >
                解析すると、ここに形勢グラフが出ます
              </SvgText>
              <SvgText
                x={(padL + W - padR) / 2}
                y={mid - 13}
                fill={colors.ink2}
              >
                解析すると、ここに形勢グラフが出ます
              </SvgText>
            </G>
          ) : (
            <G fontFamily={fonts[700]} fontSize={8.5} fill={colors.ink2}>
              <Circle cx={padL + 4} cy={y0 + 9} r={4} fill={colors.you} />
              <SvgText x={padL + 11} y={y0 + 12}>
                {labels[0]}
              </SvgText>
              <Circle cx={padL + 4} cy={y1 - 9} r={4} fill={colors.opp} />
              <SvgText x={padL + 11} y={y1 - 6}>
                {labels[1]}
              </SvgText>
            </G>
          )}
          {(() => {
            const lastX = [
              [-99, -99],
              [-99, -99],
            ];
            return points.flatMap((p, i) => {
              if ((!p.mark && !p.mate) || p.value === null) return [];
              const lane = p.self ? 0 : 1,
                row = X(i) - lastX[lane]![0]! >= 13 ? 0 : 1;
              lastX[lane]![row] = X(i);
              const y = p.self ? y0 + 9 + row * 11.5 : y1 - 9 - row * 11.5;
              return [
                <G key={i} transform={`translate(${X(i)} ${y})`}>
                  {Math.abs(Y(p.value * sign) - y) > 9 && (
                    <Line
                      y2={Y(p.value * sign) - y}
                      stroke={colors.ink}
                      opacity={0.25}
                    />
                  )}
                  {p.mate ? (
                    <Rect
                      x={-6.5}
                      y={-6.5}
                      width={13}
                      height={13}
                      rx={3.5}
                      fill={colors.mint}
                      stroke={colors.ink}
                      strokeWidth={1.2}
                    />
                  ) : (
                    <Circle
                      r={6.3}
                      fill={
                        p.mark === "好手"
                          ? colors.mint
                          : p.mark === "悪手"
                            ? colors.coral
                            : colors.orange
                      }
                      stroke={colors.ink}
                      strokeWidth={1.2}
                    />
                  )}
                  <SvgText
                    textAnchor="middle"
                    y={3.2}
                    fontFamily={fonts[900]}
                    fontSize={9}
                    fill={colors.ink}
                  >
                    {p.mate
                      ? "詰"
                      : p.mark === "悪手"
                        ? "×"
                        : p.mark === "好手"
                          ? "◎"
                          : "△"}
                  </SvgText>
                </G>,
              ];
            });
          })()}
          <Line
            x1={x}
            x2={x}
            y1={y0 - 3}
            y2={bot + 2}
            stroke={colors.ink}
            strokeWidth={2}
          />
          {points[ply]?.value != null && (
            <Circle
              cx={x}
              cy={Y(points[ply]!.value! * sign)}
              r={4.5}
              fill={colors.you}
              stroke={colors.ink}
              strokeWidth={2}
            />
          )}
          <G transform={`translate(${hx} ${bot + 2})`}>
            <Rect x={-15} width={30} height={16} rx={8} fill={colors.ink} />
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
