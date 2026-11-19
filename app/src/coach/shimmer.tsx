import { useEffect, useState } from "react";
import { Animated, Easing, Platform, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { colors } from "../components/theme";
import { useReduceMotion } from "../components/use-reduce-motion";

export function CoachSkeleton({ active }: { active: boolean }) {
  const [width, setWidth] = useState(0);
  const [position] = useState(() => new Animated.Value(0));
  const moving = !useReduceMotion() && active && width > 0;
  useEffect(() => {
    if (!moving) return;
    const animation = Animated.loop(
      Animated.timing(position, {
        toValue: 1,
        duration: 1100,
        easing: Easing.linear,
        useNativeDriver: Platform.OS !== "web",
        isInteraction: false,
      }),
    );
    animation.start();
    return () => {
      animation.stop();
      position.setValue(0);
    };
  }, [moving, position]);
  const band = width * 0.4;
  const x = position.interpolate({
    inputRange: [0, 1],
    outputRange: [-band, width],
  });
  return (
    <View aria-hidden onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {[100, 100, 100, 62, 100, 80].map((w, i) => (
        <View
          key={i}
          style={{
            height: 11,
            marginTop: i === 4 ? 20 : 9,
            marginHorizontal: 2,
            borderRadius: 6,
            backgroundColor: colors.skeleton,
            width: `${w}%`,
            maxWidth: "99%",
            overflow: "hidden",
          }}
        >
          {moving && (
            <Animated.View
              style={{ width: band, transform: [{ translateX: x }] }}
            >
              <Svg width={band} height={11}>
                <Defs>
                  <LinearGradient
                    id={`shimmer-${i}`}
                    x1="0"
                    x2="100%"
                    y1="0"
                    y2="0"
                  >
                    <Stop offset="0" stopColor={colors.skeleton} />
                    <Stop offset="0.5" stopColor={colors.skeletonHighlight} />
                    <Stop offset="1" stopColor={colors.skeleton} />
                  </LinearGradient>
                </Defs>
                <Rect width={band} height={11} fill={`url(#shimmer-${i})`} />
              </Svg>
            </Animated.View>
          )}
        </View>
      ))}
    </View>
  );
}
