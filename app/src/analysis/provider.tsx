import { useAppData } from "../components/data-provider";
import { registerDataDrain } from "../storage/maintenance";
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
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";
import { AppState } from "react-native";
import { router, usePathname } from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import { ask, toast, whenDialogIdle } from "../components/overlay";
import { AnalysisClient } from "./client";
import { AnalysisController } from "./controller";
import { analysisStorage } from "./storage";
import { active } from "./types";
import { tokenStore } from "./token";
import { RealtimeController } from "./realtime-controller";
import { claimFirstReview, firstReviewKey } from "./first-review";
const RealtimeContext = createContext<RealtimeController | null>(null);
type Review = { id: string; jump: () => void };
const Context = createContext<{
  controller: AnalysisController;
  watchReview: (review: Review) => () => void;
} | null>(null);
export function AnalysisProvider({ children }: PropsWithChildren) {
  const { revision } = useAppData();
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
  useEffect(() => registerDataDrain(() => controller.idle()), [controller]);
  useEffect(() => {
    let paid = client.access.snapshot.entitlement.paid;
    return client.access.subscribe(() => {
      const next = client.access.snapshot.entitlement.paid;
      if (next === paid) return;
      paid = next;
      void controller.sync();
      if (!next) realtime.revokeAccess();
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
  const reviewing = useRef<Review | null>(null);
  const context = useMemo(
    () => ({
      controller,
      watchReview(review: Review) {
        reviewing.current = review;
        return () => {
          if (reviewing.current === review) reviewing.current = null;
        };
      },
    }),
    [controller],
  );
  const pathRef = useRef(path);
  useLayoutEffect(() => {
    pathRef.current = path;
  }, [path]);
  useEffect(() => {
    const inForeground = () =>
      !["background", "inactive"].includes(AppState.currentState ?? "");
    const notice = (id: string, failed: boolean) => {
      if (pathRef.current === `/game/${id}`) {
        toast(failed ? "解析を終えられませんでした" : "解析が終わりました");
        return;
      }
      toast(
        failed
          ? "対局の解析を終えられませんでした"
          : "対局の解析が終わりました",
        {
          label: "開く",
          onPress: () => router.push(`/game/${id}`),
        },
      );
    };
    // 保存後の完了通知だけが対象。既存解析を開くだけでは初回フラグを使わない。
    controller.onNotify((id, failed) => {
      const screen = reviewing.current;
      const sameScreen = () =>
        reviewing.current === screen &&
        inForeground() &&
        pathRef.current === `/game/${id}`;
      if (failed || screen?.id !== id || !sameScreen()) {
        notice(id, failed);
        return;
      }
      void (async () => {
        let pending: Promise<void> | undefined;
        while (sameScreen() && (pending = whenDialogIdle())) await pending;
        if (!sameScreen() || !(await claimFirstReview(db)))
          return notice(id, false);
        // フラグの保存中に開かれたダイアログも置き換えない。
        while (sameScreen() && (pending = whenDialogIdle())) await pending;
        if (!sameScreen()) {
          await db.runAsync("DELETE FROM settings WHERE key=?", firstReviewKey);
          return notice(id, false);
        }
        ask({
          title: "はじめての解析ができました",
          text: "グラフの印をタップすると、その手に移れます。盤の駒を動かせば、別の手も試せます。まずは、印のついた手を見てみましょう。",
          ok: "見てみる",
          single: true,
          image: "learn-first",
          onOk: () => {
            if (sameScreen()) screen.jump();
          },
        });
      })().catch(() => notice(id, false));
    });
  }, [controller, db]);
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
  }, [controller, revision]);
  return (
    <Context.Provider value={context}>
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
  const { controller, watchReview } = useContext(Context)!;
  const state = useSyncExternalStore(
    controller.subscribe,
    () => controller.snapshot,
    () => controller.snapshot,
  );
  const { entitlement } = useEntitlements();
  return {
    ...state,
    // 残数を算出したプランを照会結果と照合する画面には、書き換える前の値も渡す。
    serverQuota: state.quota,
    watchReview,
    quota: state.quota ? { ...state.quota, paid: entitlement.paid } : null,
    controller,
  };
}
