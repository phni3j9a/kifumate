import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type PropsWithChildren } from "react";
import { AppState } from "react-native";
import { router, usePathname } from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import { toast } from "../components/overlay";
import { AnalysisClient } from "./client";
import { AnalysisController } from "./controller";
import { analysisStorage } from "./storage";
import { tokenStore } from "./token";
const Context = createContext<AnalysisController | null>(null);
export function AnalysisProvider({children}: PropsWithChildren) {
  const db = useSQLiteContext(), path = usePathname(), current = useRef(path);
  current.current = path;
  const controller = useMemo(() => new AnalysisController(new AnalysisClient((process.env.EXPO_PUBLIC_ANALYSIS_URL || "").replace(/\/$/, ""), tokenStore), analysisStorage(db), (id, failed) => {
    if (current.current === `/game/${id}`) { toast(failed ? "解析を終えられませんでした" : "解析が終わりました"); return; }
    toast(failed ? "対局の解析を終えられませんでした" : "対局の解析が終わりました", {label: "開く", onPress: () => router.push(`/game/${id}`)});
  }), [db]);
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const tick = async () => { if (!alive) return; if (AppState.currentState !== "background" && AppState.currentState !== "inactive") await controller.sync(); if (alive) timer = setTimeout(tick, 2000); };
    controller.init().then(tick).catch(() => toast("解析結果を読めませんでした。端末内のデータは消していません"));
    const sub = AppState.addEventListener("change", state => { if (state === "active") { clearTimeout(timer); void tick(); } });
    return () => { alive = false; clearTimeout(timer); sub.remove(); };
  }, [controller]);
  return <Context.Provider value={controller}>{children}</Context.Provider>;
}
export function useAnalysis() {
  const controller = useContext(Context)!;
  const state = useSyncExternalStore(controller.subscribe, () => controller.snapshot, () => controller.snapshot);
  return {...state, controller};
}
