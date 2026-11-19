import { useLayoutEffect, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import Svg, { Line } from "react-native-svg";
import { colors, line, radius } from "./theme";
import { useReduceMotion } from "./use-reduce-motion";

const easing = Easing.bezier(0.3, 0.9, 0.4, 1);

export function ChanceBar({
  chance,
  label,
  terminal,
  visible,
}: {
  chance: number | null;
  label: string;
  terminal: boolean;
  visible: boolean;
}) {
  const reduce = useReduceMotion();
  // 未知や画面離脱では塗りをマウントし直す。古い幅を次の局面に持ち越さない。
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={label}
      style={[s.track, chance !== null && { backgroundColor: colors.opp }]}
    >
      {chance === null ? (
        <BarStripes color={colors.barStripe} size={6} />
      ) : (
        <>
          <Fill
            key={String(visible)}
            target={terminal ? chance : Math.max(4, Math.min(96, chance))}
            animate={visible && !reduce}
          />
          <Svg width={2} height="100%" style={s.mid} pointerEvents="none">
            <Line
              x1={1}
              x2={1}
              y1={0}
              y2="100%"
              stroke={colors.ink}
              strokeOpacity={0.5}
              strokeWidth={2}
              strokeDasharray="2 2"
            />
          </Svg>
        </>
      )}
    </View>
  );
}

function Fill({ target, animate }: { target: number; animate: boolean }) {
  const [fill] = useState(() => {
    const value = new Animated.Value(target);
    return {
      value,
      width: value.interpolate({
        inputRange: [0, 100],
        outputRange: ["0%", "100%"],
      }),
    };
  });
  useLayoutEffect(() => {
    // useNativeDriver を使えない幅のみ。stop() は今の値を保ち、次の timing がそこから始まる。
    if (!animate) {
      fill.value.setValue(target);
      return;
    }
    const animation = Animated.timing(fill.value, {
      toValue: target,
      duration: 280,
      easing,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [target, animate, fill]);
  return (
    <Animated.View style={[s.fill, { width: fill.width }]}>
      <View style={s.edge} />
    </Animated.View>
  );
}

/** 135°の静止柄。ゲージの未知状態と解析進捗で使う。 */
export function BarStripes({ color, size }: { color: string; size: number }) {
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });
  const lines = [];
  const stride = size * 2 * Math.SQRT2;
  for (let x = stride * 0.75; x < width + height; x += stride) lines.push(x);
  return (
    <View
      aria-hidden
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      onLayout={(e) => setSize(e.nativeEvent.layout)}
    >
      <Svg width={width} height={height}>
        {lines.map((x) => (
          <Line
            key={x}
            x1={x + size}
            y1={-size}
            x2={x - height - size}
            y2={height + size}
            stroke={color}
            strokeWidth={size}
          />
        ))}
      </Svg>
    </View>
  );
}

const s = StyleSheet.create({
  track: {
    height: 13,
    borderWidth: line.ol,
    borderColor: colors.ink,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
    overflow: "hidden",
  },
  fill: { height: "100%", backgroundColor: colors.you, overflow: "hidden" },
  edge: {
    position: "absolute",
    width: 2,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: colors.ink,
  },
  mid: { position: "absolute", left: "50%", marginLeft: -1, top: 0, bottom: 0 },
});
