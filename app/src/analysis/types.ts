export type Mode = "std" | "precise";
export type Score = {
  kind: "cp" | "mate" | "declaration";
  value: number | null;
  winner?: "sente" | "gote";
  bound?: "lowerbound" | "upperbound";
};
export interface Candidate {
  rank: number;
  depth: number;
  score: Score | null;
  move?: string;
  declarationWin?: boolean;
  pv: string[];
}
export interface AnalysisResult {
  ply: number;
  score: Score | null;
  candidates: Candidate[];
  mate: {
    plies: 1 | 3;
    pv: string[];
    branches: { reply: string; mate: string }[];
  } | null;
}
export interface Quota {
  paid: boolean;
  weekStart: number;
  resetsAt: number;
  totalRemaining: number;
  preciseRemaining: number;
  completed: { total: number; precise: number };
  reserved: { total: number; precise: number };
}
export interface Input {
  initial: string;
  moves: string[];
  mode: Mode;
}
export interface Job {
  id: string;
  mode: Mode;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  next: number;
  total: number;
  createdAt: number;
  finishedAt: number | null;
  expiresAt: number | null;
  error: string | null;
  results: AnalysisResult[];
  coachProof: unknown;
}
export interface Reply extends Job {
  quota: Quota;
}
export interface Attempt extends Input {
  /** null は未送信。旧データの undefined は送信時刻が分からないので再依頼を確認する。 */
  firstSentAt?: number | null;
  job: Job | null;
  results: AnalysisResult[];
  cancel: boolean;
}
export interface Saved extends Input {
  results: AnalysisResult[];
  coachProof: unknown;
  jobId: string;
}
export interface Analysis {
  gameId: string;
  attempt: Attempt | null;
  saved: Saved | null;
  error: string | null;
}
// 完了直後に保持期限が始まる場合を想定し、初回送信から7日で自動再送を止める。
export const needsRetryConfirmation = (
  attempt?: Attempt | null,
  now = Date.now(),
) =>
  !!attempt &&
  !attempt.job &&
  attempt.firstSentAt !== null &&
  (attempt.firstSentAt === undefined ||
    now - attempt.firstSentAt >= 7 * 86400000);
export const active = (a?: Analysis) =>
  !!a?.attempt &&
  !needsRetryConfirmation(a.attempt) &&
  (!a.attempt.job || ["queued", "running"].includes(a.attempt.job.status));
