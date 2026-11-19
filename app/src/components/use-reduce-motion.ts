import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

export function useReduceMotion() {
  // 設定を読めるまでは動かさない。変更イベントの後に古い初期値を適用しない。
  const [reduce, setReduce] = useState(true);
  useEffect(() => {
    let pending = true;
    const sub = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (value) => {
        pending = false;
        setReduce(value);
      },
    );
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (value) => {
        if (pending) setReduce(value);
      },
      () => {},
    );
    return () => {
      pending = false;
      sub.remove();
    };
  }, []);
  return reduce;
}
