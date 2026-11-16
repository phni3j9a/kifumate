/* ---------- game screen: replay, analysis results, trying moves on a branch ---------- */
let CUR = null, G = null, P = [], N = 0, M = null, SELF = 's', OTHER = 'g', FLIP = false, OWN = true;
let POS = [], PH = [], MARKS = [], MARKED = new Set();
const S = { ply: 0, sel: 0, pick: null, targets: [], br: null, lastBr: null, promo: null, rtUntil: 0, rtOn: true, rtWarm: false, kind: 'pre', told: {} };
let RUN = null;      /* the analysis in progress: { id, done, total, kind, timer, paused } */
const QUEUE = [];    /* records waiting for their turn: { id, kind }. One analysis runs at a time. */
let rtTimer = 0, rtIdle = 0;

const MKC = { '悪手': 'bad', '疑問手': 'dub', '好手': 'good' };
const JN = ['互角', 'やや有利', '有利', '優勢', '勝勢'];
const YOU = () => (OWN ? 'あなた' : '先手'), OPP = () => (OWN ? '相手' : '後手');
const markHTML = (m) => (m ? `<em class="mk mk-${MKC[m]}">${m}</em>` : '');
/* 'none' not analysed, 'run' being analysed, 'done' results saved */
const anMode = () => (RUN && CUR && RUN.id === CUR.id ? 'run' : CUR && CUR.an !== 'none' ? 'done' : 'none');
const seen = (p) => { const m = anMode(); return m === 'done' || (m === 'run' && p <= RUN.done); };
const rawKind = (p) => (p.mark ? MKC[p.mark] : p.missedTsume ? 'dub' : null);
const kindOfMark = (p) => (seen(p.ply) ? rawKind(p) : null);
const marksOf = (p) => (seen(p.ply) ? markHTML(p.mark) + (p.missedTsume ? '<em class="mk mk-dub">詰み逃し</em>' : '') : '');
const cpOf = (o) => (o.mate != null ? (o.mate > 0 ? 3000 : -3000) : o.cp);
const wrSelf = (o) => { const w = 100 / (1 + Math.exp(-cpOf(o) / 600)); return SELF === 's' ? w : 100 - w; };
const pct = (w) => Math.max(1, Math.min(99, Math.round(w)));
/* evaluation from the bottom player's side: plus means you are ahead. Clamped to ±3000 for the graph. */
const valOf = (o) => (SELF === 's' ? 1 : -1) * cpOf(o);
const sgn = (v) => (v > 0 ? '+' + v : v < 0 ? '−' + -v : '±0');
/* who won, as recorded for this game (it can be corrected by hand): 's' / 'g', or null for a draw or unknown */
const winnerSide = () => (CUR.win === 's' || CUR.win === 'g' ? CUR.win : null);
const resultText = () => { const w = winnerSide(); return w ? (w === SELF ? YOU() : OPP()) + 'の勝ち' : CUR.win === 'd' ? '引き分け' : '結果は不明'; };
/* 「詰み」 is written only where a mate is proven (a 1- or 3-move mate found by the mate search, the
   positions along that line, and a game that ended in mate). An engine score that merely says
   "mate" is shown as a large advantage, not as a fact. */
const fmtVal = (o) => {
  if (o.end) return '終局';
  const v = valOf(o);
  if (o.mate != null || Math.abs(v) >= 3000) return (v > 0 ? '+' : '−') + '3000以上';
  return sgn(v);
};
function markProven() {
  for (let i = 0; i <= N; i++) {
    const p = P[i];
    let pv = !!p.tsume || !!p.end;
    for (let k = 1; k <= 2 && !pv && i - k >= 0; k++) {
      const t = P[i - k].tsume;
      if (!t || t.line.length <= k) continue;
      pv = true;
      for (let j = 0; j < k; j++) if (P[i - k + j + 1].move.usi !== t.line[j].usi) pv = false;
    }
    p._pv = pv;
    (p.cands || []).forEach((c) => { c._pv = !!p.tsume && c.usi === p.tsume.line[0].usi; });
  }
}
const judge = (o) => { const c = cpOf(o), a = Math.abs(c); return { lv: a < 150 ? 0 : a < 450 ? 1 : a < 1000 ? 2 : a < 2000 ? 3 : 4, side: c >= 0 ? 's' : 'g' }; };
const plyLabel = (p) => (p ? p + '手目' : '開始局面');
const turnSide = (p) => (P[p].sfen.split(' ')[1] === 'b' ? 's' : 'g');
const moverSide = (p) => (p % 2 === 1 ? 's' : 'g');
const brNow = () => (S.br ? S.br.line[S.br.at - 1] : null);
const gameOver = () => !S.br && S.ply >= N;
/* real-time analysis on a branch: 'free' not in the plan, 'off' switched off by the user, 'offline',
   'limit' this month's minutes are used up, 'on' */
const rtState = () => (!paid() ? 'free' : !S.rtOn ? 'off' : !DB.online ? 'offline' : DB.usage.rt >= DB.usage.rtMax ? 'limit' : 'on');
const rtBusy = () => !!S.br && rtState() === 'on' && performance.now() < S.rtUntil;
/* The evaluation to show for the branch position. Along a saved reading line the saved value is shown
   on every plan (nothing new is analysed); off those lines only real-time analysis can answer. */
const brShown = () => { const e = brNow(); return e && e.an.known && !rtBusy() ? e.an : null; };
const waiting = () => !!CUR && QUEUE.some((q) => q.id === CUR.id);
const freeLeft = () => Math.max(0, DB.usage.freeMax - DB.usage.free);
/* paid plan: every analysis counts toward the weekly total, and a precise one toward its own limit as well */
const totalLeft = () => Math.max(0, DB.usage.totalMax - DB.usage.total);
const preciseLeft = () => Math.min(totalLeft(), Math.max(0, DB.usage.preciseMax - DB.usage.precise));
const canRun = (kind) => (!paid() ? freeLeft() : kind === 'pre' ? preciseLeft() : totalLeft()) > 0;
const WEEK = '月曜の午前0時';
/* the two limits that stay out of sight: nothing is said until less than a tenth is left */
const lowOn = (left, max) => left < max / 10;
const aiLeft = () => Math.max(0, DB.usage.aiMax - DB.usage.ai);
const aiLow = () => lowOn(aiLeft(), DB.usage.aiMax);
const rtLeft = () => Math.max(0, DB.usage.rtMax - DB.usage.rt);
const rtLow = () => lowOn(rtLeft(), DB.usage.rtMax);
function useAI() {
  const was = aiLow();
  DB.usage.ai++;
  if (!was && aiLow()) toast(`AIコーチは、今月あと${aiLeft()}回使えます`);
}
const onGame = (gm) => { const t = topNav(); return !!t && t.t === 'game' && t.id === gm.id; };
/* how many candidates this record has: three after a precise analysis, else one. What was saved stays
   readable when the plan changes; the plan only limits making new analyses. */
const candCount = () => (CUR.an === 'pre' ? 3 : 1);
function view() {
  const e = brNow();
  return e ? { pos: e.pos, turn: e.turn, last: e.mv, br: e } : { pos: POS[S.ply], turn: turnSide(S.ply), last: P[S.ply].move, br: null };
}

function loadGame(gm) {
  CUR = gm; G = gm.data; P = G.positions; N = P.length - 1; M = G.meta;
  /* your side sits at the bottom; a record that is not yours is seen from sente unless turned round */
  OWN = !!gm.self; SELF = gm.self || gm.view || 's'; OTHER = flip(SELF); FLIP = SELF === 'g';
  POS = P.map((p) => parseSfen(p.sfen));
  markProven();
  PH = phases(); MARKS = allMarks(); MARKED = new Set(MARKS.map((m) => m.i));
  Object.assign(S, { sel: 0, pick: null, targets: [], br: null, promo: null, rtUntil: 0 });
  R.youname.textContent = SELF === 's' ? gm.sente : gm.gote;
  R.oppname.textContent = SELF === 's' ? gm.gote : gm.sente;
  R.youav.textContent = SELF === 's' ? '☗' : '☖';
  R.oppav.textContent = OTHER === 's' ? '☗' : '☖';
  R.youid.dataset.side = SELF; R.oppid.dataset.side = OTHER;
  R.youl.textContent = YOU(); R.oppl.textContent = OPP();
  R.graph.setAttribute('aria-valuemax', N);
  S.ply = gm.ply != null ? Math.min(N, gm.ply) : startPly();
}
/* an analysed record opens at your first blunder; one that is not analysed opens at the start */
function startPly() {
  if (CUR.an === 'none') return 0;
  let s = P.findIndex((p, i) => i > 30 && p.mark === '悪手' && moverSide(i) === SELF);
  if (s < 0) s = P.findIndex((p, i) => i > 30 && p.mark === '悪手');
  return s < 0 ? 0 : s;
}
function enterGame(t) {
  const gm = gameById(t.id), fresh = CUR !== gm && gm.ply == null;
  if (CUR !== gm) loadGame(gm);
  renderGame();
  if (fresh && S.ply > 0 && R.toast.hidden) toast(OWN ? 'あなたの最初の悪手から表示しています' : '最初の悪手から表示しています');
}
/* the real-time analysis stops with the branch: switched off, left, or idle for a while */
function stopRt() { clearTimeout(rtTimer); clearTimeout(rtIdle); S.rtWarm = false; S.rtUntil = 0; }
function leaveGame() { stopRt(); if (S.br) { S.br = null; clearSel(); } }

/* ---------- game phases (a simple stand-in rule for the mock) ---------- */
function phases() {
  let cap = N + 1;
  for (let i = 1; i <= N; i++) {
    const [f, r] = sq(P[i].move.to);
    if (POS[i - 1].cells.some((c) => c.f === f && c.r === r)) { cap = i; break; }
  }
  const openEnd = Math.min(N, Math.max(1, cap - 1));
  const major = (i) => POS[i].cells.some((c) => c.prom && (c.k === 'R' || c.k === 'B'));
  let end = N + 1;
  for (let i = openEnd + 8; i + 3 <= N; i++) { if (major(i) && major(i + 1) && major(i + 2) && major(i + 3)) { end = i; break; } }
  if (openEnd >= N) return [{ n: '序盤', a: 0, b: N }];
  if (end > N) return [{ n: '序盤', a: 0, b: openEnd }, { n: '中盤', a: openEnd + 1, b: N }];
  return [{ n: '序盤', a: 0, b: openEnd }, { n: '中盤', a: openEnd + 1, b: end - 1 }, { n: '終盤', a: end, b: N }];
}
/* marked moves for the graph lanes: your moves on the top row, the opponent's on the bottom row */
function allMarks() {
  const out = [];
  for (let i = 1; i <= N; i++) { const k = rawKind(P[i]); if (k) out.push({ i, kind: k, self: moverSide(i) === SELF }); }
  for (let i = 0; i <= N; i++) if (P[i].tsume && !(i >= 2 && P[i - 2].tsume)) out.push({ i, kind: 'mate', self: turnSide(i) === SELF });
  return out.sort((a, b) => a.i - b.i || (a.kind === 'mate' ? -1 : 1));
}
function rowsFor(p) {
  const pos = P[p], nx = p < N ? P[p + 1] : null, all = pos.cands || [];
  const rows = all.slice(0, candCount()).map((c, i) => {
    const game = !!nx && nx.move.usi === c.usi;
    return { rank: i, c, game, pv: (c.pv || []).slice(1), o: c, ja: c.ja, mk: game ? marksOf(nx) : '' };
  });
  if (nx && !rows.some((r) => r.game)) {
    const pv = [];
    for (let k = p + 2; k <= Math.min(N, p + 6); k++) pv.push(P[k].move.ja);
    rows.push({ rank: -1, c: nx.move, game: true, pv, o: nx, ja: nx.move.ja, mk: marksOf(nx) });
  }
  return rows;
}
const lockedCount = (p) => Math.max(0, Math.min(3, (P[p].cands || []).length) - candCount());

/* ---------- board: drawn from the bottom player's side, so it turns round when you are gote ---------- */
const CW = 100, CH = 108, OX = 10, OY = 38, BW = OX + 900 + 34, BH = OY + 972 + 12;
const VBX = -4, VBY = -4, VBW = BW + 8, VBH = BH + 20;
const PATH = 'M50 9 79 25 89 99 11 99 21 25Z';
const xy = (f, r) => (FLIP ? [OX + (f - 1) * CW, OY + (9 - r) * CH] : [OX + (9 - f) * CW, OY + (r - 1) * CH]);
function pieceG(k, prom, side, x, y, o) {
  o = o || {};
  const sc = SZ[k], t = prom ? KJP[k] : k === 'K' ? (side === 's' ? '玉' : '王') : KJ[k];
  const rot = side !== SELF ? ' rotate(180 50 54)' : '';
  const scl = sc !== 1 ? ` translate(${(50 * (1 - sc)).toFixed(2)} ${(58 * (1 - sc)).toFixed(2)}) scale(${sc})` : '';
  const cls = `pc${side === SELF ? '' : ' po'}${prom ? ' pr' : ''}${k === 'K' ? ' kg' : ''}${o.cls || ''}`;
  return `<g class="${cls}" transform="translate(${x} ${y})"><path class="sh" d="${PATH}" transform="translate(0 6)${rot}${scl}"/><g transform="translate(0 ${o.lift ? -7 : 0})${rot}${scl}"><path class="fc" d="${PATH}"/><text x="50" y="64" dy=".35em" text-anchor="middle">${t}</text></g></g>`;
}
function arrowG(m, side) {
  if (!m) return '';
  const [tx, ty] = xy(...sq(m.to)), ex = tx + 50, ey = ty + 54;
  if (m.drop) return `<g class="ar">${pieceG(m.usi[0], false, side, tx, ty, { cls: ' gh' })}<circle class="ar-ring" cx="${ex}" cy="${ey}" r="47"/></g>`;
  const [fx, fy] = xy(...sq(m.from)), sx = fx + 50, sy = fy + 54;
  const dx = ex - sx, dy = ey - sy, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, px = -uy, py = ux;
  /* The arrow runs from the edge of the moving piece towards the square it lands on, so it does not
     cover the piece's face; on a capture it stops short of the captured piece's face as well. */
  const tipOff = m.cap ? 34 : 12, head = Math.min(46, Math.max(26, L - tipOff - 44)), start = Math.max(0, Math.min(44, L - tipOff - head - 2)), hw = (30 * head) / 46;
  const a = [sx + ux * start, sy + uy * start], tip = [ex - ux * tipOff, ey - uy * tipOff], b = [tip[0] - ux * head, tip[1] - uy * head];
  const f1 = (n) => n.toFixed(1);
  const shape = `<line class="ar-ln" x1="${f1(a[0])}" y1="${f1(a[1])}" x2="${f1(b[0])}" y2="${f1(b[1])}"/><polygon class="ar-hd" points="${f1(tip[0])},${f1(tip[1])} ${f1(b[0] + px * hw)},${f1(b[1] + py * hw)} ${f1(b[0] - px * hw)},${f1(b[1] - py * hw)}"/>`;
  return `<g class="ar"><g class="ar-ul">${shape}</g>${shape}</g>`;
}
/* the same three glyphs are used on the board and in the graph: × bad, △ dubious, ◎ good */
function glyph(kind, s) {
  if (kind === 'bad') return `<path class="gi" d="M${-s} ${-s} ${s} ${s}M${s} ${-s} ${-s} ${s}"/>`;
  if (kind === 'dub') return `<path class="gi" d="M0 ${-1.25 * s} ${1.2 * s} ${0.85 * s}H${-1.2 * s}Z"/>`;
  return `<circle class="gi" r="${1.2 * s}"/><circle class="gf" r="${0.42 * s}"/>`;
}
function boardSVG() {
  const v = view(), pos = v.pos, last = v.last, turn = v.turn, g = gridOf(pos), pk = S.pick;
  let arrow = null;
  if (!pk && !S.promo) {
    if (v.br) { const a = brShown(); arrow = a ? a.next : null; }
    else if (anMode() === 'done') { const sel = rowsFor(S.ply)[S.sel]; arrow = sel ? sel.c : null; }
  }
  const Z = '一二三四五六七八九';
  let s = `<svg class="bd" viewBox="${VBX} ${VBY} ${VBW} ${VBH}" role="img" aria-label="${v.br ? '分岐' + S.br.at + '手目' : plyLabel(S.ply)}の盤面">`;
  s += `<defs><clipPath id="sfc"><rect x="${OX}" y="${OY}" width="900" height="972" rx="12"/></clipPath></defs>`;
  s += `<rect class="b-sh" x="0" y="12" width="${BW}" height="${BH}" rx="34"/><rect class="b-rim" x="0" y="0" width="${BW}" height="${BH}" rx="34"/>`;
  s += `<g clip-path="url(#sfc)"><rect class="b-sf" x="${OX}" y="${OY}" width="900" height="972"/>`;
  s += `<rect class="b-ze" x="${OX}" y="${OY}" width="900" height="${CH * 3}"/><rect class="b-zo" x="${OX}" y="${OY + CH * 6}" width="900" height="${CH * 3}"/>`;
  if (last) {
    /* the square the last move left; skipped when the suggested move lands there, so one square never carries two markers */
    if (last.from && !(arrow && arrow.to === last.from)) { const [x, y] = xy(...sq(last.from)); s += `<rect class="b-from" x="${x + 9}" y="${y + 9}" width="${CW - 18}" height="${CH - 18}" rx="10"/>`; }
    const [x, y] = xy(...sq(last.to)); s += `<rect class="b-to" x="${x}" y="${y}" width="${CW}" height="${CH}"/>`;
  }
  const chk = !gameOver() && inCheck(g, turn) ? kingOf(g, turn) : null;
  if (chk) { const [x, y] = xy(chk[0], chk[1]); s += `<rect class="b-chk" x="${x}" y="${y}" width="${CW}" height="${CH}"/>`; }
  if (pk && pk.f) { const [x, y] = xy(pk.f, pk.r); s += `<rect class="b-sel" x="${x}" y="${y}" width="${CW}" height="${CH}"/>`; }
  s += '</g>';
  for (let i = 1; i < 9; i++) s += `<line class="b-ln" x1="${OX + i * CW}" y1="${OY}" x2="${OX + i * CW}" y2="${OY + 972}"/><line class="b-ln" x1="${OX}" y1="${OY + i * CH}" x2="${OX + 900}" y2="${OY + i * CH}"/>`;
  s += `<rect class="b-sfb" x="${OX}" y="${OY}" width="900" height="972" rx="12"/>`;
  for (const [i, j] of [[3, 3], [6, 3], [3, 6], [6, 6]]) s += `<circle class="b-star" cx="${OX + i * CW}" cy="${OY + j * CH}" r="8"/>`;
  for (let f = 1; f <= 9; f++) s += `<text class="b-co" x="${xy(f, 1)[0] + 50}" y="${OY / 2 + 1}" dy=".35em" text-anchor="middle">${f}</text>`;
  for (let r = 1; r <= 9; r++) s += `<text class="b-co" x="${OX + 900 + 17}" y="${xy(1, r)[1] + 54}" dy=".35em" text-anchor="middle">${Z[r - 1]}</text>`;
  let lifted = '';
  for (const c of pos.cells) {
    const [x, y] = xy(c.f, c.r);
    if (pk && pk.f === c.f && pk.r === c.r) lifted = pieceG(c.k, c.prom, c.side, x, y, { lift: true });
    else s += pieceG(c.k, c.prom, c.side, x, y);
  }
  s += lifted;
  if (pk) {
    for (const [f, r] of S.targets) {
      const [x, y] = xy(f, r);
      s += g[r - 1][f - 1] ? `<circle class="b-cap" cx="${x + 50}" cy="${y + 54}" r="45"/>` : `<circle class="b-dot" cx="${x + 50}" cy="${y + 54}" r="15"/>`;
    }
  }
  s += arrowG(arrow && !arrow.drop ? { ...arrow, cap: !!g[sq(arrow.to)[1] - 1][sq(arrow.to)[0] - 1] } : arrow, turn);
  const qk = last && !v.br ? kindOfMark(P[S.ply]) : null;
  if (qk) { const [x, y] = xy(...sq(last.to)); s += `<g class="b-q ${qk}" transform="translate(${x + 85} ${y + 17})"><circle class="bg" r="21"/>${glyph(qk, 8.5)}</g>`; }
  if (chk) {
    const [x, y] = xy(chk[0], chk[1]);
    const bx = Math.max(OX + 6, Math.min(OX + 900 - 90, x + 8)), by = y > OY + 20 ? y - 26 : y + CH - 8;
    s += `<g class="b-ck"><rect x="${bx}" y="${by}" width="84" height="36" rx="18"/><text x="${bx + 42}" y="${by + 18}" dy=".35em" text-anchor="middle">王手</text></g>`;
  }
  return s + '</svg>';
}
function faceSVG(t, cls) { return `<svg class="mp${cls}" viewBox="0 0 100 108" aria-hidden="true"><path d="${PATH}"/><text x="50" y="64" dy=".35em" text-anchor="middle">${t}</text></svg>`; }
function promoHTML() {
  const pr = S.promo;
  if (!pr) return '';
  const [x, y] = xy(pr.f, pr.r);
  const left = Math.max(22, Math.min(78, ((x + 50 - VBX) / VBW) * 100)), top = Math.max(12, Math.min(88, ((y + 54 - VBY) / VBH) * 100));
  return `<div class="prm" style="left:${left.toFixed(1)}%;top:${top.toFixed(1)}%" role="group" aria-label="成りますか"><button type="button" data-a="promo" data-v="1">${faceSVG(KJP[pr.k], ' pr')}成る</button><button type="button" data-a="promo" data-v="0">${faceSVG(KJ[pr.k], '')}成らない</button></div>`;
}
function trayHTML(h, side) {
  const live = !gameOver() && view().turn === side;
  return ['R', 'B', 'G', 'S', 'N', 'L', 'P'].filter((k) => h[k]).map((k) => {
    const on = live && S.pick && S.pick.hand === k;
    return `<button type="button" class="hk${on ? ' on' : ''}" data-a="hand" data-v="${k}" data-side="${side}" aria-label="持ち駒 ${KJ[k]}">${faceSVG(KJ[k], side === SELF ? '' : ' po')}${h[k] > 1 ? `<b>${h[k]}</b>` : ''}</button>`;
  }).join('');
}

/* ---------- graph ---------- */
let GF = null;
const AXIS = [3000, 2000, 1000, 0, -1000, -2000, -3000];
function buildGraph() {
  const host = R.graph, W = host.clientWidth, H = host.clientHeight;
  if (W < 60 || H < 50 || !CUR) return;
  const mode = anMode(), lim = mode === 'done' ? N : mode === 'run' ? Math.min(N, RUN.done) : -1;
  const padL = 35, padR = 10, axis = 19, bot = H - axis, y0 = 6, y1 = bot - 5, xl = padL - 5, xr = W - 2;
  const X = (i) => padL + ((W - padL - padR) * i) / N;
  const YV = (v) => y0 + ((y1 - y0) * (3000 - Math.max(-3000, Math.min(3000, v)))) / 6000;
  const Y = (i) => YV(valOf(P[i])), mid = YV(0);
  const hs = (X(1) - X(0)) / 2, f1 = (n) => n.toFixed(1);
  let bands = '', seps = '', labs = '', grid = '';
  if (lim >= 0) PH.forEach((ph, k) => {
    const xa = k ? X(ph.a) - hs : xl, xb = k === PH.length - 1 ? xr : X(ph.b) + hs, lx = (xa + xb) / 2;
    if (k % 2 === 0) bands += `<rect class="g-ph1" x="${f1(xa)}" y="${y0}" width="${f1(xb - xa)}" height="${f1(y1 - y0)}"/>`;
    if (k) seps += `<line class="g-sep" x1="${f1(xa)}" x2="${f1(xa)}" y1="${y0}" y2="${bot + 6}"/>`;
    labs += `<text class="g-ph" data-x="${f1(lx)}" x="${f1(lx)}" y="${H - 5}" text-anchor="middle">${ph.n}</text>`;
  });
  for (const v of AXIS) {
    const y = f1(YV(v));
    grid += `<line class="${v ? 'g-gl' : 'g-g0'}" x1="${xl}" x2="${xr}" y1="${y}" y2="${y}"/>`;
    /* when the plot is short, the ±2000 labels are dropped so the numbers do not touch; the lines stay */
    if ((y1 - y0) / 6 >= 12 || Math.abs(v) !== 2000) grid += `<text class="g-yl" x="${xl - 3}" y="${y}" dy=".35em" text-anchor="end">${v ? sgn(v) : '0'}</text>`;
  }
  let d = '', area = '';
  if (lim >= 1) {
    for (let i = 0; i <= lim; i++) d += (i ? 'L' : 'M') + f1(X(i)) + ' ' + f1(Y(i));
    area = `${d}L${f1(X(lim))} ${f1(mid)}L${f1(X(0))} ${f1(mid)}Z`;
  }
  const lastX = [[-99, -99], [-99, -99]];
  let stems = '', mk = '';
  for (const m of MARKS) {
    if (m.i > lim) continue;
    const lane = m.self ? 0 : 1, x = X(m.i), row = x - lastX[lane][0] >= 13 ? 0 : 1;
    lastX[lane][row] = x;
    const y = lane === 0 ? y0 + 9 + row * 11.5 : y1 - 9 - row * 11.5, cy = Y(m.i);
    if (Math.abs(cy - y) > 9) stems += `<line class="g-stem" x1="${f1(x)}" x2="${f1(x)}" y1="${f1(y)}" y2="${f1(cy)}"/>`;
    mk += `<g class="g-m ${m.kind}" data-i="${m.i}" transform="translate(${f1(x)} ${f1(y)})">${m.kind === 'mate' ? '<rect class="bg" x="-6.5" y="-6.5" width="13" height="13" rx="3.5"/><text y="3.1" text-anchor="middle">詰</text>' : `<circle class="bg" r="6.3"/>${glyph(m.kind, 2.6)}`}</g>`;
  }
  const legend = lim < 0 ? `<text class="g-msg" x="${f1((padL + W - padR) / 2)}" y="${f1(mid - 13)}" text-anchor="middle">解析すると、ここに形勢グラフが出ます</text>`
    : `<circle class="g-av you" cx="${padL + 4}" cy="${y0 + 9}" r="4"/><text class="g-ll" x="${padL + 11}" y="${y0 + 9}" dy=".35em">${YOU()}</text><circle class="g-av opp" cx="${padL + 4}" cy="${f1(y1 - 9)}" r="4"/><text class="g-ll" x="${padL + 11}" y="${f1(y1 - 9)}" dy=".35em">${OPP()}</text>`;
  host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <defs><clipPath id="gu"><rect x="0" y="0" width="${W}" height="${f1(mid)}"/></clipPath><clipPath id="gd"><rect x="0" y="${f1(mid)}" width="${W}" height="${f1(H - mid)}"/></clipPath></defs>
    ${bands}${grid}
    ${area ? `<path class="g-up" d="${area}" clip-path="url(#gu)"/><path class="g-dn" d="${area}" clip-path="url(#gd)"/>` : ''}
    ${seps}${d ? `<path class="g-ln" d="${d}"/>` : ''}${stems}${legend}${labs}
    <line class="g-hov" y1="${y0}" y2="${bot}" visibility="hidden"/>
    <line class="g-cur" y1="${y0 - 3}" y2="${bot + 2}"/>${mk}<circle class="g-dot" r="4.5"/><path class="g-brl" visibility="hidden"/><circle class="g-brd" r="4" visibility="hidden"/>
    <g class="g-hd"><rect x="-15" y="0" width="30" height="16" rx="8"/><text y="11.6" text-anchor="middle"></text></g>
  </svg><div class="g-tip" hidden><b></b><span></span></div>`;
  const q = (s) => host.querySelector(s);
  GF = { W, padL, span: W - padL - padR, X, Y, YV, lim, hy: bot + 2, cur: q('.g-cur'), dot: q('.g-dot'), hd: q('.g-hd'), hov: q('.g-hov'), tip: q('.g-tip'), brl: q('.g-brl'), brd: q('.g-brd') };
  updateGraph();
}
function updateGraph() {
  R.graph.setAttribute('aria-valuenow', S.ply);
  const g = GF;
  if (!g) return;
  const x = g.X(S.ply), f1 = (n) => n.toFixed(1);
  g.cur.setAttribute('x1', f1(x)); g.cur.setAttribute('x2', f1(x));
  g.dot.setAttribute('cx', f1(x)); g.dot.setAttribute('cy', f1(g.Y(S.ply)));
  g.dot.setAttribute('visibility', S.ply <= g.lim ? 'visible' : 'hidden');
  const hx = Math.max(16, Math.min(g.W - 16, x));
  g.hd.setAttribute('transform', `translate(${f1(hx)} ${g.hy})`);
  g.hd.lastChild.textContent = S.ply;
  R.graph.querySelectorAll('.g-ph').forEach((el) => { el.setAttribute('opacity', Math.abs(+el.dataset.x - hx) < 30 ? '0' : '1'); });
  R.graph.querySelectorAll('.g-m').forEach((el) => {
    const on = +el.dataset.i === S.ply && !S.br, t = el.getAttribute('transform').replace(/ scale\([^)]*\)/, '');
    el.setAttribute('transform', on ? t + ' scale(1.3)' : t);
  });
  /* on a branch, a dashed line runs from where it left the game to the branch's evaluation */
  const a = brShown();
  if (a && g.lim >= S.br.base) {
    const x2 = g.X(Math.min(N, S.br.base + S.br.at)), y2 = g.YV(valOf(a));
    g.brl.setAttribute('d', `M${f1(x)} ${f1(g.Y(S.br.base))}L${f1(x2)} ${f1(y2)}`);
    g.brd.setAttribute('cx', f1(x2)); g.brd.setAttribute('cy', f1(y2));
    g.brl.setAttribute('visibility', 'visible'); g.brd.setAttribute('visibility', 'visible');
  } else { g.brl.setAttribute('visibility', 'hidden'); g.brd.setAttribute('visibility', 'hidden'); }
}
function bindGraph() {
  const host = R.graph;
  let drag = false, sx = 0, moved = false;
  const plyAt = (e) => {
    const g = GF; if (!g) return S.ply;
    const r = host.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * g.W;
    return Math.max(0, Math.min(N, Math.round(((x - g.padL) / g.span) * N)));
  };
  const snap = (i) => { for (const d of [0, -1, 1, -2, 2]) if (MARKED.has(i + d) && seen(i + d)) return i + d; return i; };
  const hideHover = () => { const g = GF; if (!g) return; g.hov.setAttribute('visibility', 'hidden'); g.tip.hidden = true; };
  host.addEventListener('pointerdown', (e) => { drag = true; moved = false; sx = e.clientX; try { host.setPointerCapture(e.pointerId); } catch (_) {} hideHover(); setPly(snap(plyAt(e))); });
  host.addEventListener('pointermove', (e) => {
    if (drag) { if (moved || Math.abs(e.clientX - sx) > 4) { moved = true; setPly(plyAt(e)); } return; }
    const g = GF; if (!g || e.pointerType !== 'mouse') return;
    const i = plyAt(e), x = g.X(i);
    g.hov.setAttribute('x1', x); g.hov.setAttribute('x2', x); g.hov.setAttribute('visibility', 'visible');
    g.tip.firstChild.textContent = seen(i) ? fmtVal(P[i]) : '';
    g.tip.lastChild.textContent = plyLabel(i) + (i ? ' ' + han(P[i].move.ja) : '');
    g.tip.style.left = Math.max(60, Math.min(g.W - 60, x)) + 'px';
    g.tip.hidden = false;
  });
  const end = () => { drag = false; };
  host.addEventListener('pointerup', end);
  host.addEventListener('pointercancel', end);
  host.addEventListener('pointerleave', hideHover);
}

/* ---------- panels ---------- */
const EVQ = '<button type="button" class="rq" data-a="evalhelp">評価値</button>';
function readoutHTML() {
  const p = S.ply, mode = anMode(), e = brNow();
  if (e) {
    const n = S.br.at, q = S.br.base + n, a = brShown(), rs = rtState();
    let h = `<span class="bk">分岐 ${n}手目</span>`;
    if (rtBusy()) return h + '<span>解析中…</span>';
    if (!a) return h + `<span>${rs === 'on' ? '評価値 —' : rs === 'offline' ? '通信できないため、評価値は出ません' : rs === 'limit' ? '今月の分岐中の解析は残り0分' : rs === 'off' ? '分岐中の解析はオフ' : '評価値は出ません'}</span>`;
    h += `${EVQ}<b>${fmtVal(a)}</b>`;
    if (q <= N && mode === 'done') h += `<span>本譜の${q}手目は</span><b>${fmtVal(P[q])}</b>`;
    else if (rs !== 'on') h += '<span>保存した読み筋</span>';
    return h;
  }
  if (!seen(p)) return `${EVQ}<b>—</b><span>${mode !== 'run' ? (waiting() ? '順番が来たら解析します' : 'まだ解析していません') : RUN.paused ? '通信が戻ると、続きから再開します' : 'アプリを閉じても解析は続きます'}</span>`;
  const pos = P[p];
  if (!p) return `<span>開始局面</span><b>${fmtVal(pos)}</b>`;
  if (p === N) return `<span>終局</span><b>${N}手で${resultText()}</b><span>${endNote()}</span>`;
  const prev = P[p - 1], plain = (o) => !o.end && o.mate == null;
  const v0 = fmtVal(prev), v1 = fmtVal(pos);
  let h = `${EVQ}<b>${v0 === v1 && v1.endsWith('以上') ? v1 : `${v0} → ${v1}`}</b>`;
  if (plain(prev) && plain(pos)) { const d = valOf(pos) - valOf(prev); h += `<span class="dl${d > 0 ? ' up' : d < 0 ? ' dn' : ''}">${sgn(d)}</span>`; }
  if (mode !== 'done') return h;
  if (pos.missedTsume && prev.tsume) h += `<button type="button" class="rl" data-a="jump" data-v="${p - 1}">${pos.missedTsume}手詰めあり ›</button>`;
  else if (pos.mark === '好手') h += '<span class="rn">好手！</span>';
  else if (pos.mark) {
    const best = (prev.cands || [])[0];
    if (best && best.usi !== pos.move.usi) h += `<button type="button" class="rl" data-a="jump" data-v="${p - 1}">${OWN && moverSide(p) === SELF ? 'おすすめは' : '最善は'} ${mv(best.ja)} ›</button>`;
  }
  return h;
}
/* how the game ended, as the record says; dropped when the result was corrected to a draw or to unknown */
const endNote = () => (winnerSide() ? `（${esc(M.endReason)}）` : '');
const aiBtn = () => '<button type="button" class="aib" data-a="ai"><svg class="ic"><use href="#i-spark"/></svg>AIに聞く<svg class="ic lki"><use href="#i-lock"/></svg></button>';
const tryBtn = (label, aria) => `<button type="button" class="try" data-a="playline" aria-label="${aria}"><svg class="ic"><use href="#i-play"/></svg>${label}</button>`;
const pie = (o) => { const w = pct(wrSelf(o)); return `<span class="w" style="background:conic-gradient(var(--you) 0 ${w}%, var(--opp) 0)"><b>${w}%</b><span>勝率</span></span>`; };
const say = (m, p, btn) => `<div class="bc say"><span class="m">${m}</span><span class="pw"><span class="p">${p}</span></span>${btn || ''}</div>`;
function todoCard() {
  const kind = paid() ? S.kind : 'std';
  let h = '<div class="tbs">';
  if (paid()) h += `<button type="button" class="tbx${kind === 'pre' ? ' on' : ''}" data-a="kind" data-v="pre">精密解析</button><button type="button" class="tbx${kind === 'std' ? ' on' : ''}" data-a="kind" data-v="std">ふつう</button>`;
  else h += '<span class="tbx on">解析</span><button type="button" class="tbx lkt" data-a="lockinfo" data-v="precise"><svg class="ic"><use href="#i-lock"/></svg>精密</button>';
  h += aiBtn() + '</div>';
  if (waiting()) return h + say('解析待ち', 'いまの解析が終わると、続けて始まります', '<button type="button" class="bt sm x" data-a="unqueue">やめる</button>');
  if (CUR.err) return h + say('解析を終えられませんでした', '回数は減っていません。もう一度試せます', '<button type="button" class="bt pri sm x" data-a="analyze">もう一度</button>');
  if (!paid() && !freeLeft()) return h + say('今週の解析は残り0局', `${WEEK}に、また${DB.usage.freeMax}局使えます`, '<button type="button" class="bt pri sm x" data-a="nav" data-v="plan">プランを見る</button>');
  if (paid() && !totalLeft()) return h + say('今週の解析は残り0局', `${WEEK}に、また${DB.usage.totalMax}局使えます`);
  if (paid() && kind === 'pre' && !preciseLeft()) return h + say('今週の精密解析は残り0局', 'ふつうの解析（候補1手）は使えます', '<button type="button" class="bt pri sm x" data-a="analyzestd">ふつうで解析</button>');
  const sub = !DB.online ? '通信できません。つながると解析できます' : !paid() ? `今週の解析　あと${freeLeft()}局` : kind === 'pre' ? `候補3手とAIコーチ　今週あと${preciseLeft()}局` : `候補1手・AIコーチなし　今週あと${totalLeft()}局`;
  return h + say('この対局を解析する', sub, '<button type="button" class="bt pri sm x" data-a="analyze">解析する</button>');
}
function runCard() {
  const pz = RUN.paused;
  return `<div class="tbs"><span class="tbx on">${RUN.kind === 'pre' ? '精密解析' : '解析'}</span>${aiBtn()}</div><div class="bc say"><span class="m">${pz ? '中断中' : '解析中'}${pz ? '<small>通信が戻ると、続きから再開します</small>' : `<small data-run="n">${RUN.done} / ${RUN.total}手</small>`}</span><span class="pgs${pz ? ' pz' : ''}"><i data-run="bar" style="width:${(100 * RUN.done / RUN.total).toFixed(1)}%"></i></span><button type="button" class="bt sm x" data-a="stopan">中止</button></div>`;
}
function branchCard() {
  const e = brNow(), rs = rtState(), a = brShown();
  const top = !OWN ? '最善' : e.turn === SELF ? 'おすすめ' : '相手の最善';
  let h = `<div class="tbs"><span class="tbx on">${a && a.next ? top : '分岐'}</span>`;
  if (rs === 'free') h += '<button type="button" class="tbx lkt" data-a="lockinfo" data-v="rt"><svg class="ic"><use href="#i-lock"/></svg>分岐中の解析</button>';
  h += aiBtn() + '</div>';
  if (rtBusy()) return h + say(`${S.rtWarm ? '解析中' : '準備中'}<span class="dots"><i></i><i></i><i></i></span>`, S.rtWarm ? 'この局面の評価値と最善手を調べています' : '解析の準備をしています');
  if (a && a.next) return h + `<div class="bc"><span class="m">${mv(a.next.ja)}</span><span class="pw"><span class="p">${a.pv.map(mv).join(' ') || '　'}</span>${tryBtn('次の手', 'この読み筋を1手進める')}</span>${pie(a)}</div>`;
  if (a) return h + `<div class="bc say"><span class="m">読み筋はここまで</span><span class="pw"><span class="p">${rs === 'free' ? 'この先は、分岐中の解析で調べられます' : rs === 'on' ? 'モック：この先の解析データはありません' : 'この先は、分岐中の解析で調べられます'}</span></span>${pie(a)}</div>`;
  if (rs === 'free') return h + say('自由に指して試せます', 'この先の評価値は、分岐中の解析で出ます');
  if (rs === 'off') return h + say('分岐中の解析はオフ', '駒は自由に動かせます。時間は使いません', '<button type="button" class="bt pri sm x" data-a="rttoggle">オンにする</button>');
  if (rs === 'offline') return h + say('通信できません', 'つながると、評価値と最善手が出ます');
  if (rs === 'limit') return h + say('今月の分岐中の解析は残り0分', '月が変わると、また300分使えます');
  return h + say('解析データなし', 'モック：候補の手順に沿った局面だけ値が出ます');
}
function candsHTML() {
  const p = S.ply, mode = anMode();
  if (S.br) return branchCard();
  if (mode === 'none') return todoCard();
  if (mode === 'run') return runCard();
  const rows = rowsFor(p), t = P[p].tsume;
  if (S.sel >= rows.length) S.sel = 0;
  const isT = (x) => !!t && x.rank === 0 && t.line[0].usi === x.c.usi;
  let h = '<div class="tbs">';
  /* the first tab says whose move it is about: your recommended move, or the opponent's best reply */
  const top = !OWN ? '最善' : turnSide(p) === SELF ? 'おすすめ' : '相手の最善';
  rows.forEach((x, i) => { h += `<button type="button" class="tbx${i === S.sel ? ' on' : ''}" data-a="cand" data-v="${i}">${x.rank === 0 ? (isT(x) ? '詰み' : top) : x.rank > 0 ? x.rank + 1 + '位' : '本譜'}</button>`; });
  if (lockedCount(p)) h += `<button type="button" class="tbx lkt" data-a="more23"><svg class="ic"><use href="#${paid() ? 'i-refresh' : 'i-lock'}"/></svg>2位・3位</button>`;
  h += aiBtn() + '</div>';
  const r = rows[S.sel];
  if (r) {
    const pv = isT(r) ? t.line.slice(1).map((m) => mv(m.ja)).join(' ') : r.pv.map((m) => mv(m)).join(' ');
    h += `<div class="bc"><span class="m">${mv(r.ja)}${isT(r) ? `<em class="mk mk-good">${t.len}手詰め</em>` : ''}${r.game && r.rank >= 0 ? '<u>本譜</u>' : ''}${r.mk}</span><span class="pw"><span class="p">${pv || '　'}</span>${r.game ? tryBtn('次の手', '本譜を1手進める') : tryBtn('試す', 'この手を盤で試す')}</span>${pie(r.o)}</div>`;
  } else {
    h += `<div class="bc"><span class="m">${resultText()}${winnerSide() === SELF && OWN ? '！' : ''}</span><span class="pw"><span class="p">${N}手で終局${endNote()}</span></span></div>`;
  }
  return h;
}
function movesHTML() {
  let h = '<div class="ml">';
  for (let i = 0; i <= N; i++) {
    const p = P[i];
    h += `<button type="button" class="mr" data-a="ply" data-v="${i}"><span class="mn">${i || ''}</span><span class="mm">${i ? mv(p.move.ja) : '開始局面'}</span><span>${marksOf(p)}</span><span class="me2">${seen(i) ? fmtVal(p) : ''}</span></button>`;
  }
  return h + '</div>';
}
function branchMovesHTML() {
  const b = S.br;
  let h = `<div class="mrh"><span>${plyLabel(b.base)}から分かれた手順です。本譜と戦績は変わりません。</span><button type="button" class="bt sm" data-a="exitbr">本譜に戻る</button></div><div class="ml">`;
  b.line.forEach((e, i) => { h += `<button type="button" class="mr${i + 1 === b.at ? ' cur' : ''}" data-a="brat" data-v="${i + 1}"><span class="mn">${i + 1}</span><span class="mm">${mv(e.mv.ja)}</span><span></span><span class="me2">${paid() && e.an.known ? fmtVal(e.an) : ''}</span></button>`; });
  return h + '</div>';
}

/* ---------- rendering ---------- */
function ensureVisible(box, row) {
  if (!box || !row || !box.clientHeight || !row.offsetParent) return;
  const b = box.getBoundingClientRect(), r = row.getBoundingClientRect();
  if (r.top < b.top + 4) box.scrollTop += r.top - b.top - 40;
  else if (r.bottom > b.bottom - 4) box.scrollTop += r.bottom - b.bottom + 40;
}
function markCurrent() {
  if (UI.sheet !== 'kf' || S.br) return;
  const ml = R.shc.querySelector('.ml');
  if (!ml) return;
  const old = ml.querySelector('.mr.cur'), row = ml.children[S.ply];
  if (old) old.classList.remove('cur');
  if (row) { row.classList.add('cur'); ensureVisible(R.shc, row); }
}
function renderBoard() {
  const v = view();
  R.board.innerHTML = boardSVG() + promoHTML();
  for (const [el, side] of [[R.youhand, SELF], [R.opphand, OTHER]]) {
    const html = trayHTML(v.pos.hands[side], side);
    el.classList.toggle('none', !html);
    el.innerHTML = html || '<i class="t0">なし</i>';
  }
}
function renderCands() { R.cands.innerHTML = candsHTML(); renderBoard(); }
function renderBar() {
  const e = brNow(), atEnd = !e && S.ply === N;
  const o = e ? brShown() : atEnd ? null : seen(S.ply) ? P[S.ply] : null;
  R.barb.classList.toggle('na', !o && !(atEnd && winnerSide()));
  if (atEnd && winnerSide()) {
    R.bary.style.width = winnerSide() === SELF ? '100%' : '0%';
    R.youp.textContent = R.oppp.textContent = '';
    R.bar.setAttribute('aria-label', resultText());
  } else if (o) {
    const w = pct(wrSelf(o));
    R.bary.style.width = Math.max(4, Math.min(96, w)) + '%';
    R.oppp.textContent = 100 - w + '%';
    R.youp.textContent = w + '%';
    R.bar.setAttribute('aria-label', `${YOU()}の勝率 ${w}%`);
  } else {
    R.youp.textContent = R.oppp.textContent = '';
    R.bar.setAttribute('aria-label', '形勢はまだ分かりません');
  }
  let who = 'even', text;
  if (atEnd) { const w = winnerSide(); who = !w ? 'even' : w === SELF ? 'you' : 'opp'; text = resultText(); }
  else if (o) { const j = judge(o); who = j.lv ? (j.side === SELF ? 'you' : 'opp') : 'even'; text = who === 'even' ? 'ほぼ互角' : (who === 'you' ? YOU() : OPP()) + 'が' + JN[j.lv]; }
  else text = e ? (rtBusy() ? '解析中' : '分岐中') : anMode() !== 'run' ? (waiting() ? '解析待ち' : '未解析') : RUN.paused ? '中断中' : '解析中';
  R.jg.dataset.who = who;
  R.jg.textContent = text;
}
function renderNow() {
  const e = brNow();
  R.now.classList.toggle('br', !!e);
  if (e) {
    R.plyno.textContent = `分岐${S.br.at}手目`;
    R.move.textContent = han(e.mv.ja);
    R.mark.innerHTML = '';
  } else {
    const pos = P[S.ply];
    R.plyno.textContent = plyLabel(S.ply);
    R.move.textContent = pos.move ? han(pos.move.ja) : '';
    R.mark.innerHTML = marksOf(pos);
  }
  /* on a branch, the first button takes you back to the game */
  R.bfirst.classList.toggle('warn', !!e);
  R.bfirst.setAttribute('aria-label', e ? '本譜に戻る' : '最初へ');
  R.bfirst.innerHTML = `<svg class="ic"><use href="#${e ? 'i-undo' : 'i-first'}"/></svg>`;
  R.brl1.hidden = R.brl2.hidden = !e;
  if (e) {
    const rs = rtState();
    R.brl1.innerHTML = '<svg class="ic"><use href="#i-bolt"/></svg>' + (rs === 'on' ? `分岐中の解析 <b>オン</b>${rtLow() ? `・残り${rtLeft()}分` : ''}` : rs === 'off' ? '分岐中の解析 <b>オフ</b>' : rs === 'offline' ? '分岐中の解析 <b>通信なし</b>' : rs === 'limit' ? '分岐中の解析 <b>残り0分</b>' : '分岐中の解析 <svg class="ic"><use href="#i-lock"/></svg>');
    R.brl2.innerHTML = `<svg class="ic"><use href="#i-undo"/></svg>本譜（${plyLabel(S.br.base)}）に戻る`;
  }
}
function renderPly() {
  SCR.dataset.turn = gameOver() ? '-' : view().turn;
  renderNow();
  R.ro.innerHTML = readoutHTML();
  renderCands();
  updateGraph();
  renderBar();
  markCurrent();
}
function renderGame() { renderPly(); buildGraph(); }
function clearSel() { S.pick = null; S.targets = []; S.promo = null; }
function clearPick() { if (S.pick || S.promo) { clearSel(); renderBoard(); } }
/* Going somewhere else on the game line leaves the branch. A branch is not saved, so when that happens
   by a tap on the graph, the move list or a move in the coach's text, a way back is offered. */
function setPly(p) {
  p = Math.max(0, Math.min(N, p));
  if (!S.br && p === S.ply) return;
  const left = S.br;
  S.br = null; S.ply = p; S.sel = 0; CUR.ply = p;
  clearSel();
  renderPly();
  if (left && left.line.length > 1) {
    S.lastBr = left;
    toast('本譜に戻りました', { label: '分岐に戻る', fn: () => { if (S.lastBr === left && CUR) { S.ply = left.base; S.br = left; clearSel(); renderPly(); } } });
  }
}
function exitBranch() {
  if (!S.br) return;
  S.ply = S.br.base; S.br = null; S.sel = 0;
  stopRt();
  clearSel();
  renderPly();
}

/* ---------- trying moves ---------- */
/* Lines whose evaluation the mock knows from the saved analysis: the candidates' reading lines and
   proven mates. The real app would ask the engine for any position; here only these can be answered. */
function knownLines() {
  const e = brNow();
  if (e) return e.an.lines;
  if (anMode() !== 'done') return [];
  const p = P[S.ply];
  const out = (p.cands || []).map((c) => ({ cp: c.cp, mate: c.mate, _pv: c._pv, usis: c.pvUsi || [c.usi], jas: c.pv || [c.ja] }));
  if (p.tsume) out.unshift({ cp: p.cp, mate: p.mate, _pv: true, usis: p.tsume.line.map((x) => x.usi), jas: p.tsume.line.map((x) => x.ja) });
  return out;
}
function analysisAfter(lines, usi) {
  const hit = lines.filter((l) => l.usis[0] === usi).map((l) => ({ cp: l.cp, mate: l.mate, _pv: l._pv, usis: l.usis.slice(1), jas: l.jas.slice(1) }));
  if (!hit.length) return { known: false, lines: [] };
  const rest = hit.filter((l) => l.usis.length), nx = rest[0] || null;
  return { known: true, cp: hit[0].cp, mate: hit[0].mate, _pv: hit[0]._pv, lines: rest, next: nx ? moveOfUsi(nx.usis[0], nx.jas[0]) : null, pv: nx ? nx.jas.slice(1) : [] };
}
function commitMove(m) {
  const v = view(), side = v.turn;
  clearSel();
  if (!S.br && S.ply < N && P[S.ply + 1].move.usi === m.usi) { setPly(S.ply + 1); return; }
  const lines = knownLines(), hit = lines.find((l) => l.usis[0] === m.usi);
  const ja = hit ? hit.jas[0] : jaOf(v.pos, side, m, v.last ? v.last.to : null);
  const first = !S.br;
  if (first) S.br = { base: S.ply, line: [], at: 0 };
  S.br.line.length = S.br.at;
  S.br.line.push({ mv: moveOfUsi(m.usi, ja), pos: applyMove(v.pos, m, side), turn: flip(side), an: analysisAfter(lines, m.usi) });
  S.br.at++;
  if (rtState() === 'on') {
    /* the first move after a pause waits for the analysis to start up; later moves answer quickly */
    const wait = S.rtWarm ? 650 : 1500;
    S.rtUntil = performance.now() + wait;
    clearTimeout(rtTimer); clearTimeout(rtIdle);
    rtTimer = setTimeout(() => { S.rtWarm = true; if (S.br && topNav() && topNav().t === 'game') renderPly(); }, wait + 20);
    /* nothing moved for a while: the analysis goes to sleep (the minutes stop), and the next move wakes it */
    rtIdle = setTimeout(() => { S.rtWarm = false; }, wait + 30000);
  }
  renderPly();
  if (rtState() === 'on' && rtLow() && !S.told.rtlow) { S.told.rtlow = true; toast(`分岐中の解析は、今月あと${rtLeft()}分使えます`); }
  else if (first && !S.told.br) { S.told.br = true; toast('分岐は保存されません。本譜や戦績は変わりません'); }
}
function tryMove(pk, f, r) {
  const v = view(), g = gridOf(v.pos), to = toSq(f, r);
  clearSel();
  if (pk.hand) { commitMove(moveOfUsi(pk.hand + '*' + to)); return; }
  const c = g[pk.r - 1][pk.f - 1], from = toSq(pk.f, pk.r);
  if (canPromote(c, pk.r, r)) {
    if (mustPromote(c, r)) { commitMove(moveOfUsi(from + to + '+')); return; }
    S.promo = { from, to, f, r, k: c.k };
    renderBoard();
    return;
  }
  commitMove(moveOfUsi(from + to));
}
R.board.addEventListener('click', (e) => {
  if (e.target.closest('.prm')) return;
  const svg = R.board.querySelector('svg');
  if (!svg) return;
  if (S.promo) { clearPick(); return; }
  if (gameOver()) return;
  const b = svg.getBoundingClientRect();
  const vx = ((e.clientX - b.left) / b.width) * VBW + VBX, vy = ((e.clientY - b.top) / b.height) * VBH + VBY;
  const cx = Math.floor((vx - OX) / CW), cy = Math.floor((vy - OY) / CH);
  const f = FLIP ? cx + 1 : 9 - cx, r = FLIP ? 9 - cy : cy + 1;
  if (cx < 0 || cx > 8 || cy < 0 || cy > 8) { clearPick(); return; }
  if (S.pick && S.targets.some(([a, c]) => a === f && c === r)) { tryMove(S.pick, f, r); return; }
  const v = view(), c = gridOf(v.pos)[r - 1][f - 1];
  if (!c) { clearPick(); return; }
  if (c.side !== v.turn) { clearPick(); toast(`いまは${OWN ? (v.turn === SELF ? 'あなた' : '相手') : sideName(v.turn)}の番です`); return; }
  if (S.pick && S.pick.f === f && S.pick.r === r) { clearPick(); return; }
  S.pick = { f, r };
  S.targets = legalFrom(gridOf(v.pos), f, r);
  renderBoard();
});
A.hand = (k, el) => {
  if (gameOver()) return;
  const v = view();
  S.promo = null;
  if (el.dataset.side !== v.turn) { toast(`いまは${OWN ? (v.turn === SELF ? 'あなた' : '相手') : sideName(v.turn)}の番です`); return; }
  if (S.pick && S.pick.hand === k) { clearPick(); return; }
  S.pick = { hand: k };
  S.targets = legalDrops(gridOf(v.pos), k, v.turn);
  renderBoard();
};
A.promo = (v) => { const pr = S.promo; if (!pr) return; S.promo = null; commitMove(moveOfUsi(pr.from + pr.to + (v === '1' ? '+' : ''))); };
A.playline = () => {
  if (S.br) { const a = brShown(); if (a && a.next) commitMove(a.next); return; }
  const r = rowsFor(S.ply)[S.sel];
  if (r) commitMove(moveOfUsi(r.c.usi, r.c.ja));
};
A.step = (v) => {
  const b = S.br;
  if (!b) { setPly(v === 'first' ? 0 : v === 'last' ? N : S.ply + (v === 'next' ? 1 : -1)); return; }
  if (v === 'first' || (v === 'prev' && b.at <= 1)) { exitBranch(); return; }
  if (v === 'prev') b.at--;
  else if (b.at >= b.line.length) return;
  else b.at = v === 'last' ? b.line.length : b.at + 1;
  clearSel(); S.rtUntil = 0;
  renderPly();
};
A.cand = (v) => { S.sel = +v; clearSel(); renderCands(); };
A.ply = (v) => setPly(+v);
A.jump = (v) => { closeSheet(); if (AI.open && AI.full) setAIFull(false); setPly(+v); };
A.toast = (v) => toast(v);
A.brat = (v) => { S.br.at = +v; closeSheet(); clearSel(); S.rtUntil = 0; renderPly(); };
A.exitbr = () => { closeSheet(); exitBranch(); };
A.kf = () => { const d = dparts(CUR.date); openSheet(S.br ? '分岐の手順' : `棋譜（${d.m}/${d.d}・${N}手）`, S.br ? branchMovesHTML() : movesHTML(), { id: 'kf' }); markCurrent(); };
A.kind = (v) => { S.kind = v; renderCands(); };
/* every lock explains what it is and offers the plan page, the same way */
const LOCKS = () => ({
  cands: ['2位・3位の候補は、精密解析で出ます', `精密解析（有料プラン）では、候補を3手まで比べられ、AIコーチも使えます。週${DB.usage.preciseMax}局まで使えます。`],
  precise: ['精密解析は、有料プランで使えます', `候補を3手まで出し、より深く読みます。AIコーチも、精密解析した対局で使えます。週${DB.usage.preciseMax}局まで使えます。`],
  rt: ['分岐中の解析は、有料プランで使えます', '分岐で指すたびに、その局面の評価値と最善手が出ます。'],
});
A.lockinfo = (k) => { const x = LOCKS()[k]; ask(x[0], x[1], '有料プランを見る', () => push({ t: 'plan' }), { no: '閉じる' }); };
const preciseCost = () => `精密解析を1局分使います（今週あと${preciseLeft()}局）。`;
/* a record that already has an ordinary analysis is done again as a precise one */
function redoPrecise(after) {
  if (!preciseLeft()) { limitDialog(CUR); return; }
  ask('精密解析でやり直しますか', `${preciseCost()}候補が3手まで出て、AIコーチも使えるようになります。いまの解析結果は、新しい結果に置きかわります。`, '精密解析する', () => { startAnalysis(CUR, 'pre'); if (after) after(); });
}
A.more23 = () => {
  if (!paid()) { A.lockinfo('cands'); return; }
  redoPrecise();
};
A.rttoggle = () => {
  if (!paid()) { A.lockinfo('rt'); return; }
  S.rtOn = !S.rtOn; S.rtUntil = 0; S.rtWarm = false;
  renderPly();
  stopRt();
  toast(S.rtOn ? '分岐中の解析をオンにしました。次に指した手から評価値が出ます' : '分岐中の解析をオフにしました');
};
A.evalhelp = () => {
  const mark = (k, t, d) => `<div class="evm">${onbMark(k)}<div><b>${t}</b><span>${d}</span></div></div>`;
  openSheet('評価値と印の見かた', `<div class="evh"><p>評価値は、解析が出した形勢の点数です。<b>プラスは${YOU()}が有利</b>、マイナスは${OPP()}が有利です。</p><div class="evs"><span><b>±150</b>くらいまで<i>ほぼ互角</i></span><span><b>500</b>前後<i>有利</i></span><span><b>1000</b>以上<i>大きな差</i></span></div><p>上の「${YOU()} ○%」は、評価値から見積もった勝つ見込みです。戦績の勝率とは別のものです。</p></div>${mark('good', '好手', '解析のおすすめと同じ手で、ほかの手より良かった手')}${mark('dub', '疑問手', '評価値を少し下げた手')}${mark('bad', '悪手', '評価値を大きく下げた手')}${mark('mate', '詰みあり', '1手か3手で詰む手があった局面')}<p class="hint">3000を超える大きな差は、「3000以上」と表します。</p>`, { auto: true });
};

/* ---------- analysis run (simulated: the real one runs on the server and takes about 1 to 3 minutes) ---------- */
function limitDialog(gm) {
  const u = DB.usage, when = `${WEEK}（日本時間）`;
  if (!paid()) ask('今週の無料解析は使い切りました', `${when}に、また${u.freeMax}局使えます。有料プランでは、精密解析を週${u.preciseMax}局、ふつうの解析と合わせて週${u.totalMax}局使えます。`, '有料プランを見る', () => push({ t: 'plan' }), { img: 'sys-limit', no: '閉じる' });
  else if (!totalLeft()) ask('今週の解析は使い切りました', `${when}に、また使えます（精密解析 ${u.preciseMax}局、ふつうの解析と合わせて ${u.totalMax}局）。`, 'OK', null, { single: true, img: 'sys-limit' });
  else if (gm.an !== 'none') ask('今週の精密解析は使い切りました', `${when}に、また${u.preciseMax}局使えます。`, 'OK', null, { single: true, img: 'sys-limit' });
  else ask('今週の精密解析は使い切りました', `${when}に、また${u.preciseMax}局使えます。ふつうの解析（候補1手）は、このまま使えます（今週あと${totalLeft()}局）。`, 'ふつうで解析する', () => startAnalysis(gm, 'std'), { img: 'sys-limit', no: '閉じる' });
}
function refreshWaiting(gm) {
  if (onGame(gm)) renderPly();
  else if (!topNav()) show();
}
function startAnalysis(gm, kind) {
  if (RUN && RUN.id === gm.id) { toast('この対局は解析中です'); return; }
  if (!canRun(kind)) { limitDialog(gm); return; }
  if (RUN) {
    /* one analysis runs at a time; the rest wait their turn */
    if (!QUEUE.some((q) => q.id === gm.id)) QUEUE.push({ id: gm.id, kind });
    refreshWaiting(gm);
    toast('いまの解析が終わったら、続けて解析します');
    return;
  }
  if (!needNet(() => startAnalysis(gm, kind))) return;
  gm.err = false;
  RUN = { id: gm.id, done: 0, total: gm.plies, kind, paused: false };
  RUN.timer = setInterval(tickRun, 70);
  if (onGame(gm)) { S.br = null; clearSel(); renderGame(); }
  else if (!topNav()) show();   /* the list card changes from waiting to running */
}
function nextInQueue() {
  while (QUEUE.length && !RUN) {
    const q = QUEUE.shift(), gm = gameById(q.id);
    if (gm) startAnalysis(gm, q.kind);
  }
}
/* the connection dropped or came back while an analysis was running */
function setPaused(on) {
  const r = RUN, gm = gameById(r.id);
  r.paused = on;
  if (gm && onGame(gm)) renderPly();
  const pill = SCR.querySelector('[data-runpill]');
  if (pill) pill.textContent = `${on ? '中断中' : '解析中'} ${r.done}/${r.total}`;
  if (!on) toast('通信が戻りました。解析を続きから再開します');
}
function endRun(failed) {
  const r = RUN, gm = gameById(r.id);
  clearInterval(r.timer);
  RUN = null;
  if (gm && failed) gm.err = true;
  if (gm && onGame(gm)) renderGame(); else if (!topNav()) show();
  nextInQueue();
}
function tickRun() {
  const r = RUN, gm = gameById(r.id), on = !!gm && onGame(gm), before = on && seen(S.ply);
  if (!DB.online) { if (!r.paused) setPaused(true); return; }
  if (r.paused) setPaused(false);
  if (r.failAt && r.done >= r.failAt) {
    endRun(true);
    /* on the game itself the card already says so */
    if (!on && gm) toast(`${gm.self ? oppName(gm) + ' 戦' : gm.date + ' の対局'}の解析を終えられませんでした`, { label: '開く', fn: () => { if (gameById(gm.id)) push({ t: 'game', id: gm.id }); } });
    return;
  }
  r.done = Math.min(r.total, r.done + (r.kind === 'pre' ? (r.done < 24 ? 2 : 1) : 4));
  if (!gm || r.done >= r.total) { finishRun(); return; }
  if (on) {
    const n = R.cands.querySelector('[data-run="n"]'), b = R.cands.querySelector('[data-run="bar"]');
    if (n) n.textContent = `${r.done} / ${r.total}手`;
    if (b) b.style.width = (100 * r.done / r.total).toFixed(1) + '%';
    if (before !== seen(S.ply)) renderPly();
    buildGraph();
  }
  const pill = SCR.querySelector('[data-runpill]');
  if (pill) pill.textContent = `解析中 ${r.done}/${r.total}`;
}
function finishRun() {
  const r = RUN, gm = gameById(r.id);
  clearInterval(r.timer);
  RUN = null;
  if (!gm) return;
  gm.an = r.kind;
  if (!paid()) DB.usage.free++;
  else { DB.usage.total++; if (r.kind === 'pre') DB.usage.precise++; }
  if (onGame(gm)) {
    renderGame();
    if (AI.open) renderAI();
    if (DB.celebrated) toast('解析が終わりました');
    else {
      DB.celebrated = true;
      ask('はじめての解析ができました', 'グラフの印をタップすると、その手に移れます。盤の駒を動かせば、別の手も試せます。まずは、形勢が大きく動いた手を見てみましょう。', '見てみる', () => { if (CUR === gm) setPly(startPly()); }, { single: true, img: 'learn-first' });
    }
  }
  else {
    if (!topNav() || topNav().t !== 'game') show();
    toast(`${gm.self ? oppName(gm) + ' 戦' : gm.date + ' の対局'}の解析が終わりました`, { label: '開く', fn: () => { if (gameById(gm.id)) push({ t: 'game', id: gm.id }); } });
  }
  nextInQueue();
}
A.analyze = () => startAnalysis(CUR, paid() ? S.kind : 'std');
A.analyzestd = () => startAnalysis(CUR, 'std');
A.stopan = () => {
  if (!RUN) return;
  ask('解析を中止しますか', 'ここまでの結果は残りません。中止した解析は、回数に数えません。', '中止する', () => { if (RUN) { endRun(false); toast('解析を中止しました'); } }, { no: '続ける' });
};
A.unqueue = () => {
  const i = QUEUE.findIndex((q) => q.id === CUR.id);
  if (i >= 0) QUEUE.splice(i, 1);
  renderPly();
  toast('解析待ちをやめました');
};

/* ---------- the record's menu ---------- */
A.gmenu = () => {
  const g = CUR, busy = (RUN && RUN.id === g.id) || waiting();
  const row = (a, icon, label, sub, cls) => `<button type="button" class="mn2" data-a="${a}"><span class="mi${cls || ''}"><svg class="ic"><use href="#${icon}"/></svg></span><span>${label}${sub ? `<small>${sub}</small>` : ''}</span></button>`;
  let h = row('gfav', 'i-star', g.fav ? 'お気に入りから外す' : 'お気に入りに入れる', '', g.fav ? ' on' : '');
  h += row('ginfo', 'i-info', '対局情報', '対局者・結果・戦法と囲い（修正もここから）');
  if (g.an === 'std' && !busy) h += row('reanalyze', 'i-refresh', '精密解析でやり直す', paid() ? `候補3手とAIコーチ（今週あと${preciseLeft()}局）` : '有料プランの機能です');
  if (!g.self) h += row('gflip', 'i-refresh', '盤の向きを変える', `いまは${SELF === 's' ? '先手' : '後手'}の側から見ています`);
  h += row('kifout', 'i-export', 'KIFを書き出す', 'コピー・ファイルに保存・共有');
  h += row('gdel', 'i-trash', 'この棋譜を削除', '', ' dng');
  openSheet('この対局', h, { auto: true });
};
A.gflip = () => { const g = CUR, p = S.ply; closeSheet(); g.view = SELF === 's' ? 'g' : 's'; loadGame(g); S.ply = p; renderGame(); };
A.gfav = () => { CUR.fav = !CUR.fav; closeSheet(); toast(CUR.fav ? 'お気に入りに入れました' : 'お気に入りから外しました'); };
A.ginfo = () => { closeSheet(); push({ t: 'info', id: CUR.id }); };
A.reanalyze = () => {
  closeSheet();
  if (!paid()) { A.lockinfo('precise'); return; }
  redoPrecise();
};
A.kifout = () => {
  openSheet('KIFを書き出す', `<textarea class="kifx" id="kifx" readonly spellcheck="false">${esc(kifText(G))}</textarea><div class="acts"><button type="button" class="bt pri wide" data-a="copykif"><svg class="ic"><use href="#i-copy"/></svg>コピーする</button><div class="two"><button type="button" class="bt" data-a="toast" data-v="ファイルの保存先を選ぶ画面が開きます（モック）"><svg class="ic"><use href="#i-file"/></svg>ファイルに保存</button><button type="button" class="bt" data-a="toast" data-v="共有先を選ぶ画面が開きます（モック）"><svg class="ic"><use href="#i-export"/></svg>共有</button></div></div>`, { auto: true });
};
A.copykif = () => {
  const ta = document.getElementById('kifx');
  const fallback = () => { ta.focus(); ta.select(); toast('全体を選びました。コピーしてください'); };
  try { navigator.clipboard.writeText(ta.value).then(() => toast('コピーしました'), fallback); } catch (_) { fallback(); }
};
A.gdel = () => {
  closeSheet();
  ask('この棋譜を削除しますか', '解析結果と、AIコーチの解説・質問の履歴もいっしょに消えます。戦績からも外れます。元には戻せません。使った解析の回数は戻りません。', '削除する', () => {
    const g = CUR;
    const qi = QUEUE.findIndex((q) => q.id === g.id);
    if (qi >= 0) QUEUE.splice(qi, 1);
    if (RUN && RUN.id === g.id) { clearInterval(RUN.timer); RUN = null; }
    DB.games.splice(DB.games.indexOf(g), 1);
    CUR = null;
    for (let i = NAV.length - 1; i >= 0; i--) if (NAV[i].id === g.id) NAV.splice(i, 1);
    show(false, true);
    toast('削除しました');
    nextInQueue();
  }, { danger: true });
};
