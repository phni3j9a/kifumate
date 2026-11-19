import { useSyncExternalStore } from "react";

// RN Web の共有ハンドラー表を通さず、各購読を確実に解除する。
const media =
  typeof window === "undefined"
    ? null
    : window.matchMedia("(prefers-reduced-motion: reduce)");
function subscribe(listener: () => void) {
  media?.addEventListener("change", listener);
  return () => media?.removeEventListener("change", listener);
}
const snapshot = () => media?.matches ?? true;

export function useReduceMotion() {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}
