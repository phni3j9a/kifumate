import type { Saved, Score } from "../analysis/types";
export const focuses = [
  "総合",
  "序盤の駒組み",
  "中盤の攻防",
  "終盤",
  "悪手・改善点",
] as const;
export const details = ["かんたん", "ふつう", "くわしく"] as const;
export const practices = [
  "四間飛車",
  "三間飛車",
  "中飛車",
  "向かい飛車",
  "相振り飛車",
  "矢倉",
  "角換わり",
  "相掛かり",
  "横歩取り",
  "雁木",
  "棒銀",
  "右四間飛車",
] as const;
export interface Style {
  focus: (typeof focuses)[number];
  detail: (typeof details)[number];
}
export interface Profile {
  practice: string[];
  goal: string;
  style: Style;
}
export const defaultProfile: Profile = {
  practice: [],
  goal: "",
  style: { focus: "総合", detail: "ふつう" },
};
export interface CoachQuota {
  remainingRatio: number;
  resetsAt: number;
  low: boolean;
  exhausted: boolean;
}
export const coachLimitTitle = "今週のAIコーチは上限に達しました";
export const coachReset = "月曜0時（日本時間）に、また使えます";
export function isCoachQuota(value: unknown): value is CoachQuota {
  if (!value || typeof value !== "object") return false;
  const q = value as Partial<CoachQuota>;
  return (
    typeof q.remainingRatio === "number" &&
    q.remainingRatio >= 0 &&
    q.remainingRatio <= 1 &&
    Number.isFinite(q.resetsAt) &&
    typeof q.low === "boolean" &&
    typeof q.exhausted === "boolean"
  );
}
export interface Reference {
  id: string;
  ply: number;
  score: Score | null;
  pv: string[];
  provenMate: boolean;
}
export interface Section {
  kind: "facts" | "advice";
  title: string;
  text: string;
  references: Reference[];
}
export interface CoachReply {
  requestId: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  expiresAt: number;
  error: string | null;
  sections?: Section[];
  quota: CoachQuota;
}
export interface CoachOverview {
  paid: boolean;
  quota: CoachQuota;
  latest: CoachReply | null;
}
export interface Message {
  role: "user" | "assistant";
  content: string;
}
export interface CoachInput {
  requestId: string;
  analysis: Pick<Saved, "initial" | "moves" | "mode" | "results">;
  proof: unknown;
  perspective: "sente" | "gote" | "observer";
  profile: Pick<Profile, "practice" | "goal">;
  style: Style;
  history: Message[];
  question?: string;
}
export interface Answer {
  requestId: string;
  sections: Section[];
  style: Style;
  question?: string;
}
export interface CoachRecord {
  failedQuestion?: string;
  gameId: string;
  answers: Answer[];
  attempt: { input: CoachInput; sentAt: number | null; cancel: boolean } | null;
  error: string | null;
}
export function quotaNotice(q: CoachQuota | null) {
  if (q?.exhausted) return `${coachLimitTitle}。${coachReset}。`;
  return q?.low ? "今週のAIコーチは残りわずかです" : "";
}
