import { useEffect, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { colors } from "./theme";
import { useReduceMotion } from "./use-reduce-motion";

const ease = Easing.bezier(0.25, 0.1, 0.25, 1);
export function WaitingDots() {
  const reduce = useReduceMotion();
  const [dots] = useState(() => [0, 1, 2].map(() => new Animated.Value(0.25)));
  useEffect(() => {
    if (reduce) return;
    const animation = Animated.stagger(
      150,
      dots.map((dot) =>
        Animated.loop(
          Animated.sequence([
            Animated.timing(dot, {
              toValue: 1,
              duration: 300,
              easing: ease,
              useNativeDriver: true,
              isInteraction: false,
            }),
            Animated.timing(dot, {
              toValue: 0.25,
              duration: 300,
              easing: ease,
              useNativeDriver: true,
              isInteraction: false,
            }),
            Animated.delay(400),
          ]),
        ),
      ),
    );
    animation.start();
    return () => {
      animation.stop();
      dots.forEach((dot) => dot.setValue(0.25));
    };
  }, [dots, reduce]);
  return (
    <View
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={s.dots}
    >
      {dots.map((opacity, i) => (
        <Animated.View key={i} style={[s.dot, { opacity }]} />
      ))}
    </View>
  );
}
const s = StyleSheet.create({
  dots: { flexDirection: "row", alignItems: "center", gap: 3 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.ink },
});
