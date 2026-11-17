export const MAX_MOVES = 512;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export type Mode = 'std' | 'precise';
export interface Input { initial: string; moves: string[]; mode: Mode }
export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export function weekStart(now: number): number {
  const jst = new Date(now + 9 * 3600_000);
  const midnight = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  return midnight - ((jst.getUTCDay() + 6) % 7) * 86400_000 - 9 * 3600_000;
}
export function parseInput(value: unknown): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_input');
  const x = value as Record<string, unknown>;
  if (Object.keys(x).some(k => !['initial', 'moves', 'mode'].includes(k))) throw new ApiError(400, 'invalid_input');
  if (x.mode !== 'std' && x.mode !== 'precise') throw new ApiError(400, 'invalid_mode');
  if (typeof x.initial !== 'string') throw new ApiError(400, 'invalid_position');
  const initial = x.initial.trim().replace(/\s+/g, ' ');
  if (initial !== 'startpos' && !/^[plnsgbrkPLNSGBRK1-9+/]+ [bw] (?:-|[0-9PLNSGBRplnsgbr]+) [1-9][0-9]{0,5}$/.test(initial)) throw new ApiError(400, 'invalid_position');
  if (!Array.isArray(x.moves) || x.moves.length > MAX_MOVES || x.moves.some(m => typeof m !== 'string' || !/^(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])$/.test(m))) throw new ApiError(400, 'invalid_moves');
  return { initial, moves: x.moves, mode: x.mode };
}
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
export function json(data: unknown, status = 200): Response {
  return Response.json(data, {status, headers: {'Cache-Control': 'no-store'}});
}
export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ApiError(415, 'json_required');
  // Content-Length は信用せず、ストリームの実バイト数でも止める。
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'invalid_json');
  let bytes = 0; const chunks: Uint8Array[] = [];
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 16_384) { await reader.cancel(); throw new ApiError(413, 'input_too_large'); }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(body)); } catch { throw new ApiError(400, 'invalid_json'); }
}
