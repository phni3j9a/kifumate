// 画面に出す日付と指し手の書き方（モックの dshort / dlong / han と同じ形）。
const WD = "日月火水木金土";
export function dateParts(playedAt: string) {
  const m = playedAt.match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const time = Date.UTC(y, mo - 1, d);
  return { y, m: mo, d, w: WD[new Date(time).getUTCDay()]!, time };
}
/** 11/10（火） */
export function dateShort(playedAt: string): string {
  const p = dateParts(playedAt);
  return p ? `${p.m}/${p.d}（${p.w}）` : "日付なし";
}
/** 2026年11月10日（火） */
export function dateLong(playedAt: string): string {
  const p = dateParts(playedAt);
  return p
    ? `${p.y}年${p.m}月${p.d}日（${p.w}）`
    : playedAt || "書かれていません";
}
/** ☗７六歩 → ▲7六歩、☖同　銀 → △同銀 */
export function moveText(text: string): string {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace("☗", "▲")
    .replace("☖", "△")
    .replace(/　/g, "");
}
