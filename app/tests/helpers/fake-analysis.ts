import { fakeCoach } from "./fake-coach";
import type { Page } from "@playwright/test";
import type {
  RealtimeInput,
  RealtimeReply,
} from "../../src/analysis/realtime-types";
import { Color, Move, Position, Square } from "tsshogi";
import { legalMoves } from "../../src/core/kif";
import type {
  AnalysisResult,
  Input,
  Quota,
  Reply,
} from "../../src/analysis/types";
export async function fakeAnalysis(
  page: Page,
  { onboarding = false, firstReview = false } = {},
) {
  if (!firstReview) {
    const review = page.getByRole("button", { name: "見てみる", exact: true });
    await page.addLocatorHandler(review, () => review.click());
  }
  if (!onboarding) {
    await page.addInitScript(() => {
      (globalThis as any).__testEntry = location.pathname + location.search;
    });
    await page.addLocatorHandler(
      page.getByText("kifumateへ ようこそ", { exact: true }),
      async () => {
        const entry = await page.evaluate(
          () => (globalThis as any).__testEntry as string,
        );
        await page
          .getByRole("button", { name: "スキップ", exact: true })
          .click();
        await page.getByText("まだ棋譜がありません").waitFor();
        if (entry && entry !== "/" && entry !== "/onboarding")
          await page.goto(entry);
      },
    );
  }
  const state = {
    errors: [] as string[],
    online: true,
    paid: true,
    entitlementExpiresAt: null as number | null,
    inviteError: "",
    inviteStatus: 400,
    redeemed: [] as { code: string }[],
    remaining: 99,
    resetsAt: Date.now() + 3 * 86400000,
    reserved: 0,
    precise: 19,
    status: "running" as Reply["status"],
    next: 1,
    complete: false,
    results: [] as AnalysisResult[],
    requests: [] as Input[],
    cancel: 0,
    createStatus: 202,
    loseCreateResponse: false,
    rt: {
      status: "ready" as RealtimeReply["status"],
      sessionId: null as string | null,
      sequence: 0,
      input: null as RealtimeInput | null,
      result: undefined as AnalysisResult | null | undefined,
      requests: [] as {
        method: string;
        input: RealtimeInput;
        sequence: number;
      }[],
      stops: 0,
      remainingMs: 18000000,
      low: false,
      idleMs: 30000,
    },
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
    weekStart: state.resetsAt - 7 * 86400000,
    resetsAt: state.resetsAt,
    totalRemaining: state.remaining,
    preciseRemaining: state.paid ? state.precise : 0,
    completed: { total: state.paid ? 1 : 0, precise: state.paid ? 1 : 0 },
    reserved: { total: state.reserved, precise: 0 },
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
    if (
      url.pathname === "/v1/entitlements" ||
      url.pathname === "/v1/invitations/redeem"
    ) {
      if (req.method() === "POST") {
        state.redeemed.push(req.postDataJSON());
        if (state.inviteError) {
          await route.fulfill({
            status: state.inviteStatus,
            contentType: "application/json",
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Retry-After": "900",
              "Access-Control-Expose-Headers": "Retry-After",
            },
            body: JSON.stringify({ error: state.inviteError }),
          });
          return;
        }
        state.paid = true;
      }
      await send({
        paid: state.paid,
        source: state.paid ? "invite" : null,
        expiresAt: state.entitlementExpiresAt,
      });
      return;
    }
    if (url.pathname === "/v1/quota") {
      await send(quota());
      return;
    }
    if (url.pathname.startsWith("/v1/realtime")) {
      const rt = state.rt;
      if (req.method() === "POST" || req.method() === "PUT") {
        if (!state.paid) {
          await send({ error: "paid_required" }, 403);
          return;
        }
        const input = req.postDataJSON();
        rt.sequence = input.sequence ?? 0;
        rt.input = { initial: input.initial, moves: input.moves };
        rt.requests.push({
          method: req.method(),
          input,
          sequence: rt.sequence,
        });
        rt.sessionId ||= "00000000-0000-4000-8000-000000000023";
      }
      if (req.method() === "DELETE") {
        rt.stops++;
        rt.sessionId = null;
      }
      const generated = rt.input
        ? makeResults({ ...rt.input, mode: "std" }).at(-1)!
        : null;
      await send(
        {
          paid: state.paid,
          sessionId: rt.sessionId,
          sequence: rt.sequence,
          status: rt.sessionId ? rt.status : "off",
          result:
            rt.sessionId && ["ready", "paused", "limit"].includes(rt.status)
              ? rt.result === undefined
                ? generated
                : rt.result
              : null,
          error: null,
          idleMs: rt.idleMs,
          quota: {
            monthStart: 1793458800000,
            resetsAt: 1796050800000,
            limitMs: 18000000,
            usedMs: 18000000 - rt.remainingMs,
            remainingMs: rt.remainingMs,
            low: rt.low,
          },
        } satisfies RealtimeReply,
        ["POST", "PUT"].includes(req.method()) ? 202 : 200,
      );
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
    if (req.method() === "POST" && state.loseCreateResponse) {
      await route.abort("internetdisconnected");
      return;
    }
    await send(job, req.method() === "POST" ? 202 : 200);
  });
  return Object.assign(state, {
    coach: await fakeCoach(page, () => state.paid),
  });
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
