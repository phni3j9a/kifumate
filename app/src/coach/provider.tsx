import { COACH_ENABLED } from "../analysis/environment";
import { useAppData } from "../components/data-provider";
import { registerDataDrain } from "../storage/maintenance";
import { useEntitlements } from "../entitlements/provider";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";
import { AppState } from "react-native";
import { router } from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import type { AnalysisClient } from "../analysis/client";
import { toast } from "../components/overlay";
import { CoachController } from "./controller";
import { coachStorage } from "./storage";
const Context = createContext<CoachController | null>(null);
const visible = new Set<string>();
export function setCoachVisible(id: string, on: boolean) {
  if (on) visible.add(id);
  else visible.delete(id);
}
export function CoachProvider({
  client,
  children,
}: PropsWithChildren<{ client: AnalysisClient }>) {
  const db = useSQLiteContext();
  const { revision } = useAppData();
  const controller = useMemo(
    () => new CoachController(client, coachStorage(db)),
    [client, db],
  );
  useEffect(() => registerDataDrain(() => controller.idle()), [controller]);
  useEffect(() => {
    if (!COACH_ENABLED) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async (restore = false) => {
      clearTimeout(timer);
      if (!live) return;
      if (
        AppState.currentState !== "background" &&
        AppState.currentState !== "inactive" &&
        (restore || (visible.size > 0 && controller.busy))
      )
        await controller.sync();
      if (live) timer = setTimeout(() => void tick(), 3000);
    };
    controller.onNotify((id, failed) => {
      if (visible.has(id)) return;
      toast(
        failed
          ? "AIコーチの解説を終えられませんでした"
          : "AIコーチの解説ができました",
        {
          label: "開く",
          onPress: () =>
            router.push({ pathname: "/game/[id]", params: { id, coach: "1" } }),
        },
      );
    });
    void controller
      .init()
      .then(() => tick(true))
      .catch(() =>
        toast("解説を読めませんでした。端末内のデータは消していません"),
      );
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void tick(true);
      else clearTimeout(timer);
    });
    return () => {
      live = false;
      clearTimeout(timer);
      sub.remove();
    };
  }, [controller, revision]);
  return <Context.Provider value={controller}>{children}</Context.Provider>;
}
export function useCoach() {
  const controller = useContext(Context)!;
  const state = useSyncExternalStore(
    controller.subscribe,
    () => controller.snapshot,
    () => controller.snapshot,
  );
  const { entitlement } = useEntitlements();
  return { ...state, paid: entitlement.paid, controller };
}
