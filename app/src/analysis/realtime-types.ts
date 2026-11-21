import type { AnalysisResult } from "./types";
export interface RealtimeInput {
  initial: string;
  moves: string[];
  hold?: boolean;
}
export type RealtimeResult = AnalysisResult & { depth?: number | null };
export interface RealtimeQuota {
  monthStart: number;
  resetsAt: number;
  limitMs: number;
  usedMs: number;
  remainingMs: number;
  low: boolean;
}
export interface RealtimeReply {
  paid?: boolean;
  sessionId: string | null;
  sequence: number;
  status:
    "preparing" | "analyzing" | "ready" | "paused" | "off" | "limit" | "failed";
  result: RealtimeResult | null;
  searching: boolean;
  error: string | null;
  idleMs: number;
  quota: RealtimeQuota;
}
export type RealtimeStatus = RealtimeReply["status"] | "offline" | "idle";
export interface RealtimeState {
  paid: boolean | null;
  enabled: boolean;
  hold: boolean;
  status: RealtimeStatus;
  result: RealtimeResult | null;
  searching: boolean;
  positionKey: string | null;
  quota: RealtimeQuota | null;
  error: string | null;
}
export const positionKey = (input: RealtimeInput) =>
  JSON.stringify([input.initial, input.moves]);
