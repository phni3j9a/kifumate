import { API_URL, ALLOW_DEVELOPMENT_ACCESS } from "./environment";
import {
  EntitlementsProvider,
  useEntitlements,
} from "../entitlements/provider";
import { CoachProvider } from "../coach/provider";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";
import { AppState } from "react-native";
import { router, usePathname } from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import { toast } from "../components/overlay";
import { AnalysisClient } from "./client";
import { AnalysisController } from "./controller";
import { analysisStorage } from "./storage";
import { active } from "./types";
import { tokenStore } from "./token";
import { RealtimeController } from "./realtime-controller";
const RealtimeContext = createContext<RealtimeController | null>(null);
const Context = createContext<AnalysisController | null>(null);
export function AnalysisProvider({ children }: PropsWithChildren) {
  const db = useSQLiteContext(),
    path = usePathname();
  const client = useMemo(
    () =>
      new AnalysisClient(
        API_URL,
        tokenStore,
        undefined,
        ALLOW_DEVELOPMENT_ACCESS,
      ),
    [],
  );
  const controller = useMemo(
    () => new AnalysisController(client, analysisStorage(db)),
    [client, db],
  );
  const realtime = useMemo(() => new RealtimeController(client), [client]);
  useEffect(() => {
    let paid = client.access.snapshot.entitlement.paid;
    return client.access.subscribe(() => {
      const next = client.access.snapshot.entitlement.paid;
      if (next === paid) return;
      paid = next;
      void controller.sync();
      if (!next) void realtime.stop();
      else realtime.retry();
    });
  }, [client, controller, realtime]);
  useEffect(() => {
    realtime.setForeground(
      AppState.currentState !== "background" &&
        AppState.currentState !== "inactive",
    );
    const sub = AppState.addEventListener("change", (state) =>
      realtime.setForeground(state === "active"),
    );
    return () => {
      sub.remove();
      realtime.setVisible(false);
    };
  }, [realtime]);
  useEffect(() => {
    controller.onNotify((id, failed) => {
      if (path === `/game/${id}`) {
        toast(failed ? "解析を終えられませんでした" : "解析が終わりました");
        return;
      }
      toast(
        failed
          ? "対局の解析を終えられませんでした"
          : "対局の解析が終わりました",
        { label: "開く", onPress: () => router.push(`/game/${id}`) },
      );
    });
  }, [controller, path]);
  useEffect(() => {
    let alive = true,
      lastSync = 0,
      timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!alive) return;
      if (
        AppState.currentState !== "background" &&
        AppState.currentState !== "inactive" &&
        (Object.values(controller.snapshot.records).some(active) ||
          Date.now() - lastSync > 30000)
      ) {
        await controller.sync();
        lastSync = Date.now();
      }
      if (alive) {
        clearTimeout(timer);
        timer = setTimeout(tick, 2000);
      }
    };
    controller
      .init()
      .then(tick)
      .catch(() =>
        toast("解析結果を読めませんでした。端末内のデータは消していません"),
      );
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        lastSync = 0;
        clearTimeout(timer);
        void tick();
      }
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      sub.remove();
    };
  }, [controller]);
  return (
    <Context.Provider value={controller}>
      <RealtimeContext.Provider value={realtime}>
        <EntitlementsProvider controller={client.access}>
          <CoachProvider client={client}>{children}</CoachProvider>
        </EntitlementsProvider>
      </RealtimeContext.Provider>
    </Context.Provider>
  );
}
export function useRealtime() {
  const controller = useContext(RealtimeContext)!;
  const state = useSyncExternalStore(
    controller.subscribe,
    () => controller.snapshot,
    () => controller.snapshot,
  );
  const { entitlement, checked } = useEntitlements();
  return { ...state, paid: checked ? entitlement.paid : null, controller };
}
export function useAnalysis() {
  const controller = useContext(Context)!;
  const state = useSyncExternalStore(
    controller.subscribe,
    () => controller.snapshot,
    () => controller.snapshot,
  );
  const { entitlement } = useEntitlements();
  return {
    ...state,
    quota: state.quota ? { ...state.quota, paid: entitlement.paid } : null,
    controller,
  };
}
