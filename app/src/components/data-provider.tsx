import { clearExpiredBackups } from "../storage/backup-file";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type PropsWithChildren,
} from "react";
import { useSQLiteContext } from "expo-sqlite";
import { Problem, Screen } from "./ui";
const Context = createContext({
  completed: false,
  revision: 0,
  complete: async () => {},
  reload: async () => {},
});
export const useAppData = () => useContext(Context);
export function DataProvider({ children }: PropsWithChildren) {
  const db = useSQLiteContext();
  const [completed, setCompleted] = useState<boolean | null>(null),
    [revision, setRevision] = useState(0),
    [error, setError] = useState(false);
  const load = useCallback(async () => {
    const r = await db.getFirstAsync<{ value: string }>(
      "SELECT value FROM settings WHERE key='onboardingCompleted'",
    );
    setCompleted(r?.value === "true");
  }, [db]);
  useEffect(() => {
    clearExpiredBackups();
    void db
      .getFirstAsync<{ value: string }>(
        "SELECT value FROM settings WHERE key='onboardingCompleted'",
      )
      .then((r) => setCompleted(r?.value === "true"))
      .catch(() => setError(true));
  }, [db]);
  if (error)
    return (
      <Screen>
        <Problem text="設定を読めませんでした。データは消していません。アプリを開き直してください。" />
      </Screen>
    );
  if (completed === null) return null;
  return (
    <Context.Provider
      value={{
        completed,
        revision,
        complete: async () => {
          await db.runAsync(
            "INSERT INTO settings VALUES ('onboardingCompleted','true') ON CONFLICT(key) DO UPDATE SET value='true'",
          );
          setCompleted(true);
        },
        reload: async () => {
          await load();
          setRevision((r) => r + 1);
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
