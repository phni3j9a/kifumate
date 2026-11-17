import {
  classificationCatalog,
  type Classification,
  type Family,
} from "./classify";
import { dateParts } from "./format";
import type { Game } from "../storage/repository";

export type PlayerSide = "black" | "white";
export type TagKind = "strategies" | "castles";
export interface Tags {
  family: Family | "未分類";
  strategies: string[];
  castles: string[];
}
export type ManualTags = Partial<Record<PlayerSide, Partial<Tags>>>;
export type Dimension = "myst" | "opst" | "mycs";
export interface GameFilter {
  scope?: string;
  side?: string;
  period?: string;
  myst?: string;
  opst?: string;
  mycs?: string;
  result?: string;
}
export const families: Family[] = ["居飛車", "振り飛車"];
export const unclassified = "未分類";
const tagCache = new WeakMap<Game, Record<PlayerSide, Tags>>();
export function tagsOf(game: Game, side: PlayerSide): Tags {
  let cached = tagCache.get(game);
  if (!cached) {
    const auto = game.classification_auto
      ? (JSON.parse(game.classification_auto) as Classification)
      : undefined;
    const manual = game.classification_manual
      ? (JSON.parse(game.classification_manual) as ManualTags)
      : undefined;
    const resolve = (key: PlayerSide): Tags => ({
      family: manual?.[key]?.family ?? auto?.sides[key].family ?? unclassified,
      strategies:
        manual?.[key]?.strategies ??
        auto?.sides[key].strategies.map((f) => f.id) ??
        [],
      castles:
        manual?.[key]?.castles ??
        auto?.sides[key].castles.map((f) => f.id) ??
        [],
    });
    cached = { black: resolve("black"), white: resolve("white") };
    tagCache.set(game, cached);
  }
  return cached[side];
}
export function edited(game: Game, side: PlayerSide) {
  return !!(
    game.classification_manual &&
    Object.keys(
      (JSON.parse(game.classification_manual) as ManualTags)[side] ?? {},
    ).length
  );
}
export const opposite = (side: PlayerSide): PlayerSide =>
  side === "black" ? "white" : "black";
export const tagName = (kind: TagKind, id: string) =>
  classificationCatalog[kind].find((t) => t.id === id)?.name ?? id;
export const strategyNames = (tags: Tags) =>
  tags.strategies.length
    ? tags.strategies.map((id) => tagName("strategies", id))
    : tags.family === unclassified
      ? []
      : [tags.family];
export function hasTag(tags: Tags, kind: TagKind, id: string) {
  if (kind === "strategies" && families.includes(id as Family))
    return tags.family === id;
  if (id === unclassified)
    return kind === "strategies"
      ? tags.family === unclassified && !tags.strategies.length
      : !tags.castles.length;
  return tags[kind].includes(id);
}
export function matchesGame(game: Game, filter: GameFilter, now = Date.now()) {
  if (filter.scope === "self" && !game.self_side) return false;
  if (filter.scope === "other" && game.self_side) return false;
  if (filter.side && filter.side !== game.self_side) return false;
  if (
    filter.result &&
    (!game.self_side ||
      (filter.result === "decided"
        ? !["win", "loss"].includes(game.result)
        : game.result !== filter.result))
  )
    return false;
  if (filter.period) {
    const date = dateParts(game.played_at);
    const today = new Date(now);
    const end = Date.UTC(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    );
    if (
      !date ||
      date.time > end ||
      end - date.time > Number(filter.period) * 86400000
    )
      return false;
  }
  for (const dim of ["myst", "opst", "mycs"] as const) {
    if (!filter[dim]) continue;
    if (!game.self_side) return false;
    const tags = tagsOf(
      game,
      dim === "opst" ? opposite(game.self_side) : game.self_side,
    );
    if (!hasTag(tags, dim === "mycs" ? "castles" : "strategies", filter[dim]))
      return false;
  }
  return true;
}
export function tally(games: readonly Game[]) {
  const own = [
    ...new Map(games.filter((g) => g.self_side).map((g) => [g.id, g])).values(),
  ];
  const count = (r: Game["result"]) => own.filter((g) => g.result === r).length;
  const w = count("win"),
    l = count("loss");
  return {
    n: own.length,
    w,
    l,
    d: count("draw"),
    u: count("unknown"),
    r: w + l ? Math.round((100 * w) / (w + l)) : 0,
  };
}
export const winLoss = (t: ReturnType<typeof tally>) =>
  `${t.w}勝${t.l}敗${t.d ? `${t.d}分` : ""}`;
export function statRows(games: Game[], dimension: Dimension) {
  const kind = dimension === "mycs" ? "castles" : "strategies";
  const own = games.filter((g) => g.self_side);
  const tags = (g: Game) =>
    tagsOf(g, dimension === "opst" ? opposite(g.self_side!) : g.self_side!);
  const rows: {
    id: string;
    name: string;
    depth: number;
    total: ReturnType<typeof tally>;
  }[] = [];
  const add = (id: string, depth: number, list: Game[]) => {
    if (list.length)
      rows.push({
        id,
        name: tagName(kind, id),
        depth,
        total: tally(list),
      });
  };
  const names = [...new Set(own.flatMap((g) => tags(g)[kind]))];
  const of = (id: string, list = own) =>
    list.filter((g) => hasTag(tags(g), kind, id));
  if (kind === "castles") {
    const parent = (id: string) =>
      classificationCatalog.castles.find((c) => c.id === id)?.parentId;
    const emit = (id: string, depth: number) => {
      add(id, depth, of(id));
      names.filter((n) => parent(n) === id).forEach((n) => emit(n, depth + 1));
    };
    names
      .filter((n) => !names.includes(parent(n) ?? ""))
      .sort((a, b) => of(b).length - of(a).length)
      .forEach((n) => emit(n, 0));
  } else {
    for (const family of families) {
      const list = of(family);
      add(family, 0, list);
      [...new Set(list.flatMap((g) => tags(g).strategies))]
        .sort((a, b) => of(b, list).length - of(a, list).length)
        .forEach((id) => add(id, 1, of(id, list)));
    }
    // 大分類未確定でも、具体的な戦法だけ記録されたデータを落とさない。
    for (const id of names) {
      const list = of(id).filter((g) => tags(g).family === unclassified);
      add(id, 0, list);
    }
  }
  add(unclassified, 0, of(unclassified));
  return rows;
}
