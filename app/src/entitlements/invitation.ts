import { ApiError } from "../analysis/client";
export function normalizeInvitation(value: string) {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[\s\p{Dash_Punctuation}]/gu, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}
export function formatInvitation(value: string) {
  return (
    normalizeInvitation(value)
      .match(/.{1,4}/gu)
      ?.join("-") || ""
  );
}
export function validInvitation(value: string) {
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(normalizeInvitation(value));
}
export function invitationError(error: unknown, now = Date.now()) {
  if (!(error instanceof ApiError))
    return "通信できません。接続を確かめて、もう一度お試しください。";
  if (error.status === 429) {
    const retryAt = new Date(
      now +
        (error.retryAfter ??
          (error.code === "invite_rate_limited" ? 900 : 60)) *
          1000,
    );
    return `入力の試行が多すぎます。${retryAt.toLocaleString("ja-JP")} 以降に、もう一度お試しください。`;
  }
  return (
    (
      {
        invalid_input:
          "コードは半角英数字16文字です。文字数と入力を確かめてください。",
        invite_invalid:
          "コードが違うか、期限が切れているか、取り消されています。コードを確かめ、発行した人にご相談ください。",
        invite_full:
          "このコードで使える端末数の上限です。発行した人にご相談ください。",
        unauthorized:
          "端末の登録を確認できません。データは消さずにお問い合わせください。",
        rate_limit_unavailable:
          "いまはコードを確認できません。時間をおいて、もう一度お試しください。",
      } as Record<string, string>
    )[error.code] ||
    "コードを確認できませんでした。時間をおいて、もう一度お試しください。"
  );
}
