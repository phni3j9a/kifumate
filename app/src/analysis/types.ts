export type Mode = "std" | "precise";
export type Score = { kind: "cp" | "mate" | "declaration"; value: number | null; winner?: "sente" | "gote"; bound?: "lowerbound" | "upperbound" };
export interface Candidate { rank: number; depth: number; score: Score | null; move?: string; declarationWin?: boolean; pv: string[] }
export interface AnalysisResult { ply: number; score: Score | null; candidates: Candidate[]; mate: { plies: 1 | 3; pv: string[]; branches: { reply: string; mate: string }[] } | null }
export interface Quota { paid: boolean; weekStart: number; resetsAt: number; totalRemaining: number; preciseRemaining: number; completed: {total: number; precise: number}; reserved: {total: number; precise: number} }
export interface Input { initial: string; moves: string[]; mode: Mode }
export interface Job { id: string; mode: Mode; status: "queued" | "running" | "completed" | "cancelled" | "failed"; next: number; total: number; createdAt: number; finishedAt: number | null; expiresAt: number | null; error: string | null; results: AnalysisResult[]; coachProof: unknown }
export interface Reply extends Job { quota: Quota }
export interface Attempt extends Input { job: Job | null; results: AnalysisResult[]; cancel: boolean }
export interface Saved extends Input { results: AnalysisResult[]; coachProof: unknown; jobId: string }
export interface Analysis { gameId: string; attempt: Attempt | null; saved: Saved | null; error: string | null }
export const active = (a?: Analysis) => !!a?.attempt && (!a.attempt.job || ["queued", "running"].includes(a.attempt.job.status));
