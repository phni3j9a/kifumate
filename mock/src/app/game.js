/* ---------- game screen: replay, analysis results, trying moves on a branch ---------- */
let CUR = null, G = null, P = [], N = 0, M = null, SELF = 's', OTHER = 'g', FLIP = false, OWN = true;
let POS = [], PH = [], MARKS = [], MARKED = new Set();
const S = { ply: 0, sel: 0, pick: null, targets: [], br: null, promo: null, rtUntil: 0, kind: 'pre' };
let RUN = null;      /* the analysis in progress: { id, done, total, kind, timer } */
let rtTimer = 0;

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
const winnerSide = () => (M.winner === 'gote' ? 'g' : 's');
const fmtVal = (o) => {
  if (o.end) return o.end === '詰み' ? (winnerSide() === SELF ? '+' : '−') + '詰み' : '終局';
  if (o.mate != null) return ((o.mate > 0) === (SELF === 's') ? '+' : '−') + '詰み';
  return sgn(valOf(o));
};
const judge = (o) => { const c = cpOf(o), a = Math.abs(c); return { lv: a < 150 ? 0 : a < 450 ? 1 : a < 1000 ? 2 : a < 2000 ? 3 : 4, side: c >= 0 ? 's' : 'g' }; };
const plyLabel = (p) => (p ? p + '手目' : '開始局面');
const turnSide = (p) => (P[p].sfen.split(' ')[1] === 'b' ? 's' : 'g');
const moverSide = (p) => (p % 2 === 1 ? 's' : 'g');
const brNow = () => (S.br ? S.br.line[S.br.at - 1] : null);
const gameOver = () => !S.br && S.ply >= N;
const rtBusy = () => !!S.br && paid() && performance.now() < S.rtUntil;
/* the analysis to show for the branch position, if there is one to show */
const brShown = () => { const e = brNow(); return e && paid() && !rtBusy() && e.an.known ? e.an : null; };
const onGame = (gm) => { const t = topNav(); return !!t && t.t === 'game' && t.id === gm.id; };
/* how many candidates this record has to show: three after a precise analysis on the paid plan, else one */
const candCount = () => (CUR.an === 'pre' && paid() ? 3 : 1);
function view() {
  const e = brNow();
  return e ? { pos: e.pos, turn: e.turn, last: e.mv, br: e } : { pos: POS[S.ply], turn: turnSide(S.ply), last: P[S.ply].move, br: null };
}

function loadGame(gm) {
  CUR = gm; G = gm.data; P = G.positions; N = P.length - 1; M = G.meta;
  OWN = !!gm.self; SELF = gm.self === 'g' ? 'g' : 's'; OTHER = flip(SELF); FLIP = SELF === 'g';
  POS = P.map((p) => parseSfen(p.sfen));
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
  const gm = gameById(t.id);
  if (CUR !== gm) loadGame(gm);
  renderGame();
}
function leaveGame() { if (S.br) { S.br = null; clearSel(); } }

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
  const m = P.findIndex((p) => p.mate != null);
  if (m > 0) out.push({ i: m, kind: 'mate', self: (P[m].mate > 0 ? 's' : 'g') === SELF });
  return out.sort((a, b) => a.i - b.i);
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
  const a = [sx + ux * 26, sy + uy * 26], tip = [ex - ux * 12, ey - uy * 12], b = [tip[0] - ux * 46, tip[1] - uy * 46];
  const f1 = (n) => n.toFixed(1);
  const shape = `<line class="ar-ln" x1="${f1(a[0])}" y1="${f1(a[1])}" x2="${f1(b[0])}" y2="${f1(b[1])}"/><polygon class="ar-hd" points="${f1(tip[0])},${f1(tip[1])} ${f1(b[0] + px * 30)},${f1(b[1] + py * 30)} ${f1(b[0] - px * 30)},${f1(b[1] - py * 30)}"/>`;
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
    if (last.from) { const [x, y] = xy(...sq(last.from)); s += `<rect class="b-from" x="${x + 9}" y="${y + 9}" width="${CW - 18}" height="${CH - 18}" rx="10"/>`; }
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
  s += arrowG(arrow, turn);
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
    if ((y1 - y0) / 6 >= 11 || Math.abs(v) !== 2000) grid += `<text class="g-yl" x="${xl - 3}" y="${y}" dy=".35em" text-anchor="end">${v ? sgn(v) : '0'}</text>`;
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
    <line class="g-cur" y1="${y0 - 3}" y2="${bot + 2}"/>${mk}<path class="g-brl" visibility="hidden"/><circle class="g-brd" r="4" visibility="hidden"/><circle class="g-dot" r="4.5"/>
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
  R.graph.querySelectorAll('.g-ph').forEach((el) => { el.setAttribute('opacity', Math.abs(+el.dataset.x - hx) < 27 ? '.12' : '1'); });
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
function readoutHTML() {
  const p = S.ply, mode = anMode(), e = brNow();
  if (e) {
    const n = S.br.at, q = S.br.base + n;
    let h = `<span class="bk">分岐 ${n}手目</span>`;
    if (!paid()) return h + '<span>評価値は出ません（無料プラン）</span>';
    if (rtBusy()) return h + '<span>解析中…</span>';
    if (!e.an.known) return h + '<span>評価値</span><b>—</b>';
    h += `<span>評価値</span><b>${fmtVal(e.an)}</b>`;
    if (q <= N && mode === 'done') h += `<span>本譜の${q}手目は</span><b>${fmtVal(P[q])}</b>`;
    return h;
  }
  if (!seen(p)) return `<span>評価値</span><b>—</b><span>${mode === 'run' ? 'ほかの画面に移っても解析は続きます' : 'まだ解析していません'}</span>`;
  const pos = P[p];
  if (!p) return `<span>開始局面</span><b>${fmtVal(pos)}</b>`;
  const prev = P[p - 1], plain = (o) => !o.end && o.mate == null;
  let h = `<span>評価値</span><b>${fmtVal(prev)} → ${fmtVal(pos)}</b>`;
  if (plain(prev) && plain(pos)) { const d = valOf(pos) - valOf(prev); h += `<span class="dl${d > 0 ? ' up' : d < 0 ? ' dn' : ''}">${sgn(d)}</span>`; }
  if (mode !== 'done') return h;
  if (pos.missedTsume && prev.tsume) h += `<button type="button" class="rl" data-a="jump" data-v="${p - 1}" data-k="dub">${pos.missedTsume}手詰めあり ›</button>`;
  else if (pos.mark === '好手') h += '<span class="rn">好手！</span>';
  else if (pos.mark) {
    const best = (prev.cands || [])[0];
    if (best && best.usi !== pos.move.usi) h += `<button type="button" class="rl" data-a="jump" data-v="${p - 1}" data-k="${MKC[pos.mark]}">最善は ${mv(best.ja)} ›</button>`;
  }
  return h;
}
const aiBtn = () => '<button type="button" class="aib" data-a="ai"><svg class="ic"><use href="#i-spark"/></svg>AIに聞く<svg class="ic lki"><use href="#i-lock"/></svg></button>';
const tryBtn = (label, aria) => `<button type="button" class="try" data-a="playline" aria-label="${aria}"><svg class="ic"><use href="#i-play"/></svg>${label}</button>`;
const pie = (o) => { const w = pct(wrSelf(o)); return `<span class="w" style="background:conic-gradient(var(--you) 0 ${w}%, var(--opp) 0)"><b>${w}%</b><span>勝率</span></span>`; };
function todoCard() {
  const u = DB.usage, kind = paid() ? S.kind : 'std';
  let h = '<div class="tbs">';
  if (paid()) h += `<button type="button" class="tbx${kind === 'pre' ? ' on' : ''}" data-a="kind" data-v="pre">精密解析</button><button type="button" class="tbx${kind === 'std' ? ' on' : ''}" data-a="kind" data-v="std">ふつう</button>`;
  else h += '<span class="tbx on">解析</span><button type="button" class="tbx lkt" data-a="toast" data-v="精密解析（候補3手・より深い読み）は、有料プランで使えます"><svg class="ic"><use href="#i-lock"/></svg>精密</button>';
  const sub = !paid() ? `無料の解析　きょうは あと${u.freeMax - u.freeToday}局` : kind === 'pre' ? `候補3手・深い読み　今月あと${u.preciseMax - u.precise}局` : '候補1手・短い時間で終わります';
  return h + aiBtn() + `</div><div class="bc say"><span class="m">この対局を解析する</span><span class="pw"><span class="p">${sub}</span></span><button type="button" class="bt pri sm x" data-a="analyze">解析する</button></div>`;
}
function runCard() {
  return `<div class="tbs"><span class="tbx on">${RUN.kind === 'pre' ? '精密解析' : '解析'}</span>${aiBtn()}</div><div class="bc say"><span class="m">解析中<small data-run="n">${RUN.done} / ${RUN.total}手</small></span><span class="pgs"><i data-run="bar" style="width:${(100 * RUN.done / RUN.total).toFixed(1)}%"></i></span><button type="button" class="bt sm x" data-a="stopan">中止</button></div>`;
}
function branchCard() {
  const e = brNow(), a = e.an, hot = paid() && !rtBusy() && a.known && a.next;
  let h = `<div class="tbs"><span class="tbx on">${hot ? 'おすすめ' : '分岐'}</span>`;
  if (!paid()) h += '<button type="button" class="tbx lkt" data-a="nav" data-v="plan"><svg class="ic"><use href="#i-lock"/></svg>リアルタイム解析</button>';
  h += aiBtn() + '</div>';
  if (!paid()) return h + '<div class="bc say"><span class="m">自由に指して試せます</span><span class="pw"><span class="p wrap">無料プランでは、分岐中の評価値や最善手は出ません。</span></span></div>';
  if (rtBusy()) return h + '<div class="bc say"><span class="m">解析中<span class="dots"><i></i><i></i><i></i></span></span><span class="pw"><span class="p">この局面の評価値と最善手を調べています</span></span></div>';
  if (!a.known) return h + '<div class="bc say"><span class="m">解析データなし</span><span class="pw"><span class="p wrap">モックの制限です。候補の「試す」「次の手」で進めた手順だけ、評価値が出ます。</span></span></div>';
  if (!a.next) return h + `<div class="bc say"><span class="m">読み筋はここまで</span><span class="pw"><span class="p">評価値 ${fmtVal(a)}（モックではこの先のデータがありません）</span></span>${pie(a)}</div>`;
  return h + `<div class="bc"><span class="m">${mv(a.next.ja)}</span><span class="pw"><span class="p">${a.pv.map(mv).join(' ') || '　'}</span>${tryBtn('次の手', 'おすすめの手を指す')}</span>${pie(a)}</div>`;
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
  rows.forEach((x, i) => { h += `<button type="button" class="tbx${i === S.sel ? ' on' : ''}" data-a="cand" data-v="${i}">${x.rank === 0 ? (isT(x) ? '詰み' : 'おすすめ') : x.rank > 0 ? x.rank + 1 + '位' : '本譜'}</button>`; });
  if (lockedCount(p)) h += `<button type="button" class="tbx lkt" data-a="more23"><svg class="ic"><use href="#${paid() ? 'i-refresh' : 'i-lock'}"/></svg>2位・3位</button>`;
  h += aiBtn() + '</div>';
  const r = rows[S.sel];
  if (r) {
    const pv = isT(r) ? t.line.slice(1).map((m) => mv(m.ja)).join(' ') : r.pv.map((m) => mv(m)).join(' ');
    h += `<div class="bc"><span class="m">${mv(r.ja)}${isT(r) ? `<em class="mk mk-good">${t.len}手詰め</em>` : ''}${r.game && r.rank >= 0 ? '<u>本譜</u>' : ''}${r.mk}</span><span class="pw"><span class="p">${pv || '　'}</span>${r.game ? tryBtn('進む', '本譜を1手進める') : tryBtn('試す', 'この手を盤で試す')}</span>${pie(r.o)}</div>`;
  } else {
    h += `<div class="bc"><span class="m">${winnerSide() === SELF ? YOU() + 'の勝ち！' : OPP() + 'の勝ち'}</span><span class="pw"><span class="p">${N}手で終局（${esc(M.endReason)}）</span></span></div>`;
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
  const o = e ? brShown() : seen(S.ply) ? P[S.ply] : null;
  R.barb.classList.toggle('na', !o);
  if (o) {
    const w = pct(wrSelf(o));
    R.bary.style.width = w + '%';
    R.oppp.textContent = 100 - w + '%';
    R.youp.textContent = w + '%';
    R.bar.setAttribute('aria-label', `${YOU()}の勝率 ${w}%`);
  } else {
    R.youp.textContent = R.oppp.textContent = '';
    R.bar.setAttribute('aria-label', '形勢はまだ分かりません');
  }
  let who = 'even', text;
  if (atEnd) { who = winnerSide() === SELF ? 'you' : 'opp'; text = (who === 'you' ? YOU() : OPP()) + 'の勝ち'; }
  else if (o) { const j = judge(o); who = j.lv ? (j.side === SELF ? 'you' : 'opp') : 'even'; text = who === 'even' ? 'ほぼ互角' : (who === 'you' ? YOU() : OPP()) + 'が' + JN[j.lv]; }
  else text = e ? (!paid() ? '分岐中' : rtBusy() ? '解析中' : '評価なし') : anMode() === 'run' ? '解析中' : '未解析';
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
    R.brl1.innerHTML = paid() ? `<svg class="ic"><use href="#i-bolt"/></svg>リアルタイム解析 <b>残り${DB.usage.rtMax - DB.usage.rt}分</b>` : '分岐中は自動解析なし';
    R.brl2.innerHTML = `<b>分岐中</b>${plyLabel(S.br.base)}から`;
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
function setPly(p) {
  p = Math.max(0, Math.min(N, p));
  if (!S.br && p === S.ply) return;
  S.br = null; S.ply = p; S.sel = 0; CUR.ply = p;
  clearSel();
  renderPly();
}
function exitBranch() {
  if (!S.br) return;
  S.ply = S.br.base; S.br = null; S.sel = 0;
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
  const out = (p.cands || []).map((c) => ({ cp: c.cp, mate: c.mate, usis: c.pvUsi || [c.usi], jas: c.pv || [c.ja] }));
  if (p.tsume) out.unshift({ cp: p.cp, mate: p.mate, usis: p.tsume.line.map((x) => x.usi), jas: p.tsume.line.map((x) => x.ja) });
  return out;
}
function analysisAfter(lines, usi) {
  const hit = lines.filter((l) => l.usis[0] === usi).map((l) => ({ cp: l.cp, mate: l.mate, usis: l.usis.slice(1), jas: l.jas.slice(1) }));
  if (!hit.length) return { known: false, lines: [] };
  const rest = hit.filter((l) => l.usis.length), nx = rest[0] || null;
  return { known: true, cp: hit[0].cp, mate: hit[0].mate, lines: rest, next: nx ? moveOfUsi(nx.usis[0], nx.jas[0]) : null, pv: nx ? nx.jas.slice(1) : [] };
}
function commitMove(m) {
  const v = view(), side = v.turn;
  clearSel();
  if (!S.br && S.ply < N && P[S.ply + 1].move.usi === m.usi) { setPly(S.ply + 1); return; }
  const lines = knownLines(), hit = lines.find((l) => l.usis[0] === m.usi);
  const ja = hit ? hit.jas[0] : jaOf(v.pos, side, m, v.last ? v.last.to : null);
  if (!S.br) S.br = { base: S.ply, line: [], at: 0 };
  S.br.line.length = S.br.at;
  S.br.line.push({ mv: moveOfUsi(m.usi, ja), pos: applyMove(v.pos, m, side), turn: flip(side), an: analysisAfter(lines, m.usi) });
  S.br.at++;
  if (paid()) {
    S.rtUntil = performance.now() + 650;
    clearTimeout(rtTimer);
    rtTimer = setTimeout(() => { if (S.br && topNav() && topNav().t === 'game') renderPly(); }, 670);
  }
  renderPly();
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
  if (c.side !== v.turn) { clearPick(); toast(`いまは${sideName(v.turn)}の番です`); return; }
  if (S.pick && S.pick.f === f && S.pick.r === r) { clearPick(); return; }
  S.pick = { f, r };
  S.targets = legalFrom(gridOf(v.pos), f, r);
  renderBoard();
});
A.hand = (k, el) => {
  if (gameOver()) return;
  const v = view();
  S.promo = null;
  if (el.dataset.side !== v.turn) { toast(`いまは${sideName(v.turn)}の番です`); return; }
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
A.kf = () => { openSheet(S.br ? '分岐の手順' : '棋譜', S.br ? branchMovesHTML() : movesHTML(), { id: 'kf' }); markCurrent(); };
A.kind = (v) => { S.kind = v; renderCands(); };
A.more23 = () => {
  if (!paid()) { toast('2位・3位の候補は、精密解析（有料プラン）で表示されます'); return; }
  ask('精密解析でやり直しますか', `精密解析では、候補を3手まで出します。今月あと${DB.usage.preciseMax - DB.usage.precise}局使えます。`, '精密解析する', () => startAnalysis(CUR, 'pre'));
};

/* ---------- analysis run (simulated: the real one runs on the server and takes about 1 to 3 minutes) ---------- */
function startAnalysis(gm, kind) {
  const u = DB.usage;
  if (RUN) { toast('ほかの対局を解析しています。終わってから始めてください'); return; }
  if (!paid() && u.freeToday >= u.freeMax) { toast('きょうの無料解析は上限に達しました'); return; }
  if (paid() && kind === 'pre' && u.precise >= u.preciseMax) { toast('今月の精密解析は上限に達しました'); return; }
  RUN = { id: gm.id, done: 0, total: gm.plies, kind };
  RUN.timer = setInterval(tickRun, 70);
  if (onGame(gm)) { S.br = null; clearSel(); renderGame(); }
}
function tickRun() {
  const r = RUN, gm = gameById(r.id), on = !!gm && onGame(gm), before = on && seen(S.ply);
  r.done = Math.min(r.total, r.done + (r.done < 24 ? 2 : 1));
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
  if (!paid()) DB.usage.freeToday++;
  else if (r.kind === 'pre') DB.usage.precise++;
  if (onGame(gm)) {
    renderGame();
    if (AI.open) renderAI();
    if (DB.celebrated) toast('解析が終わりました');
    else {
      DB.celebrated = true;
      ask('はじめての解析ができました', 'グラフの印をタップすると、その手に移れます。盤の駒を動かせば、別の手も試せます。まずは、形勢が大きく動いた手を見てみましょう。', '見てみる', () => { if (CUR === gm) setPly(startPly()); }, { single: true, img: 'learn-first' });
    }
  }
  else { if (!topNav() || topNav().t !== 'game') show(); toast(`解析が終わりました（${gm.self ? oppName(gm) + ' 戦' : gm.date}）`); }
}
A.analyze = () => startAnalysis(CUR, paid() ? S.kind : 'std');
A.stopan = () => {
  if (!RUN) return;
  clearInterval(RUN.timer);
  RUN = null;
  renderGame();
  toast('解析を中止しました');
};

/* ---------- the record's menu ---------- */
A.gmenu = () => {
  const g = CUR, running = RUN && RUN.id === g.id;
  const row = (a, icon, label, sub, cls) => `<button type="button" class="mn2" data-a="${a}"><span class="mi${cls || ''}"><svg class="ic"><use href="#${icon}"/></svg></span><span>${label}${sub ? `<small>${sub}</small>` : ''}</span></button>`;
  let h = row('gfav', 'i-star', g.fav ? 'お気に入りから外す' : 'お気に入りに入れる', '', g.fav ? ' on' : '');
  h += row('ginfo', 'i-info', '対局情報', '対局者・結果・戦法と囲い');
  if (g.an !== 'none' && !running) h += row('reanalyze', 'i-refresh', g.an === 'pre' ? 'もう一度解析する' : '精密解析でやり直す', paid() ? `精密解析　今月あと${DB.usage.preciseMax - DB.usage.precise}局` : '精密解析は有料プランの機能です');
  h += row('kifout', 'i-export', 'KIFを書き出す', 'テキストをコピーできます');
  h += row('gdel', 'i-trash', 'この棋譜を削除', '', ' dng');
  openSheet('この対局', h, { auto: true });
};
A.gfav = () => { CUR.fav = !CUR.fav; closeSheet(); toast(CUR.fav ? 'お気に入りに入れました' : 'お気に入りから外しました'); };
A.ginfo = () => { closeSheet(); push({ t: 'info', id: CUR.id }); };
A.reanalyze = () => {
  closeSheet();
  if (!paid()) { push({ t: 'plan' }); return; }
  ask('精密解析でやり直しますか', `いまの解析結果は、新しい結果に置きかわります。今月あと${DB.usage.preciseMax - DB.usage.precise}局使えます。`, '精密解析する', () => startAnalysis(CUR, 'pre'));
};
A.kifout = () => {
  openSheet('KIFを書き出す', `<textarea class="kifx" id="kifx" readonly spellcheck="false">${esc(kifText(G))}</textarea><div class="acts"><button type="button" class="bt pri wide" data-a="copykif"><svg class="ic"><use href="#i-copy"/></svg>コピーする</button></div><p class="hint">実際のアプリでは、ファイルとして保存したり、ほかのアプリに渡したりもできるようにします。</p>`, { auto: true });
};
A.copykif = () => {
  const ta = document.getElementById('kifx');
  const fallback = () => { ta.focus(); ta.select(); toast('全体を選びました。コピーしてください'); };
  try { navigator.clipboard.writeText(ta.value).then(() => toast('コピーしました'), fallback); } catch (_) { fallback(); }
};
A.gdel = () => {
  closeSheet();
  ask('この棋譜を削除しますか', '解析結果とAI解説もいっしょに消えます。戦績からも外れます。', '削除する', () => {
    const g = CUR;
    if (RUN && RUN.id === g.id) { clearInterval(RUN.timer); RUN = null; }
    DB.games.splice(DB.games.indexOf(g), 1);
    CUR = null;
    for (let i = NAV.length - 1; i >= 0; i--) if (NAV[i].id === g.id) NAV.splice(i, 1);
    show(false, true);
    toast('削除しました');
  }, { danger: true });
};
