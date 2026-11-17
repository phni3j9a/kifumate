import type { SQLiteDatabase } from "expo-sqlite";
import type { ImmutableRecord } from "tsshogi";
import {
  classifyRecordAsync,
  classifyUsiAsync,
  rulesVersion,
} from "../core/classify";
import { classificationCatalog, type Family } from "../core/classify";
import type { PlayerSide, TagKind } from "../core/stats";

export const classificationSelect = `SELECT games.*, classifications.automatic AS classification_auto,
  classifications.manual AS classification_manual, classifications.error AS classification_error
  FROM games LEFT JOIN classifications ON classifications.game_id=games.id`;

export async function classifyForStorage(record: ImmutableRecord) {
  try {
    return {
      automatic: JSON.stringify(await classifyRecordAsync(record)),
      error: null,
    };
  } catch {
    // 両玉がない途中図など、読み取り可能でも分類できない棋譜は保持する。
    return {
      automatic: null,
      error: "この棋譜は自動判定できませんでした。修正から指定できます。",
    };
  }
}
export async function saveAutomatic(
  db: SQLiteDatabase,
  id: string,
  result: Awaited<ReturnType<typeof classifyForStorage>>,
  version = rulesVersion,
) {
  await db.runAsync(
    `INSERT INTO classifications (game_id,rules_version,automatic,error)
    SELECT id,?,?,? FROM games WHERE id=?
    ON CONFLICT(game_id) DO UPDATE SET rules_version=excluded.rules_version, automatic=excluded.automatic, error=excluded.error`,
    version,
    result.automatic,
    result.error,
    id,
  );
}
/** 一度に1局だけ読み、対局間と判定中にイベントループへ戻る。手動の列には触れない。 */
export async function reclassifyGames(
  db: SQLiteDatabase,
  changed: () => void = () => {},
  cancelled: () => boolean = () => false,
  version = rulesVersion,
) {
  let after = "";
  while (!cancelled()) {
    const row = await db.getFirstAsync<{ id: string; identity: string }>(
      `SELECT games.id, games.identity FROM games LEFT JOIN classifications ON classifications.game_id=games.id
      WHERE games.id>? AND (classifications.rules_version IS NULL OR classifications.rules_version<>?) ORDER BY games.id LIMIT 1`,
      after,
      version,
    );
    if (!row) return;
    after = row.id;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (cancelled()) return;
    let result: Awaited<ReturnType<typeof classifyForStorage>>;
    try {
      const [initial, moves] = JSON.parse(row.identity) as [string, string[]];
      result = {
        automatic: JSON.stringify(
          await classifyUsiAsync(`${initial} 1`, moves),
        ),
        error: null,
      };
    } catch {
      result = {
        automatic: null,
        error: "この棋譜は自動判定できませんでした。修正から指定できます。",
      };
    }
    if (cancelled()) return;
    await saveAutomatic(db, row.id, result, version);
    changed();
  }
}
export async function setTags(
  db: SQLiteDatabase,
  id: string,
  side: PlayerSide,
  kind: TagKind,
  ids: string[],
  family?: Family | "未分類",
) {
  if (
    !["black", "white"].includes(side) ||
    !["strategies", "castles"].includes(kind)
  )
    throw new Error("分類の指定が正しくありません");
  if (ids.some((id) => !classificationCatalog[kind].some((c) => c.id === id)))
    throw new Error("未対応の分類です");
  if (
    kind === "strategies" &&
    !["居飛車", "振り飛車", "未分類"].includes(family ?? "")
  )
    throw new Error("大分類を指定してください");
  await db.runAsync(
    `INSERT INTO classifications (game_id) SELECT id FROM games WHERE id=? ON CONFLICT(game_id) DO NOTHING`,
    id,
  );
  const path = `$.${side}.${kind}`;
  if (kind === "strategies") {
    await db.runAsync(
      `UPDATE classifications SET manual=json_set(manual,?,json(?),?,?) WHERE game_id=?`,
      path,
      JSON.stringify([...new Set(ids)]),
      `$.${side}.family`,
      family!,
      id,
    );
  } else {
    await db.runAsync(
      `UPDATE classifications SET manual=json_set(manual,?,json(?)) WHERE game_id=?`,
      path,
      JSON.stringify([...new Set(ids)]),
      id,
    );
  }
}
export async function resetTags(
  db: SQLiteDatabase,
  id: string,
  side: PlayerSide,
) {
  if (!["black", "white"].includes(side))
    throw new Error("先後を指定してください");
  await db.runAsync(
    "UPDATE classifications SET manual=json_remove(manual,?) WHERE game_id=?",
    `$.${side}`,
    id,
  );
}
