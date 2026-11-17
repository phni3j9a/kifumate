import { useAppData } from "./data-provider";
import { dataPaused, registerDataDrain } from "../storage/maintenance";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type PropsWithChildren,
} from "react";
import { AppState } from "react-native";
import { useSQLiteContext } from "expo-sqlite";
import { reclassifyGames } from "../storage/classifications";
import { toast } from "./overlay";
const Context = createContext({ revision: 0, pending: false });
export const useClassifications = () => useContext(Context);
export function ClassificationsProvider({ children }: PropsWithChildren) {
  const db = useSQLiteContext();
  const { revision: dataRevision } = useAppData();
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(true);
  useEffect(() => {
    let disposed = false,
      running = false,
      active = AppState.currentState !== "background";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      if (timer || disposed) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!disposed) setRevision((r) => r + 1);
      }, 100);
    };
    let work: Promise<void> = Promise.resolve();
    const unregister = registerDataDrain(() => work);
    const run = async () => {
      if (disposed || running || !active || dataPaused) return;
      running = true;
      setPending(true);
      try {
        work = reclassifyGames(
          db,
          changed,
          () => disposed || !active || dataPaused,
        );
        await work;
      } catch {
        if (!disposed)
          toast("分類を保存できませんでした。次に開いたときにもう一度試します");
      } finally {
        running = false;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
          if (!disposed) setRevision((r) => r + 1);
        }
        if (!disposed) setPending(false);
      }
    };
    void run();
    const sub = AppState.addEventListener("change", (state) => {
      active = state === "active";
      if (active) void run();
    });
    return () => {
      disposed = true;
      unregister();
      clearTimeout(timer);
      sub.remove();
    };
  }, [db, dataRevision]);
  return (
    <Context.Provider value={{ revision, pending }}>
      {children}
    </Context.Provider>
  );
}
