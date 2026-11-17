import prompt from './coach-prompt.txt';
import { ApiError, json, monthStart, nextMonth, parseInput, readJson, sha256, type Input } from './model';

export interface CoachEnv {
  ENVIRONMENT: string;
  COACH_SIGNING_KEY?: string;
  COACH_API_KEY?: string;
  COACH_BASE_URL?: string;
  COACH_MODEL?: string;
  COACH_PROVIDER?: string;
  COACH_MONTHLY_LIMIT?: string;
  COACH_MAX_TOKENS?: string;
  COACH_TOKEN_PARAMETER?: string;
  COACH_TIMEOUT_MS?: string;
}
const CONFIG_KEYS = ['ENVIRONMENT', 'COACH_SIGNING_KEY', 'COACH_API_KEY', 'COACH_BASE_URL', 'COACH_MODEL', 'COACH_PROVIDER',
  'COACH_MONTHLY_LIMIT', 'COACH_MAX_TOKENS', 'COACH_TOKEN_PARAMETER', 'COACH_TIMEOUT_MS'] as const;
export function coachConfiguration(env: CoachEnv): CoachEnv {
  return Object.fromEntries(CONFIG_KEYS.map(k => [k, env[k]])) as unknown as CoachEnv;
}
export interface Proof {
  version: 1; device: string; jobId: string; mode: 'precise';
  issuedAt: number; expiresAt: number; digest: string; mac: string;
}
export const PROOF_LIFETIME = 365 * 86400_000;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
async function key(secret: string) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify']);
}
export async function signAnalysis(secret: string, device: string, jobId: string, input: Input, results: unknown[], now = Date.now()): Promise<Proof> {
  if (input.mode !== 'precise') throw new ApiError(400, 'precise_required');
  const claims = {version: 1 as const, device, jobId, mode: 'precise' as const, issuedAt: now, expiresAt: now + PROOF_LIFETIME,
    digest: await sha256(canonical({input, results}))};
  const mac = await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(canonical(claims)));
  return {...claims, mac: Array.from(new Uint8Array(mac), b => b.toString(16).padStart(2, '0')).join('')};
}
function record(x: unknown): Record<string, any> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new ApiError(400, 'invalid_input');
  return x as Record<string, any>;
}
function keys(x: Record<string, any>, allowed: string[]) {
  if (Object.keys(x).some(k => !allowed.includes(k))) throw new ApiError(400, 'invalid_input');
}
export async function verifyAnalysis(secret: string, device: string, input: Input, results: unknown[], value: unknown, now = Date.now()) {
  const p = record(value);
  keys(p, ['version', 'device', 'jobId', 'mode', 'issuedAt', 'expiresAt', 'digest', 'mac']);
  if (input.mode !== 'precise' || p.mode !== 'precise') throw new ApiError(400, 'precise_required');
  if (p.version !== 1 || p.device !== device || typeof p.jobId !== 'string' || !Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt)
    || p.issuedAt > now || p.expiresAt <= now || p.expiresAt - p.issuedAt !== PROOF_LIFETIME
    || typeof p.mac !== 'string' || !/^[a-f0-9]{64}$/.test(p.mac)) throw new ApiError(400, 'invalid_proof');
  const {mac, ...claims} = p;
  const valid = await crypto.subtle.verify('HMAC', await key(secret), Uint8Array.from(mac.match(/../g)!, (b: string) => parseInt(b, 16)), new TextEncoder().encode(canonical(claims)));
  if (!valid || p.digest !== await sha256(canonical({input, results}))) throw new ApiError(400, 'invalid_proof');
}

// 固有名を指示文にも含めず、入力・出力の両方で検査する。
const FORBIDDEN = /水匠|suisho|やねうら王|yaneura|技巧|elmo|nnue|halfka|apery|ponanza|dlshogi|将棋ウォーズ|将棋倶楽部|将棋クエスト|ぴよ将棋|shogi\s*(?:wars|quest|club)|81dojo|lishogi|将棋ドットコム|openai|deepseek|chatgpt|gpt[\s-]*\d|luna|claude|gemini|評価関数名|エンジン名|(?:[\p{L}\p{N}_]+)(?:さん|様|氏|選手|先生|さま)/iu;
export function checkNames(text: string) {
  if (FORBIDDEN.test(text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, ''))) throw new ApiError(400, 'unsafe_names');
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b-\u001f]/.test(value)) throw new ApiError(400, 'invalid_input');
  checkNames(value);
  return value;
}
export function parseCoach(value: unknown) {
  const x = record(value);
  keys(x, ['requestId', 'analysis', 'proof', 'perspective', 'profile', 'style', 'question', 'history']);
  if (typeof x.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(x.requestId)) throw new ApiError(400, 'invalid_request_id');
  const a = record(x.analysis); keys(a, ['initial', 'moves', 'mode', 'results']);
  const input = parseInput({initial: a.initial, moves: a.moves, mode: a.mode});
  if (input.mode !== 'precise') throw new ApiError(400, 'precise_required');
  if (!Array.isArray(a.results) || a.results.length !== input.moves.length + 1 || a.results.some((r: any, i: number) => !r || r.ply !== i)) throw new ApiError(400, 'invalid_results');
  if (!['sente', 'gote', 'observer'].includes(x.perspective)) throw new ApiError(400, 'invalid_perspective');
  const p = record(x.profile); keys(p, ['practice', 'goal']);
  if (!Array.isArray(p.practice) || p.practice.length > 10) throw new ApiError(400, 'invalid_profile');
  const profile = {practice: p.practice.map((v: unknown) => text(v, 40)), goal: text(p.goal, 500, true)};
  const s = record(x.style); keys(s, ['focus', 'detail']);
  if (!['総合', '序盤の駒組み', '中盤の攻防', '終盤', '悪手・改善点'].includes(s.focus) || !['かんたん', 'ふつう', 'くわしく'].includes(s.detail)) throw new ApiError(400, 'invalid_style');
  const question = x.question === undefined ? undefined : text(x.question, 1000);
  if (!Array.isArray(x.history) || x.history.length > 20 || (!question && x.history.length)) throw new ApiError(400, 'invalid_history');
  const history = x.history.map((h: unknown) => {
    const m = record(h); keys(m, ['role', 'content']);
    if (!['user', 'assistant'].includes(m.role)) throw new ApiError(400, 'invalid_history');
    return {role: m.role as 'user' | 'assistant', content: text(m.content, 4000)};
  });
  return {requestId: x.requestId as string, input, results: a.results as any[], proof: x.proof, perspective: x.perspective as string, profile, style: {focus: s.focus, detail: s.detail}, question, history};
}
type CoachInput = ReturnType<typeof parseCoach>;
export interface Reference { id: string; ply: number; score: unknown; pv: string[]; provenMate: boolean }
export function references(results: any[]): Reference[] {
  return results.flatMap(r => [
    {id: `${r.ply}:position`, ply: r.ply, score: r.score, pv: [], provenMate: false},
    ...r.candidates.filter((c: any) => c.pv?.length).map((c: any) => ({id: `${r.ply}:candidate:${c.rank}`, ply: r.ply, score: c.score, pv: c.pv, provenMate: false})),
    ...(r.mate ? [{id: `${r.ply}:mate`, ply: r.ply, score: null, pv: r.mate.pv, provenMate: true}] : []),
  ]);
}
export const SYSTEM_PROMPT = prompt;
export function messages(input: CoachInput, refs: Reference[]) {
  return [{role: 'system', content: SYSTEM_PROMPT}, {role: 'user', content: JSON.stringify({
    game: {initial: input.input.initial, moves: input.input.moves}, analysis: refs,
    perspective: input.perspective, profile: input.profile, style: input.style,
    // 履歴を会話ロールとして昇格させず、同じ棋譜の参考データとして渡す。
    history: input.history, question: input.question ?? '対局を振り返ってください',
  })}];
}
function setting(value: string | undefined, fallback: number, max: number) {
  const n = Number(value ?? fallback); return Number.isSafeInteger(n) && n > 0 && n <= max ? n : fallback;
}
export function timeoutMs(env: CoachEnv) { return setting(env.COACH_TIMEOUT_MS, 45_000, 120_000); }
export async function complete(env: CoachEnv, input: CoachInput, refs: Reference[], signal: AbortSignal, transport: typeof fetch = fetch): Promise<unknown> {
  if (env.COACH_PROVIDER === 'fake') {
    if (!['local', 'staging'].includes(env.ENVIRONMENT)) throw new ApiError(503, 'provider_unavailable');
    return {sections: [{kind: 'facts', title: '対局の振り返り', text: '解析結果をもとに振り返りましょう。', refs: [refs[0].id]},
      {kind: 'advice', title: '次の練習', text: '気になった局面を盤の上で確かめましょう。', refs: []}]};
  }
  if (env.COACH_PROVIDER && env.COACH_PROVIDER !== 'openai-compatible') throw new ApiError(503, 'provider_unavailable');
  if (!env.COACH_API_KEY || !env.COACH_MODEL || !env.COACH_BASE_URL) throw new ApiError(503, 'provider_unavailable');
  const url = new URL(env.COACH_BASE_URL.replace(/\/$/, '') + '/chat/completions');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new ApiError(503, 'provider_unavailable');
  const response = await transport(url.toString(), {method: 'POST', signal, redirect: 'error', headers: {'Authorization': `Bearer ${env.COACH_API_KEY}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({model: env.COACH_MODEL, messages: messages(input, refs), stream: false,
      response_format: {type: 'json_object'}, reasoning_effort: 'none',
      [env.COACH_TOKEN_PARAMETER === 'max_tokens' ? 'max_tokens' : 'max_completion_tokens']: setting(env.COACH_MAX_TOKENS, 2000, 8000)})});
  if (!response.ok) { await response.body?.cancel(); throw new ApiError(502, 'provider_failed'); }
  const data = record(await readJson(new Request('https://provider', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: response.body, duplex: 'half'} as RequestInit), 131_072));
  if (data.choices?.[0]?.finish_reason !== 'stop' || typeof data.choices[0].message?.content !== 'string') throw new ApiError(502, 'invalid_output');
  try { return JSON.parse(data.choices[0].message.content); } catch { throw new ApiError(502, 'invalid_output'); }
}
export function validateOutput(value: unknown, refs: Reference[]) {
  try {
    const x = record(value); keys(x, ['sections']);
    if (!Array.isArray(x.sections) || !x.sections.length || x.sections.length > 12) throw new Error();
    return {sections: x.sections.map((value: unknown) => {
      const s = record(value); keys(s, ['kind', 'title', 'text', 'refs']);
      if (!['facts', 'advice'].includes(s.kind)) throw new Error();
      const title = text(s.title, 80), body = text(s.text, 2000);
      // 自由文から盤面に依存する指し手・数値を出せないようにし、検証済み参照だけを公開する。
      if (/[0-9０-９一二三四五六七八九壱弐参]+\s*[歩香桂銀金角飛玉王と馬龍竜筋段手]|[▲△☗☖]|[0-9０-９]|[+-][一二三四五六七八九十百千]/.test(title + body)) throw new Error();
      if (!Array.isArray(s.refs) || s.refs.length > 10 || (s.kind === 'facts' && !s.refs.length)) throw new Error();
      const selected = s.refs.map((id: unknown) => {
        const ref = refs.find(r => r.id === id); if (!ref) throw new Error(); return ref;
      });
      return {kind: s.kind as 'facts' | 'advice', title, text: body, references: selected};
    })};
  } catch { throw new ApiError(502, 'invalid_output'); }
}

export class Coach {
  private active = new Map<string, AbortController>();
  constructor(private storage: DurableObjectStorage, private env: CoachEnv, private device: string, private paid: () => boolean) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS coach_usage (month INTEGER PRIMARY KEY, used INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS coach_requests (id TEXT PRIMARY KEY, month INTEGER NOT NULL, status TEXT NOT NULL, deadline INTEGER NOT NULL);`);
  }
  quota(now = Date.now()) {
    const month = monthStart(now), limit = setting(this.env.COACH_MONTHLY_LIMIT, 100, 10000);
    const used = this.storage.sql.exec<{used: number}>('SELECT used FROM coach_usage WHERE month=?', month).toArray()[0]?.used ?? 0;
    const reserved = this.storage.sql.exec<{n: number}>("SELECT COUNT(*) AS n FROM coach_requests WHERE month=? AND status='pending' AND deadline>?", month, now).toArray()[0].n;
    const remaining = Math.max(0, limit - used - reserved);
    return {monthStart: month, resetsAt: nextMonth(now), limit, used, reserved, remaining, low: remaining < limit / 10};
  }
  private status(id: string) { return this.storage.sql.exec<{status: string; month: number; deadline: number}>('SELECT status,month,deadline FROM coach_requests WHERE id=?', id).toArray()[0]; }
  async fetch(request: Request): Promise<Response> {
    try {
      const now = Date.now();
      this.storage.sql.exec("UPDATE coach_requests SET status='failed' WHERE status='pending' AND deadline<=?", now);
      this.storage.sql.exec('DELETE FROM coach_requests WHERE deadline<?', monthStart(now) - 32 * 86400_000);
      this.storage.sql.exec('DELETE FROM coach_usage WHERE month<?', monthStart(now) - 32 * 86400_000);
      if (request.method === 'GET' && new URL(request.url).pathname === '/v1/coach') return json({paid: this.paid(), quota: this.quota()});
      const cancel = /^\/v1\/coach\/([a-f0-9-]{36})$/.exec(new URL(request.url).pathname);
      if (cancel && request.method === 'DELETE') {
        // 本文を受信中のPOSTより先に届いた中止も、同じIDの墓標で止める。
        this.storage.sql.exec("INSERT OR IGNORE INTO coach_requests VALUES (?,?,'cancelled',?)", cancel[1], monthStart(now), now + timeoutMs(this.env));
        this.storage.sql.exec("UPDATE coach_requests SET status='cancelled' WHERE id=? AND status='pending'", cancel[1]);
        this.active.get(cancel[1])?.abort();
        return json({status: this.status(cancel[1])?.status ?? 'not_found', quota: this.quota()});
      }
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/coach') throw new ApiError(404, 'not_found');
      if (!this.paid()) throw new ApiError(403, 'paid_required');
      const input = parseCoach(await readJson(request, 1_048_576));
      if (!this.env.COACH_SIGNING_KEY) throw new ApiError(503, 'signing_unavailable');
      await verifyAnalysis(this.env.COACH_SIGNING_KEY, this.device, input.input, input.results, input.proof);
      const refs = references(input.results);
      const controller = new AbortController();
      const timeout = timeoutMs(this.env), accepted = Date.now();
      this.storage.transactionSync(() => {
        // 本文受信・署名検証の待機中に更新された権利を、確定直前に再確認する。
        if (!this.paid()) throw new ApiError(403, 'paid_required');
        if (request.signal.aborted) throw new ApiError(409, 'cancelled');
        if (this.status(input.requestId)) throw new ApiError(409, 'request_exists');
        const quota = this.quota(accepted);
        if (!quota.remaining) throw new ApiError(429, 'monthly_limit');
        if (this.storage.sql.exec("SELECT id FROM coach_requests WHERE status='pending' AND deadline>? LIMIT 1", accepted).toArray().length) throw new ApiError(409, 'coach_busy');
        this.storage.sql.exec("INSERT INTO coach_requests VALUES (?,?,'pending',?)", input.requestId, quota.monthStart, accepted + timeout);
        this.active.set(input.requestId, controller);
      });
      try {
        const signal = AbortSignal.any([controller.signal, request.signal, AbortSignal.timeout(timeout)]);
        const output = validateOutput(await complete(this.env, input, refs, signal), refs);
        return this.storage.transactionSync(() => {
          const current = this.status(input.requestId);
          if (signal.aborted || current?.status !== 'pending') throw new ApiError(409, 'cancelled');
          if (Date.now() >= current.deadline) throw new ApiError(504, 'coach_timeout');
          if (!this.paid()) throw new ApiError(403, 'paid_required');
          this.storage.sql.exec("UPDATE coach_requests SET status='completed' WHERE id=?", input.requestId);
          this.storage.sql.exec('INSERT INTO coach_usage VALUES (?,1) ON CONFLICT(month) DO UPDATE SET used=used+1', current.month);
          return json({requestId: input.requestId, ...output, quota: this.quota()});
        });
      } catch (error) {
        this.storage.sql.exec("UPDATE coach_requests SET status=? WHERE id=? AND status='pending'", controller.signal.aborted || request.signal.aborted ? 'cancelled' : 'failed', input.requestId);
        if (controller.signal.aborted || request.signal.aborted) throw new ApiError(409, 'cancelled');
        if (Date.now() >= accepted + timeout) throw new ApiError(504, 'coach_timeout');
        throw error instanceof ApiError ? error : new ApiError(502, 'provider_failed');
      } finally { this.active.delete(input.requestId); }
    } catch (error) {
      return json({error: error instanceof ApiError ? error.code : 'coach_unavailable', quota: this.quota()}, error instanceof ApiError ? error.status : 503);
    }
  }
}
