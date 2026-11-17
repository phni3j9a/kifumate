export type Entitlement = {
  paid: boolean;
  source: "invite" | "development" | null;
  expiresAt: number | null;
};
export interface EntitlementSource {
  entitlements(): Promise<Entitlement>;
  redeem(code: string): Promise<Entitlement>;
}
const free: Entitlement = { paid: false, source: null, expiresAt: null };
// 権利の取得元をここへ注入する。購入基盤を変えても画面・解析は変更しない。
export class EntitlementController {
  snapshot = { entitlement: free, checked: false, offline: false };
  private listeners = new Set<() => void>();
  private pending?: Promise<Entitlement>;
  constructor(
    private source: EntitlementSource,
    private development = false,
    private now = Date.now,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(value: Entitlement, offline = false) {
    const valid =
      value.paid === true &&
      (value.source === "invite" ||
        (this.development && value.source === "development")) &&
      (value.expiresAt === null ||
        (Number.isSafeInteger(value.expiresAt) &&
          value.expiresAt > this.now()));
    const entitlement = valid ? value : free;
    this.snapshot = { entitlement, checked: true, offline };
    this.listeners.forEach((listener) => listener());
    return entitlement;
  }
  expire = () => {
    const value = this.snapshot.entitlement;
    if (value.expiresAt !== null && value.expiresAt <= this.now())
      this.publish(free);
  };
  refresh = (): Promise<Entitlement> =>
    (this.pending ??= this.source
      .entitlements()
      .then(
        (value) => this.publish(value),
        (error) => {
          this.publish(this.snapshot.entitlement, true);
          throw error;
        },
      )
      .finally(() => {
        this.pending = undefined;
      }));
  async redeem(code: string) {
    await this.pending?.catch(() => {});
    await this.source.redeem(code);
    return this.refresh();
  }
}
