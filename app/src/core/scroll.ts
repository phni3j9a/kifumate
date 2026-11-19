/** モックの ensureVisible。端から4px以内なら、40pxの余裕を付けて動かす。 */
export function ensureVisibleY(
  top: number,
  height: number,
  offset: number,
  viewport: number,
) {
  if (viewport <= 0) return offset;
  if (top < offset + 4) return Math.max(0, top - 40);
  if (top + height > offset + viewport - 4)
    return Math.max(0, top + height - viewport + 40);
  return offset;
}
