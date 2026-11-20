import prompt from './coach-prompt.txt';
import toolsPrompt from './coach-tools-prompt.txt';
import { abortable, responsesWithTools, type RunTools } from './coach-tools';
import { coachModel, coachRates, RESPONSES_TOOLS, usageCost, weeklyBudget } from './coach-budget';
import { contradicts, hasFactReference, lineOrigin, notationIssue, type CoachFacts } from './coach-facts';
import { ApiError, json, weekStart, parseInput, readJson, sha256, type Input } from './model';

export interface CoachEnv {
  ENVIRONMENT: string;
  COACH_SIGNING_KEY?: string;
  COACH_API_KEY?: string;
  COACH_BASE_URL?: string;
  COACH_MODEL?: string;
  COACH_PROVIDER?: string;
  COACH_WEEKLY_BUDGET_USD?: string;
  COACH_PRICES_USD_PER_MILLION?: string;
  COACH_MAX_TOKENS?: string;
  COACH_TOKEN_PARAMETER?: string;
  COACH_REASONING_EFFORT?: string;
  COACH_TIMEOUT_MS?: string;
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

// 製品名だけを検査し、人名の伏せ字は登録名を持つアプリ側で行う。
const FORBIDDEN = /水匠|suisho|やねうら王|yaneura|技巧\s*[0-9０-９]|elmo|nnue|halfka|apery|ponanza|dlshogi|将棋ウォーズ|将棋倶楽部|将棋クエスト|ぴよ将棋|shogi\s*(?:wars|quest|club)|81dojo|lishogi|将棋ドットコム|openai|deepseek|chatgpt|gpt[\s-]*\d|luna|claude|gemini/iu;
export function checkNames(text: string): string {
  const cleaned = text.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '');
  if (FORBIDDEN.test(cleaned.normalize('NFKC'))) throw new ApiError(400, 'unsafe_names');
  return cleaned;
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b-\u001f]/.test(value)) throw new ApiError(400, 'invalid_input');
  const cleaned = checkNames(value);
  if (!empty && !cleaned.trim()) throw new ApiError(400, 'invalid_input');
  return cleaned;
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
function prose(value: string) {
  return value.replace(/(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])/g, '（指し手は参照で確認）');
}
function consultation(input: CoachInput) {
  return {
    profile: {practice: input.profile.practice.map(prose), goal: prose(input.profile.goal)}, style: input.style,
    // 履歴は会話ロールへ昇格させず、棋譜の参考データとして渡す。
    history: input.history.map(h => ({role: h.role, content: prose(h.content)})), question: prose(input.question ?? '対局を振り返ってください'),
  };
}
export function messages(input: CoachInput, _refs: Reference[], facts?: CoachFacts) {
  const {詰みの別応手: _, ...modelFacts} = facts ?? {};
  return [{role: 'system', content: SYSTEM_PROMPT}, {role: 'user', content: JSON.stringify({
    facts: facts ? modelFacts : {視点: input.perspective === 'observer' ? '観戦' : input.perspective === 'sente' ? 'あなたが先手、相手が後手' : '相手が先手、あなたが後手', 参照: _refs.map(r => ({id: r.id}))},
    perspective: input.perspective, ...consultation(input),
  })}];
}
function toolsContext(input: CoachInput, facts: CoachFacts) {
  return {
    視点: facts.視点, 終局: facts.終局, 対局手数: input.input.moves.length,
    要所: (facts.要所 ?? []).map(({実戦手, 実戦の続き: _, ...key}) => ({...key, 実戦手: 実戦手.表記})),
    ...consultation(input),
  };
}
function setting(value: string | undefined, fallback: number, max: number) {
  const n = Number(value ?? fallback); return Number.isSafeInteger(n) && n > 0 && n <= max ? n : fallback;
}
export function timeoutMs(env: CoachEnv) { return setting(env.COACH_TIMEOUT_MS, 240_000, 600_000); }
function errorType(error: unknown) {
  // 例外のmessage・stack・任意のnameには入力やキーが混ざり得る。
  return error instanceof ApiError ? 'ApiError' : error instanceof TypeError ? 'TypeError' : error instanceof SyntaxError ? 'SyntaxError'
    : error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name) ? error.name : 'Error';
}
export async function complete(env: CoachEnv, input: CoachInput, refs: Reference[], signal: AbortSignal, transport: typeof fetch = fetch, facts?: CoachFacts,
  runTools?: RunTools, deadline = Date.now() + timeoutMs(env), onCost: (cost: number) => void = () => {}): Promise<unknown> {
  const rates = coachRates(env);
  const {provider, model} = coachModel(env);
  if (!rates) {
    return {sections: [{kind: 'facts', title: '対局の振り返り', text: '解析結果をもとに振り返りましょう。', refs: [refs[0].id]},
      {kind: 'advice', title: '次の練習', text: '気になった局面を盤の上で確かめましょう。', refs: []}]};
  }
  const withTools = provider === RESPONSES_TOOLS;
  const count = (usage: unknown) => onCost(usageCost(usage, withTools, rates));
  if (!env.COACH_API_KEY) throw new ApiError(503, 'provider_unavailable');
  const base = env.COACH_BASE_URL ?? (withTools ? 'https://api.openai.com/v1' : 'https://api.deepseek.com');
  const url = new URL(base.replace(/\/$/, '') + (withTools ? '/responses' : '/chat/completions'));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new ApiError(503, 'provider_unavailable');
  if (withTools) {
    if (!facts || !runTools) throw new ApiError(502, 'facts_unavailable');
    const value = await responsesWithTools({url: url.toString(), key: env.COACH_API_KEY, model, count,
      effort: env.COACH_REASONING_EFFORT ?? 'high', maxTokens: setting(env.COACH_MAX_TOKENS, 5400, 65536), deadline,
      reserveMs: Math.min(30_000, timeoutMs(env) / 4), prompt: toolsPrompt, userContext: toolsContext(input, facts),
      facts, signal, transport, runTools, inspect: (raw, evidence) => {
        try { return inspectDraft(JSON.parse(raw), refs, evidence); }
        catch { return {accepted: false, issues: [{code: 'invalid_json'}]}; }
      },
    });
    return withoutClaims(value);
  }
  const started = Date.now();
  let stage = 'provider_fetch', httpStatus: number | undefined;
  try {
    // Workersはredirect:errorを受理しない。manualで追従せず、非2xxとして拒否する。
    const response = await transport(url.toString(), {method: 'POST', signal, redirect: 'manual', headers: {'Authorization': `Bearer ${env.COACH_API_KEY}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({model, messages: messages(input, refs, facts), stream: false,
        response_format: {type: 'json_object'}, reasoning_effort: 'max',
        [env.COACH_TOKEN_PARAMETER === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens']: setting(env.COACH_MAX_TOKENS, 32768, 65536)})});
    httpStatus = response.status;
    stage = 'provider_http';
    if (!response.ok) { await response.body?.cancel(); throw new ApiError(502, 'provider_failed'); }
    stage = 'provider_read';
    const data = record(await readJson(new Request('https://provider', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: response.body, duplex: 'half'} as RequestInit), 1_048_576));
    stage = 'provider_output';
    if (data.choices?.[0]?.finish_reason !== 'stop' || typeof data.choices[0].message?.content !== 'string') throw new ApiError(502, 'invalid_output');
    count(data.usage);
    try { return JSON.parse(data.choices[0].message.content); } catch { throw new ApiError(502, 'invalid_output'); }
  } catch (error) {
    console.log(JSON.stringify({event: 'coach_provider_failed', stage, errorType: errorType(error), httpStatus, elapsedMs: Date.now() - started}));
    throw error;
  }
}
function publicReferenceIds(ids: unknown[], refs: Reference[], facts?: CoachFacts) {
  if (!Array.isArray(ids)) throw new Error();
  const origins = new Set<string>();
  const unique = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string') throw new Error();
    const origin = facts && lineOrigin(id, facts);
    const publicId = origin ?? id;
    if (!refs.some(r => r.id === publicId) || facts && !hasFactReference(publicId, facts)) throw new Error();
    unique.add(publicId);
    if (origin) origins.add(origin);
  }
  if (!origins.size && ids.length > 10) throw new Error();
  // 上限を超える場合は、仮の手順を根拠にした起点を優先して元の順に返す。
  const kept = new Set([...origins, ...unique].slice(0, 10));
  return [...unique].filter(id => kept.has(id));
}

export function validateOutput(value: unknown, refs: Reference[], facts?: CoachFacts) {
  try {
    const x = record(value); keys(x, ['sections']);
    if (!Array.isArray(x.sections) || !x.sections.length || x.sections.length > 12) throw new Error();
    return {sections: x.sections.map((value: unknown) => {
      const s = record(value); keys(s, ['kind', 'title', 'text', 'refs']);
      if (!['facts', 'advice'].includes(s.kind)) throw new Error();
      const title = text(s.title, 80), body = text(s.text, 2000);
      if (!Array.isArray(s.refs)) throw new Error();
      const selected = publicReferenceIds(s.refs, refs, facts);
      if (s.kind === 'facts' && !selected.length) throw new Error();
      if (notationIssue(title + '。' + body, facts, s.kind, selected)) throw new Error();
      if (facts && contradicts(title + '。' + body, selected, facts)) throw new Error();
      return {kind: s.kind as 'facts' | 'advice', title, text: body, references: selected.map(id => refs.find(r => r.id === id)!)};
    })};
  } catch { throw new ApiError(502, 'invalid_output'); }
}

function withoutClaims(value: unknown) {
  if (value && typeof value === 'object' && 'claims' in value && Array.isArray(value.claims) && !Array.isArray(value)) {
    const {claims: _, ...output} = value;
    return output;
  }
  return value;
}

export function inspectDraft(draft: unknown, refs: Reference[], facts: CoachFacts, includeOutput = false) {
  const issues: {section?: number; field?: string; code: string}[] = [];
  const output: any = withoutClaims(draft);
  try {
    const published = validateOutput(output, refs, facts);
    return {accepted: true, issues, ...(includeOutput ? {published} : {})};
  } catch { /* 以下は診断のみ */ }
  if (Array.isArray(output?.sections)) output.sections.forEach((s: any, section: number) => {
    try { validateOutput({sections: [s]}, refs, facts); return; } catch { /* 不合格の節だけを検査 */ }
    const count = issues.length;
    if (s && ['facts', 'advice'].includes(s.kind)) {
      let selected: string[] = [];
      try { selected = publicReferenceIds(s.refs, refs, facts); }
      catch { issues.push({section, field: 'refs', code: 'invalid_reference'}); }
      for (const field of ['title', 'text']) {
        if (typeof s[field] !== 'string') continue;
        const issue = notationIssue(s[field], facts, s.kind, selected);
        if (issue) issues.push({section, field, code: issue});
        if (Array.isArray(s.refs) && contradicts(s[field], selected, facts)) issues.push({section, field, code: 'contradicts'});
      }
    }
    if (count === issues.length) issues.push({section, code: 'invalid_output'});
  });
  return {accepted: false, issues: issues.length ? issues : [{code: 'invalid_output'}]};
}

export class Coach {
  private active = new Map<string, AbortController>();
  constructor(private storage: DurableObjectStorage, private env: CoachEnv, private device: string, private paid: () => boolean,
    private loadFacts?: (input: CoachInput, signal: AbortSignal) => Promise<CoachFacts | undefined>, private refreshPaid?: () => Promise<void>,
    private runTools?: (input: CoachInput, calls: Parameters<RunTools>[0], signal: AbortSignal) => Promise<unknown[]>) {
    storage.transactionSync(() => {
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS coach_weekly_usage (week INTEGER PRIMARY KEY, used_nano_usd INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS coach_requests (id TEXT PRIMARY KEY, week INTEGER NOT NULL, status TEXT NOT NULL, deadline INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS coach_tasks (id TEXT PRIMARY KEY, payload TEXT, output TEXT, error TEXT, started INTEGER NOT NULL DEFAULT 0);`);
      if (storage.sql.exec('PRAGMA table_info(coach_requests)').toArray().some(column => column.name === 'month')) {
        // 月の回数は換算できない。旧ID・完了結果は保ち、処理中の要求は移行週で精算する。
        storage.sql.exec('ALTER TABLE coach_requests RENAME COLUMN month TO week');
        storage.sql.exec("UPDATE coach_requests SET week=? WHERE status='pending'", weekStart(Date.now()));
        storage.sql.exec('DROP TABLE IF EXISTS coach_usage');
      }
    });
  }
  quota(now = Date.now()) {
    const week = weekStart(now), budget = weeklyBudget(this.env.COACH_WEEKLY_BUDGET_USD);
    const used = this.storage.sql.exec<{used_nano_usd: number}>('SELECT used_nano_usd FROM coach_weekly_usage WHERE week=?', week).toArray()[0]?.used_nano_usd ?? 0;
    const remainingRatio = Math.max(0, budget - used) / budget;
    return {remainingRatio, resetsAt: week + 7 * 86400_000, low: remainingRatio < 0.1, exhausted: remainingRatio === 0};
  }
  private status(id: string) { return this.storage.sql.exec<{status: string; week: number; deadline: number}>('SELECT status,week,deadline FROM coach_requests WHERE id=?', id).toArray()[0]; }
  private async wake(at: number) {
    const current = await this.storage.getAlarm();
    if (current === null || current > at) await this.storage.setAlarm(at);
  }
  nextAlarm(): number | null {
    return this.storage.sql.exec<{at: number | null}>(`SELECT MIN(CASE WHEN t.started=0 AND r.status='pending' THEN ? ELSE r.deadline END) AS at
      FROM coach_requests r JOIN coach_tasks t ON t.id=r.id`, Date.now() + 100).one().at;
  }
  async alarm() {
    const task = this.storage.sql.exec<{id: string; payload: string}>(`SELECT t.id,t.payload FROM coach_tasks t JOIN coach_requests r ON r.id=t.id
      WHERE r.status='pending' AND t.started=0 AND r.deadline>? LIMIT 1`, Date.now()).toArray()[0];
    if (task) {
      this.storage.sql.exec('UPDATE coach_tasks SET started=1 WHERE id=?', task.id);
      await this.wake(this.status(task.id)!.deadline);
      await this.generate(JSON.parse(task.payload));
    }
    this.expire();
  }
  private expire() {
    const now = Date.now();
    this.storage.sql.exec("UPDATE coach_tasks SET payload=NULL,error='coach_timeout' WHERE id IN (SELECT id FROM coach_requests WHERE status='pending' AND deadline<=?)", now);
    this.storage.sql.exec("UPDATE coach_requests SET status='failed',deadline=? WHERE status='pending' AND deadline<=?", now + 7 * 86400_000, now);
    this.storage.sql.exec('DELETE FROM coach_tasks WHERE id IN (SELECT id FROM coach_requests WHERE status!=? AND deadline<=?)', 'pending', now);
  }
  private view(id: string) {
    const current = this.status(id);
    if (!current) throw new ApiError(404, 'not_found');
    if (current.status !== 'pending' && current.deadline <= Date.now()) throw new ApiError(410, 'result_expired');
    const task = this.storage.sql.exec<{output: string | null; error: string | null}>('SELECT output,error FROM coach_tasks WHERE id=?', id).toArray()[0];
    return {requestId: id, status: current.status, expiresAt: current.deadline,
      ...(task?.output ? JSON.parse(task.output) : {}), error: task?.error ?? null, quota: this.quota()};
  }
  private async generate(input: CoachInput, request?: Request): Promise<Response> {
    const refs = references(input.results), controller = new AbortController();
    this.active.set(input.requestId, controller);
    const deadline = this.status(input.requestId)!.deadline;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), Math.max(1, deadline - Date.now()));
    const signal = AbortSignal.any([controller.signal, ...(request ? [request.signal] : []), timeout.signal]);
    const started = Date.now();
    let stage = 'entitlement', cost = 0;
    try {
      await this.refreshPaid?.();
      if (!this.paid()) throw new ApiError(403, 'paid_required');
      if (this.env.COACH_PROVIDER !== 'fake' && !this.env.COACH_API_KEY) throw new ApiError(503, 'provider_unavailable');
      stage = 'load_facts';
      const loadFacts = this.loadFacts;
      const facts = loadFacts ? await abortable(signal, () => loadFacts(input, signal)) : undefined;
      if (!facts && this.env.COACH_PROVIDER !== 'fake' && this.loadFacts) throw new ApiError(502, 'facts_unavailable');
      stage = 'complete';
      const value = await complete(this.env, input, refs, signal, fetch, facts,
        this.runTools && ((calls, signal) => this.runTools!(input, calls, signal)), deadline, turn => { cost += turn; });
      stage = 'validate_output';
      const output = validateOutput(value, refs, facts);
      stage = 'commit';
      await this.refreshPaid?.();
      return this.storage.transactionSync(() => {
        const current = this.status(input.requestId);
        if (controller.signal.aborted || request?.signal.aborted || current?.status !== 'pending') throw new ApiError(409, 'cancelled');
        if (Date.now() >= deadline || signal.aborted) throw new ApiError(504, 'coach_timeout');
        if (!this.paid()) throw new ApiError(403, 'paid_required');
        this.storage.sql.exec("UPDATE coach_requests SET status='completed',deadline=? WHERE id=?", Date.now() + 7 * 86400_000, input.requestId);
        if (!Number.isSafeInteger(cost)) throw new ApiError(502, 'invalid_usage');
        if (cost) this.storage.sql.exec(`INSERT INTO coach_weekly_usage VALUES (?,?)
          ON CONFLICT(week) DO UPDATE SET used_nano_usd=MIN(9007199254740991, used_nano_usd+excluded.used_nano_usd)`, current.week, cost);
        this.storage.sql.exec('UPDATE coach_tasks SET payload=NULL,output=? WHERE id=?', JSON.stringify(output), input.requestId);
        console.log(JSON.stringify({event: 'coach_completed', elapsedMs: Date.now() - started}));
        return json({requestId: input.requestId, ...output, quota: this.quota()});
      });
    } catch (error) {
      const cancelled = controller.signal.aborted || request?.signal.aborted || this.status(input.requestId)?.status === 'cancelled';
      const failure = cancelled ? new ApiError(409, 'cancelled') : Date.now() >= deadline || signal.aborted ? new ApiError(504, 'coach_timeout') : error instanceof ApiError ? error : new ApiError(502, 'provider_failed');
      console.log(JSON.stringify({event: 'coach_failed', error: failure.code, stage, errorType: errorType(error), elapsedMs: Date.now() - started}));
      this.storage.sql.exec("UPDATE coach_requests SET status=?,deadline=? WHERE id=? AND status='pending'", cancelled ? 'cancelled' : 'failed', Date.now() + 7 * 86400_000, input.requestId);
      this.storage.sql.exec('UPDATE coach_tasks SET payload=NULL,error=? WHERE id=?', failure.code, input.requestId);
      return json({error: failure.code, quota: this.quota()}, failure.status);
    } finally {
      clearTimeout(timer);
      this.active.delete(input.requestId);
      const next = this.nextAlarm();
      if (next !== null) await this.wake(next);
    }
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const now = Date.now();
      await this.refreshPaid?.();
      this.expire();
      this.storage.sql.exec('DELETE FROM coach_requests WHERE deadline<?', now - 32 * 86400_000);
      this.storage.sql.exec('DELETE FROM coach_weekly_usage WHERE week<?', weekStart(now) - 7 * 86400_000);
      if (request.method === 'GET' && new URL(request.url).pathname === '/v1/coach') {
        const latest = this.storage.sql.exec<{id: string}>('SELECT id FROM coach_requests ORDER BY rowid DESC LIMIT 1').toArray()[0];
        return json({paid: this.paid(), quota: this.quota(), latest: latest && this.status(latest.id)!.deadline > now ? this.view(latest.id) : null});
      }
      const cancel = /^\/v1\/coach\/([a-f0-9-]{36})$/.exec(new URL(request.url).pathname);
      if (cancel && request.method === 'GET') return json(this.view(cancel[1]));
      if (cancel && request.method === 'DELETE') {
        // 本文を受信中のPOSTより先に届いた中止も、同じIDの墓標で止める。
        this.storage.sql.exec("INSERT OR IGNORE INTO coach_requests VALUES (?,?,'cancelled',?)", cancel[1], weekStart(now), now + 7 * 86400_000);
        this.storage.sql.exec("UPDATE coach_requests SET status='cancelled',deadline=? WHERE id=? AND status='pending'", now + 7 * 86400_000, cancel[1]);
        this.storage.sql.exec('UPDATE coach_tasks SET payload=NULL WHERE id=?', cancel[1]);
        this.active.get(cancel[1])?.abort();
        return json({status: this.status(cancel[1])?.status ?? 'not_found', quota: this.quota()});
      }
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/coach') throw new ApiError(404, 'not_found');
      if (!this.paid()) throw new ApiError(403, 'paid_required');
      const input = parseCoach(await readJson(request, 1_048_576));
      if (!this.env.COACH_SIGNING_KEY) throw new ApiError(503, 'signing_unavailable');
      await verifyAnalysis(this.env.COACH_SIGNING_KEY, this.device, input.input, input.results, input.proof);
      const asynchronous = request.headers.get('Prefer')?.includes('respond-async') ?? false;
      await this.refreshPaid?.();
      const timeout = timeoutMs(this.env), wakeFrom = Date.now();
      // 同期も保存前にwatchdogを永続化し、プロセス消失後の入力削除を保証する。
      await this.wake(asynchronous ? wakeFrom + 100 : wakeFrom + timeout);
      this.storage.transactionSync(() => {
        // 本文受信・署名検証の待機中に更新された権利を、確定直前に再確認する。
        if (!this.paid()) throw new ApiError(403, 'paid_required');
        if (request.signal.aborted) throw new ApiError(409, 'cancelled');
        if (this.status(input.requestId)) throw new ApiError(409, 'request_exists');
        const accepted = Date.now();
        if (this.quota(accepted).exhausted) throw new ApiError(429, 'weekly_limit');
        if (this.storage.sql.exec("SELECT id FROM coach_requests WHERE status='pending' AND deadline>? LIMIT 1", accepted).toArray().length) throw new ApiError(409, 'coach_busy');
        const rates = coachRates(this.env);
        if (rates && !this.env.COACH_API_KEY) throw new ApiError(503, 'provider_unavailable');
        this.storage.sql.exec("INSERT INTO coach_requests VALUES (?,?,'pending',?)", input.requestId, weekStart(accepted), wakeFrom + timeout);
        this.storage.sql.exec('INSERT INTO coach_tasks (id,payload,started) VALUES (?,?,?)', input.requestId, JSON.stringify(input), asynchronous ? 0 : 1);
      });
      if (asynchronous) return json(this.view(input.requestId), 202);
      return await this.generate(input, request);
    } catch (error) {
      return json({error: error instanceof ApiError ? error.code : 'coach_unavailable', quota: this.quota()}, error instanceof ApiError ? error.status : 503);
    }
  }
}
