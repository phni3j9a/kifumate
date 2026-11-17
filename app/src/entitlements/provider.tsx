import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";
import { AppState } from "react-native";
import type { EntitlementController } from "./controller";
const Context = createContext<EntitlementController | null>(null);
export function EntitlementsProvider({
  controller,
  children,
}: PropsWithChildren<{ controller: EntitlementController }>) {
  const state = useSyncExternalStore(
    controller.subscribe,
    () => controller.snapshot,
    () => controller.snapshot,
  );
  useEffect(() => {
    const refresh = () => {
      controller.expire();
      void controller.refresh().catch(() => {});
    };
    refresh();
    const sub = AppState.addEventListener("change", (value) => {
      if (value === "active") refresh();
    });
    return () => sub.remove();
  }, [controller]);
  useEffect(() => {
    const expiry = state.entitlement.expiresAt;
    if (expiry === null) return;
    // 長い期限はsetTimeoutの32bit上限を超えない間隔で確認する。
    const timer = setTimeout(
      () => {
        controller.expire();
        void controller.refresh().catch(() => {});
      },
      Math.min(2147483647, Math.max(0, expiry - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [controller, state]);
  return <Context.Provider value={controller}>{children}</Context.Provider>;
}
export function useEntitlements() {
  const controller = useContext(Context)!;
  const state = useSyncExternalStore(
    controller.subscribe,
    () => controller.snapshot,
    () => controller.snapshot,
  );
  return { ...state, controller };
}
