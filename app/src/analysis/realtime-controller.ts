import { ApiError, type AnalysisClient } from "./client";
import {
  positionKey,
  type RealtimeInput,
  type RealtimeReply,
  type RealtimeState,
} from "./realtime-types";
type API = Pick<
  AnalysisClient,
  "realtime" | "startRealtime" | "updateRealtime" | "stopRealtime"
>;
/** 全局解析とは寿命を分離する。画面が消えても、遅れて届いたPOSTのIDを回収して止める。 */
export class RealtimeController {
  snapshot: RealtimeState = {
    paid: null,
    enabled: true,
    hold: false,
    searching: false,
    status: "idle",
    result: null,
    positionKey: null,
    quota: null,
    error: null,
  };
  private listeners = new Set<() => void>();
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private emit(patch: Partial<RealtimeState>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  private visible = false;
  private foreground = true;
  private desired: RealtimeInput | null = null;
  private session: string | null = null;
  private sequence = 0;
  private revision = 0;
  private epoch = 0;
  private creating: Promise<void> | null = null;
  private updating: Promise<void> | null = null;
  private offerPlan?: () => void;
  private resuming: Promise<void> | null = null;
  private stopping: Promise<void> = Promise.resolve();
  private pendingStop = new Set<string>();
  private retryingStops: Promise<void> | null = null;
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private nextUpdateAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private activityAt = 0;
  constructor(
    private api: API,
    private pollMs = 350,
    private deepPollMs = 1000,
    private updateIntervalMs = 1100, // 1分60回の書き込み上限にPOST分も残す。
  ) {}
  private clearTimers() {
    clearTimeout(this.updateTimer);
    clearTimeout(this.timer);
    clearTimeout(this.idleTimer);
  }
  private get allowed() {
    return (
      this.visible &&
      this.foreground &&
      (this.snapshot.hold || this.snapshot.enabled) &&
      this.snapshot.paid === true
    );
  }
  setVisible(visible: boolean) {
    this.visible = visible;
    if (visible) void this.resume();
    else {
      this.desired = null;
      void this.stop();
    }
  }
  setForeground(foreground: boolean) {
    if (this.foreground === foreground) return;
    this.foreground = foreground;
    if (foreground && this.visible) void this.resume();
    else if (!foreground) void this.stop();
  }
  toggle() {
    const enabled = !this.snapshot.enabled;
    this.desired = null;
    this.emit({
      enabled,
      result: null,
      positionKey: null,
      status: enabled ? "idle" : "off",
    });
    void this.stop();
  }
  move(input: RealtimeInput) {
    if (this.snapshot.hold) void this.stop();
    this.setPosition(input);
  }
  startReading(input: RealtimeInput, offerPlan?: () => void) {
    if (
      !this.visible ||
      !this.foreground ||
      this.snapshot.paid === false ||
      this.snapshot.hold
    )
      return;
    if (this.desired) this.leaveBranch();
    this.offerPlan =
      this.snapshot.paid === null || this.resuming ? offerPlan : undefined;
    this.emit({ hold: true, status: "preparing" });
    this.setPosition({ ...input, hold: true });
    if (this.snapshot.paid === null) void this.resume();
  }
  showMain(input: RealtimeInput) {
    if (!this.snapshot.hold) {
      if (this.desired) this.leaveBranch();
      if (this.pendingStop.size) void this.retryStops();
      return;
    }
    if (this.snapshot.positionKey !== positionKey(input))
      this.setPosition({ ...input, hold: true });
  }
  resumeReading = () => {
    if (this.snapshot.hold && this.snapshot.status === "paused" && this.desired)
      this.setPosition(this.desired);
  };
  private setPosition(input: RealtimeInput) {
    this.desired = { ...input, moves: [...input.moves] };
    this.revision++;
    this.clearTimers();
    this.emit({
      result: null,
      searching: false,
      positionKey: positionKey(input),
      error: null,
    });
    if (this.allowed) void this.send();
  }
  leaveBranch() {
    this.desired = null;
    void this.stop();
  }
  retry = () => {
    void this.resume();
  };
  private async remove(id: string) {
    this.pendingStop.add(id);
    try {
      await this.api.stopRealtime(id);
      this.pendingStop.delete(id);
    } catch (error) {
      if (error instanceof ApiError && error.code === "stale_session")
        this.pendingStop.delete(id);
      // 通信断でも停止の意思を残し、前面復帰・次の操作で再試行する。
    }
  }
  private retryStops() {
    return (this.retryingStops ??= this.stopping
      .then(async () => {
        for (const id of this.pendingStop) await this.remove(id);
      })
      .finally(() => {
        this.retryingStops = null;
      }));
  }
  async stop() {
    this.epoch++;
    this.offerPlan = undefined;
    this.clearTimers();
    const id = this.session;
    this.session = null;
    if (this.snapshot.hold) this.desired = null;
    this.emit({
      hold: false,
      result: null,
      searching: false,
      status: this.snapshot.enabled ? "idle" : "off",
    });
    this.stopping = Promise.all([
      this.stopping,
      id ? this.remove(id) : Promise.resolve(),
      this.creating,
      this.updating,
    ]).then(() => {});
    await this.stopping;
  }
  private resume(): Promise<void> {
    if (this.resuming) return this.resuming;
    const epoch = this.epoch;
    this.resuming = (async () => {
      await this.stopping;
      await this.creating;
      if (this.pendingStop.size) await this.retryStops();
      if (epoch !== this.epoch || !this.visible || !this.foreground) return;
      const reply = await this.api.realtime();
      // 離脱後に届いたGETでも、残っているセッションは回収して止める。
      if (
        reply.sessionId &&
        reply.sessionId !== this.session &&
        reply.status !== "off" &&
        reply.status !== "failed"
      )
        await this.remove(reply.sessionId);
      if (epoch !== this.epoch || !this.visible || !this.foreground) return;
      if (reply.paid !== true && this.snapshot.hold) {
        this.emit({ quota: reply.quota });
        this.revokeAccess();
        return;
      }
      this.offerPlan = undefined;
      this.emit({
        paid: reply.paid ?? false,
        quota: reply.quota,
        error: null,
        result: null,
        searching: false,
        status: this.snapshot.hold
          ? "preparing"
          : this.snapshot.enabled
            ? "idle"
            : "off",
      });
      if (reply.status === "off" || reply.status === "failed")
        this.session = null;
      this.sequence = Math.max(this.sequence, reply.sequence);
    })()
      .catch((error) => {
        if (epoch === this.epoch) this.fail(error);
      })
      .finally(() => {
        this.resuming = null;
        if (epoch !== this.epoch) {
          if (this.visible && this.foreground) void this.resume();
        } else if (
          this.allowed &&
          this.desired &&
          this.snapshot.status !== "offline"
        )
          void this.send();
      });
    return this.resuming;
  }
  revokeAccess() {
    const offerPlan = this.offerPlan;
    this.emit({ paid: false });
    void this.stop();
    offerPlan?.();
  }
  private fail(error: unknown) {
    if (error instanceof ApiError && error.status === 403) {
      this.revokeAccess();
      return;
    }
    if (
      error instanceof ApiError &&
      error.quota &&
      "remainingMs" in error.quota
    )
      this.emit({ quota: error.quota });
    this.emit({
      result: null,
      searching: false,
      status:
        error instanceof ApiError
          ? error.code === "monthly_limit"
            ? "limit"
            : "failed"
          : "offline",
      error: error instanceof ApiError ? error.code : null,
    });
  }
  private async send() {
    if (!this.allowed || !this.desired || this.resuming) return;
    const epoch = this.epoch;
    await this.stopping;
    if (epoch !== this.epoch || !this.allowed || !this.desired) return;
    if (this.pendingStop.size) await this.retryStops();
    if (epoch !== this.epoch || !this.allowed || !this.desired || this.resuming)
      return;
    if (this.pendingStop.size) {
      this.emit({ status: "offline" });
      return;
    }
    if (this.creating || this.updating) return;
    const revision = this.revision;
    const input = this.desired;
    if (!this.session) {
      this.emit({ status: "preparing" });
      const sentAt = Date.now();
      const create = async () => {
        let reply: RealtimeReply;
        let recovered = false;
        try {
          reply = await this.api.startRealtime(input);
        } catch (error) {
          if (error instanceof ApiError && error.code !== "session_exists")
            throw error;
          // POSTを再送せず、受理済みセッションをGETで回収する。
          reply = await this.api.realtime();
          recovered = true;
          if (!reply.sessionId || ["off", "failed"].includes(reply.status))
            throw error;
        }
        if (epoch !== this.epoch || !this.allowed) {
          if (reply.sessionId) await this.remove(reply.sessionId);
          return;
        }
        this.session = reply.sessionId;
        this.sequence = reply.sequence;
        this.activityAt = sentAt;
        if (recovered)
          this.revision++; // 回収した局面は不明。必ずPUTして現在局面と照合する。
        else if (revision === this.revision)
          this.receive(reply, epoch, revision, this.sequence);
      };
      this.creating = create().catch((error) => {
        if (epoch === this.epoch) this.fail(error);
      });
      await this.creating;
      this.creating = null;
      if (epoch === this.epoch && this.session && revision !== this.revision)
        void this.send();
      return;
    }
    const status =
      this.snapshot.status === "paused" || this.snapshot.status === "preparing"
        ? "preparing"
        : "analyzing";
    if (this.snapshot.status !== status) this.emit({ status });
    const now = performance.now();
    const wait = this.nextUpdateAt - now;
    if (wait > 0) {
      clearTimeout(this.updateTimer);
      this.updateTimer = setTimeout(() => void this.send(), wait);
      return;
    }
    const id = this.session;
    const sequence = ++this.sequence;
    this.activityAt = Date.now();
    this.nextUpdateAt = now + this.updateIntervalMs;
    this.updating = this.api
      .updateRealtime(id, input, sequence)
      .then((reply) => this.receive(reply, epoch, revision, sequence))
      .catch((error) => {
        if (epoch !== this.epoch) return;
        // 新しい局面が待っていても、送信に失敗したセッションは残さない。
        this.session = null;
        this.stopping = this.remove(id);
        this.fail(error);
      });
    await this.updating;
    this.updating = null;
    if (epoch === this.epoch && this.session && revision !== this.revision)
      void this.send();
  }
  private receive(
    reply: RealtimeReply,
    epoch: number,
    revision: number,
    sequence: number,
  ) {
    if (
      epoch !== this.epoch ||
      revision !== this.revision ||
      !this.allowed ||
      reply.sessionId !== this.session ||
      reply.sequence !== sequence ||
      sequence !== this.sequence
    )
      return;
    if (reply.paid === false) {
      this.fail(new ApiError(403, "paid_required"));
      return;
    }
    const result =
      reply.result?.ply === this.desired?.moves.length ? reply.result : null;
    const searching = reply.status === "ready" && reply.searching === true;
    this.emit({
      status: reply.status,
      searching,
      result,
      quota: reply.quota,
      error: reply.error,
    });
    this.clearTimers();
    if (reply.status === "preparing" || reply.status === "analyzing") {
      this.timer = setTimeout(() => {
        void this.poll(epoch, revision, sequence);
      }, this.pollMs);
    } else if (searching) {
      this.timer = setTimeout(() => {
        void this.poll(epoch, revision, sequence);
      }, this.deepPollMs);
    } else if (reply.status === "ready") {
      // 探索完了後は定期取得を止め、無操作期限／月上限で停止状態だけ確認する。
      const deadline = Math.min(
        this.activityAt + reply.idleMs,
        Date.now() + reply.quota.remainingMs,
      );
      this.idleTimer = setTimeout(
        () => {
          void this.poll(epoch, revision, sequence);
        },
        Math.max(1000, deadline - Date.now() + 500),
      );
    } else if (reply.status === "off" || reply.status === "failed")
      this.session = null;
  }
  private async poll(epoch: number, revision: number, sequence: number) {
    try {
      this.receive(await this.api.realtime(), epoch, revision, sequence);
    } catch (error) {
      if (epoch === this.epoch && revision === this.revision) this.fail(error);
    }
  }
}
