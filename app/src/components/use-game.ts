import { useCallback, useEffect, useRef, useState } from "react";
import { useClassifications } from "./classifications-provider";
import { useFocusEffect } from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import { getGame, type Game } from "../storage/repository";
export function useGame(id: string) {
  const db = useSQLiteContext();
  const { revision } = useClassifications();
  const [game, setGame] = useState<Game | null>(null);
  const [error, setError] = useState("");
  const live = useRef(false);
  const reload = useCallback(async () => {
    try {
      const g = await getGame(db, id);
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
  useEffect(() => {
    if (!revision) return;
    const timer = setTimeout(() => void reload(), 0);
    return () => clearTimeout(timer);
  }, [reload, revision]);
  return { game, error, db, reload };
}
