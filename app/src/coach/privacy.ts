import { PieceType, standardPieceName } from "tsshogi";
import { classificationCatalog } from "../core/classify/rules";
import type { CoachInput, Message, Profile, Style } from "./types";
import type { Saved } from "../analysis/types";
import type { Game } from "../storage/repository";
// 照合だけで空白・全半角・不可視文字の差を除き、送る文の数字や表記は保つ。
const normalize = (s: string) =>
  s
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .normalize("NFKC")
    .replace(/\s/gu, "");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const shogiTerms = new RegExp(
  [
    ...Object.values(PieceType).map(standardPieceName),
    "王",
    "王将",
    "玉将",
    "歩兵",
    "香車",
    "桂馬",
    "銀将",
    "金将",
    "角行",
    "飛車",
    "と金",
    "龍",
    "龍王",
    "竜王",
    "龍馬",
    "竜馬",
    "居飛車",
    "振り飛車",
    ...classificationCatalog.strategies.map((t) => t.name),
    ...classificationCatalog.castles.map((t) => t.name),
  ]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join("|"),
  "gu",
);
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
    } else if (!/[\s\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(char)) {
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
  const pattern = new RegExp(keys.map(escape).join("|"), "giu");
  const terms = [...comparable.matchAll(shogiTerms)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
  }));
  let result = "",
    previous = 0;
  for (const match of comparable.matchAll(pattern)) {
    const honorific = /^(?:さん|くん|君|ちゃん|氏|様|さま|先生|殿)/u.test(
      comparable.slice(match.index + match[0].length),
    );
    // 敬称なら人名を優先し、それ以外は既知の将棋用語と敬称のない1文字を保って誤置換を防ぐ。
    if (
      !honorific &&
      ([...match[0]].length === 1 ||
        terms.some(
          (t) =>
            t.start <= match.index && t.end >= match.index + match[0].length,
        ))
    )
      continue;
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
    profile: { practice: profile.practice, goal: hide(profile.goal) },
    style,
    history: history
      .slice(-20)
      .map((m) => ({ role: m.role, content: hide(m.content).slice(0, 4000) })),
    ...(question === undefined ? {} : { question: hide(question) }),
  };
}
