import type { CoachInput, Message, Profile, Style } from "./types";
import type { Saved } from "../analysis/types";
import type { Game } from "../storage/repository";
// サーバーの正規化より前に、全角・大小文字・不可視文字違いの登録名も伏せる。
const normalize = (s: string) =>
  s.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "").normalize("NFKC");
export function redact(
  text: string,
  aliases: string[],
  game: Pick<Game, "black" | "white" | "self_side">,
) {
  const names = new Map<string, string>();
  for (const n of aliases)
    if (n.trim()) names.set(normalize(n.trim()).toLowerCase(), "あなた");
  for (const side of ["black", "white"] as const) {
    const n = normalize(game[side].trim()).toLowerCase();
    if (n)
      names.set(
        n,
        game.self_side
          ? game.self_side === side
            ? "あなた"
            : "相手"
          : side === "black"
            ? "先手"
            : "後手",
      );
  }
  const keys = [...names.keys()]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!keys.length) return text;
  // 照合用の正規化文字と元の範囲を対応させ、名前以外（評価の符号・全角数字等）は変えない。
  const clusters: { text: string; start: number; end: number }[] = [];
  let offset = 0;
  for (const char of text) {
    const end = offset + char.length;
    if (/[\p{M}\uFF9E\uFF9F]/u.test(char) && clusters.length) {
      const last = clusters[clusters.length - 1]!;
      last.text += char;
      last.end = end;
    } else if (!/[\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(char)) {
      clusters.push({ text: char, start: offset, end });
    }
    offset = end;
  }
  let comparable = "";
  const spans: { start: number; end: number }[] = [];
  for (const cluster of clusters) {
    const normalized = normalize(cluster.text);
    comparable += normalized;
    for (let i = 0; i < normalized.length; i++) spans.push(cluster);
  }
  const pattern = new RegExp(
    keys.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "giu",
  );
  let result = "",
    previous = 0;
  for (const match of comparable.matchAll(pattern)) {
    const first = spans[match.index!]!,
      last = spans[match.index! + match[0].length - 1]!;
    if (first.start < previous) continue;
    result +=
      text.slice(previous, first.start) + names.get(match[0].toLowerCase())!;
    previous = last.end;
  }
  return result + text.slice(previous);
}
export function coachInput(
  requestId: string,
  saved: Saved,
  game: Pick<Game, "black" | "white" | "self_side">,
  aliases: string[],
  profile: Profile,
  style: Style,
  history: Message[],
  question?: string,
): CoachInput {
  const hide = (s: string) => redact(s, aliases, game);
  return {
    requestId,
    analysis: {
      initial: saved.initial,
      moves: saved.moves,
      mode: saved.mode,
      results: saved.results,
    },
    proof: saved.coachProof,
    perspective:
      game.self_side === "black"
        ? "sente"
        : game.self_side === "white"
          ? "gote"
          : "observer",
    profile: { practice: profile.practice.map(hide), goal: hide(profile.goal) },
    style,
    history: history
      .slice(-20)
      .map((m) => ({ role: m.role, content: hide(m.content).slice(0, 4000) })),
    ...(question === undefined ? {} : { question: hide(question) }),
  };
}
