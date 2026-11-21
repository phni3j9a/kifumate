import type { Page } from "@playwright/test";
import type { CoachInput, CoachReply, Section } from "../../src/coach/types";
export const coachSections: Section[] = [
  {
    kind: "facts",
    title: "この対局のまとめ",
    text: "序盤はほぼ互角でした。駒の働きを確かめながら、落ち着いて進められています。",
    references: [
      {
        id: "0:candidate:1",
        ply: 0,
        score: { kind: "cp", value: 25 },
        pv: ["7g7f", "3c3d"],
        provenMate: false,
      },
    ],
  },
  {
    kind: "advice",
    title: "あなたへのアドバイス",
    text: "気になった局面を盤の上で指し直して、相手のねらいも確かめてみましょう。",
    references: [],
  },
];
export async function fakeCoach(page: Page, paid: () => boolean = () => true) {
  const state = {
    online: true,
    status: "pending" as CoachReply["status"],
    remainingRatio: 0.99,
    requests: [] as CoachInput[],
    gets: 0,
    deletes: 0,
    losePost: false,
    sections: coachSections,
    error: "invalid_output",
  };
  const records = new Map<string, CoachReply>();
  const quota = () => ({
    remainingRatio: state.remainingRatio,
    resetsAt: 1795964400000,
    low: state.remainingRatio < 0.1,
    exhausted: state.remainingRatio === 0,
  });
  await page.route("**/v1/coach**", async (route) => {
    if (!state.online) {
      await route.abort("internetdisconnected");
      return;
    }
    const req = route.request(),
      url = new URL(req.url());
    const send = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
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
    if (url.pathname === "/v1/coach" && req.method() === "GET") {
      await send({
        paid: paid(),
        quota: quota(),
        latest: [...records.values()].at(-1) ?? null,
      });
      return;
    }
    const id = url.pathname.split("/")[3];
    if (req.method() === "POST") {
      const input = req.postDataJSON() as CoachInput;
      if (!paid()) {
        await send({ error: "paid_required", quota: quota() }, 403);
        return;
      }
      if (records.has(input.requestId)) {
        await send({ error: "request_exists", quota: quota() }, 409);
        return;
      }
      if (state.remainingRatio === 0) {
        await send({ error: "weekly_limit", quota: quota() }, 429);
        return;
      }
      state.requests.push(input);
      const reply: CoachReply = {
        requestId: input.requestId,
        status: state.status,
        expiresAt: Date.now() + 240000,
        error: state.status === "failed" ? state.error : null,
        quota: quota(),
        ...(state.status === "completed" ? { sections: state.sections } : {}),
      };
      records.set(input.requestId, reply);
      if (state.losePost) {
        await route.abort("internetdisconnected");
        return;
      }
      await send(reply, 202);
      return;
    }
    if (!id || !records.has(id)) {
      await send({ error: "not_found", quota: quota() }, 404);
      return;
    }
    const reply = records.get(id)!;
    if (req.method() === "DELETE") {
      state.deletes++;
      if (reply.status !== "completed") reply.status = "cancelled";
    } else {
      state.gets++;
      if (reply.status !== "cancelled") reply.status = state.status;
      reply.error = state.status === "failed" ? state.error : null;
    }
    if (reply.status === "completed") reply.sections = state.sections;
    reply.quota = quota();
    await send(reply);
  });
  return state;
}
