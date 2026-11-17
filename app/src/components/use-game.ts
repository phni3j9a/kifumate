import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import type { Game } from "../storage/repository";
export function useGame(id: string) {
  const db = useSQLiteContext();
  const [game, setGame] = useState<Game | null>(null);
  const [error, setError] = useState("");
  useFocusEffect(
    useCallback(() => {
      let active = true;
      db.getFirstAsync<Game>("SELECT * FROM games WHERE id=?", id)
        .then((g) => {
          if (active) {
            setGame(g);
            setError(
              g ? "" : "棋譜が見つかりません。一覧から開き直してください。",
            );
          }
        })
        .catch(() => {
          if (active)
            setError(
              "棋譜を読み込めませんでした。一覧に戻って、もう一度開いてください。",
            );
        });
      return () => {
        active = false;
      };
    }, [db, id]),
  );
  return { game, error, db };
}
