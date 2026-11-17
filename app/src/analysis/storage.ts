import type { SQLiteDatabase } from "expo-sqlite";
import type { Analysis, Quota } from "./types";
export function analysisStorage(db: SQLiteDatabase) {
  return {
    async load(): Promise<Analysis[]> { return (await db.getAllAsync<{document: string}>("SELECT document FROM analyses")).map(r => JSON.parse(r.document)); },
    async save(a: Analysis) { await db.runAsync("INSERT INTO analyses(game_id,document) SELECT ?,? WHERE EXISTS(SELECT 1 FROM games WHERE id=?) ON CONFLICT(game_id) DO UPDATE SET document=excluded.document", a.gameId, JSON.stringify(a), a.gameId); },
    async quota(): Promise<Quota | null> { const r = await db.getFirstAsync<{value: string}>("SELECT value FROM analysis_meta WHERE key='quota'"); return r ? JSON.parse(r.value) : null; },
    async saveQuota(q: Quota) { await db.runAsync("INSERT INTO analysis_meta VALUES ('quota',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(q)); },
  };
}
export type AnalysisStorage = ReturnType<typeof analysisStorage>;
