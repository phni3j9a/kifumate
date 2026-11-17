import type { SQLiteDatabase } from "expo-sqlite";
import {
  defaultProfile,
  type CoachRecord,
  type Profile,
  type CoachOverview,
} from "./types";
export function coachStorage(db: SQLiteDatabase) {
  const get = async <T>(key: string): Promise<T | null> => {
    const row = await db.getFirstAsync<{ value: string }>(
      "SELECT value FROM coach_meta WHERE key=?",
      key,
    );
    return row ? JSON.parse(row.value) : null;
  };
  const put = (key: string, value: unknown) =>
    db.runAsync(
      "INSERT INTO coach_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  return {
    async load(): Promise<CoachRecord[]> {
      return (
        await db.getAllAsync<{ document: string }>(
          "SELECT document FROM coaches",
        )
      ).map((r) => JSON.parse(r.document));
    },
    async save(r: CoachRecord) {
      await db.runAsync(
        "INSERT INTO coaches(game_id,document) SELECT ?,? WHERE EXISTS(SELECT 1 FROM games WHERE id=?) ON CONFLICT(game_id) DO UPDATE SET document=excluded.document",
        r.gameId,
        JSON.stringify(r),
        r.gameId,
      );
    },
    async profile(): Promise<Profile> {
      return (
        (await get<Profile>("profile")) ?? {
          ...defaultProfile,
          practice: [],
          style: { ...defaultProfile.style },
        }
      );
    },
    async saveProfile(p: Profile) {
      await put("profile", p);
    },
    overview: () => get<CoachOverview>("overview"),
    async saveOverview(o: CoachOverview) {
      await put("overview", o);
    },
  };
}
export type CoachStorage = ReturnType<typeof coachStorage>;
