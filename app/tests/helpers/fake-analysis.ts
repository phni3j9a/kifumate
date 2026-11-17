import type { Page } from "@playwright/test";
import { Color, Move, Position, Square } from "tsshogi";
import { legalMoves } from "../../src/core/kif";
import type {
  AnalysisResult,
  Input,
  Quota,
  Reply,
} from "../../src/analysis/types";
export async function fakeAnalysis(page: Page) {
  const state = {
    errors: [] as string[],
    online: true,
    paid: true,
    remaining: 99,
    precise: 19,
    status: "running" as Reply["status"],
    next: 1,
    complete: false,
    results: [] as AnalysisResult[],
    requests: [] as Input[],
    cancel: 0,
    createStatus: 202,
  };
  page.on("pageerror", (e) => state.errors.push(e.message));
  page.on("console", (m) => {
    if (
      m.type() === "error" &&
      !m.text().includes("ERR_INTERNET_DISCONNECTED") &&
      !m.text().includes("ERR_FAILED")
    )
      state.errors.push(m.text());
  });
  let job: Reply | null = null;
  const quota = (): Quota => ({
    paid: state.paid,
    weekStart: 1794754800000,
    resetsAt: 1795359600000,
    totalRemaining: state.remaining,
    preciseRemaining: state.paid ? state.precise : 0,
    completed: { total: state.paid ? 1 : 0, precise: state.paid ? 1 : 0 },
    reserved: { total: 0, precise: 0 },
  });
  await page.route("**/v1/**", async (route) => {
    if (!state.online) {
      await route.abort("internetdisconnected");
      return;
    }
    const req = route.request(),
      url = new URL(req.url());
    const send = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(data),
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    if (req.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "*",
        },
      });
      return;
    }
    if (url.pathname === "/v1/devices") {
      await send({ token: "a".repeat(64) }, 201);
      return;
    }
    if (url.pathname === "/v1/quota") {
      await send(quota());
      return;
    }
    if (req.method() === "POST") {
      const input = req.postDataJSON() as Input;
      state.requests.push(input);
      if (state.createStatus !== 202) {
        await send(
          { error: "weekly_limit", quota: quota() },
          state.createStatus,
        );
        return;
      }
      if (!state.results.length) state.results = makeResults(input);
      job = {
        id: "00000000-0000-4000-8000-000000000001",
        mode: input.mode,
        status: state.status,
        next: state.next,
        total: input.moves.length + 1,
        createdAt: Date.now(),
        finishedAt: null,
        expiresAt: null,
        error: null,
        results: [],
        coachProof: null,
        quota: quota(),
      };
    }
    if (!job) {
      await send({ error: "not_found" }, 404);
      return;
    }
    if (req.method() === "DELETE") {
      state.cancel++;
      state.status = "cancelled";
    }
    job.status = state.complete ? "completed" : state.status;
    job.next = state.complete ? job.total : Math.min(job.total, state.next);
    job.results = state.results.filter(
      (r) =>
        r.ply >= Number(url.searchParams.get("from") || 0) && r.ply < job!.next,
    );
    job.quota = quota();
    job.error = state.status === "failed" ? "container_failed" : null;
    job.coachProof =
      job.status === "completed" && job.mode === "precise"
        ? {
            version: 1,
            signature: "opaque-proof-kept",
            expiresAt: Date.now() + 365 * 86400000,
          }
        : null;
    await send(job, req.method() === "POST" ? 202 : 200);
  });
  return state;
}
export function makeResults(input: Input): AnalysisResult[] {
  const p = new Position();
  if (input.initial !== "startpos") p.resetBySFEN(input.initial);
  const results: AnalysisResult[] = [];
  for (let i = 0; i <= input.moves.length; i++) {
    const moves = p.board
      .listNonEmptySquares()
      .flatMap((sq) => legalMoves(p, new Square(sq.file, sq.rank)));
    const game = input.moves[i];
    if (game)
      moves.sort((a, b) => (a.usi === game ? -1 : b.usi === game ? 1 : 0));
    const score = { kind: "cp" as const, value: i * 25 };
    results.push({
      ply: i,
      score,
      candidates: moves
        .slice(0, input.mode === "precise" ? 3 : 1)
        .map((m, n) => ({
          rank: n + 1,
          depth: 10,
          move: m.usi,
          score: {
            kind: "cp",
            value: i * 25 - (p.color === Color.BLACK ? 1 : -1) * n * 30,
          },
          pv: [m.usi],
        })),
      mate: null,
    });
    if (game) {
      const m = p.createMoveByUSI(game);
      if (m instanceof Move) p.doMove(m);
    }
  }
  return results;
}
