import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import type { Game } from "../storage/repository";
export function useGame(id: string) {
  const db = useSQLiteContext();
  const [game, setGame] = useState<Game | null>(null);
  const [error, setError] = useState("");
  const live = useRef(false);
  const reload = useCallback(async () => {
    try {
      const g = await db.getFirstAsync<Game>(
        "SELECT * FROM games WHERE id=?",
        id,
      );
      if (!live.current) return;
      setGame(g);
      setError(g ? "" : "棋譜が見つかりません。一覧から開き直してください。");
    } catch {
      if (live.current)
        setError(
          "棋譜を読み込めませんでした。一覧に戻って、もう一度開いてください。",
        );
    }
  }, [db, id]);
  useFocusEffect(
    useCallback(() => {
      live.current = true;
      void reload();
      return () => {
        live.current = false;
      };
    }, [reload]),
  );
  return { game, error, db, reload };
}
