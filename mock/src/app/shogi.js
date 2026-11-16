/* ---------- shogi: positions, legal moves, notation ---------- */
const KJ = { P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛' };
const KJP = { P: 'と', L: '杏', N: '圭', S: '全', B: '馬', R: '竜' };          /* faces on the board */
const KJL = { P: 'と', L: '成香', N: '成桂', S: '成銀', B: '馬', R: '龍' };    /* names in move text */
const SZ = { P: .9, L: .93, N: .94, S: .97, G: .97, B: 1, R: 1, K: 1.03 };
const ZEN = '０１２３４５６７８９', KAN = '〇一二三四五六七八九';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const han = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
const mv = (ja) => esc(han(ja));
const sq = (s) => [+s[0], s.charCodeAt(1) - 96];
const toSq = (f, r) => f + String.fromCharCode(96 + r);
const flip = (side) => (side === 's' ? 'g' : 's');
const sideName = (s) => (s === 's' ? '☗先手' : '☖後手');
const moveOfUsi = (usi, ja) => ({ usi, ja, from: usi[1] === '*' ? null : usi.slice(0, 2), to: usi.slice(2, 4), drop: usi[1] === '*' });

function parseSfen(sfen) {
  const [b, , h] = sfen.split(' ');
  const cells = [];
  b.split('/').forEach((row, ri) => {
    let f = 9, prom = false;
    for (const ch of row) {
      if (ch === '+') { prom = true; continue; }
      if (ch >= '0' && ch <= '9') { f -= +ch; continue; }
      cells.push({ f, r: ri + 1, k: ch.toUpperCase(), side: ch === ch.toUpperCase() ? 's' : 'g', prom });
      prom = false; f--;
    }
  });
  const hands = { s: {}, g: {} };
  if (h && h !== '-') {
    let n = '';
    for (const ch of h) {
      if (ch >= '0' && ch <= '9') { n += ch; continue; }
      hands[ch === ch.toUpperCase() ? 's' : 'g'][ch.toUpperCase()] = n ? +n : 1; n = '';
    }
  }
  return { cells, hands };
}
function gridOf(pos) {
  const g = Array.from({ length: 9 }, () => Array(9).fill(null));
  for (const c of pos.cells) g[c.r - 1][c.f - 1] = c;
  return g;
}

const STEP = {
  P: [[0, -1]], N: [[1, -2], [-1, -2]], S: [[0, -1], [1, -1], [-1, -1], [1, 1], [-1, 1]],
  G: [[0, -1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1]],
  K: [[0, -1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [1, 1], [-1, 1]],
  '+B': [[0, -1], [0, 1], [1, 0], [-1, 0]], '+R': [[1, -1], [-1, -1], [1, 1], [-1, 1]],
};
const SLIDE = { L: [[0, -1]], B: [[1, -1], [-1, -1], [1, 1], [-1, 1]], R: [[0, -1], [0, 1], [1, 0], [-1, 0]] };
const moveKind = (c) => (c.prom ? ('PLNS'.includes(c.k) ? 'G' : '+' + c.k) : c.k);
function reach(g, f, r) {
  const c = g[r - 1][f - 1], kd = moveKind(c), d = c.side === 's' ? 1 : -1, out = [];
  const base = kd[0] === '+' ? kd[1] : kd;
  for (const [dx, dy] of STEP[kd] || []) {
    const nf = f + dx, nr = r + dy * d;
    if (nf < 1 || nf > 9 || nr < 1 || nr > 9) continue;
    const t = g[nr - 1][nf - 1];
    if (!t || t.side !== c.side) out.push([nf, nr]);
  }
  for (const [dx, dy] of SLIDE[base] || []) {
    let nf = f + dx, nr = r + dy * d;
    while (nf >= 1 && nf <= 9 && nr >= 1 && nr <= 9) {
      const t = g[nr - 1][nf - 1];
      if (!t) out.push([nf, nr]);
      else { if (t.side !== c.side) out.push([nf, nr]); break; }
      nf += dx; nr += dy * d;
    }
  }
  return out;
}
function kingOf(g, side) {
  for (let r = 1; r <= 9; r++) for (let f = 1; f <= 9; f++) { const c = g[r - 1][f - 1]; if (c && c.k === 'K' && c.side === side) return [f, r]; }
  return null;
}
function inCheck(g, side) {
  const k = kingOf(g, side);
  if (!k) return false;
  for (let r = 1; r <= 9; r++) for (let f = 1; f <= 9; f++) {
    const c = g[r - 1][f - 1];
    if (c && c.side !== side && reach(g, f, r).some(([a, b]) => a === k[0] && b === k[1])) return true;
  }
  return false;
}
function legalFrom(g, f, r) {
  const c = g[r - 1][f - 1];
  return reach(g, f, r).filter(([nf, nr]) => {
    const t = g[nr - 1][nf - 1];
    g[nr - 1][nf - 1] = c; g[r - 1][f - 1] = null;
    const ok = !inCheck(g, c.side);
    g[r - 1][f - 1] = c; g[nr - 1][nf - 1] = t;
    return ok;
  });
}
function legalDrops(g, k, side) {
  /* 二歩と行き所のない駒は除く。打ち歩詰めは見ていない（モック用の簡易判定）。 */
  const out = [], last = side === 's' ? 1 : 9, d = side === 's' ? 1 : -1;
  for (let r = 1; r <= 9; r++) for (let f = 1; f <= 9; f++) {
    if (g[r - 1][f - 1]) continue;
    if ((k === 'P' || k === 'L') && r === last) continue;
    if (k === 'N' && (r === last || r === last + d)) continue;
    if (k === 'P') {
      let has = false;
      for (let rr = 1; rr <= 9; rr++) { const c = g[rr - 1][f - 1]; if (c && c.side === side && c.k === 'P' && !c.prom) has = true; }
      if (has) continue;
    }
    g[r - 1][f - 1] = { k, side, prom: false };
    const ok = !inCheck(g, side);
    g[r - 1][f - 1] = null;
    if (ok) out.push([f, r]);
  }
  return out;
}
const inZone = (r, side) => (side === 's' ? r <= 3 : r >= 7);
const canPromote = (c, fr, tr) => !c.prom && 'PLNSBR'.includes(c.k) && (inZone(fr, c.side) || inZone(tr, c.side));
function mustPromote(c, tr) {
  const far = c.side === 's' ? tr : 10 - tr;
  return ((c.k === 'P' || c.k === 'L') && far === 1) || (c.k === 'N' && far <= 2);
}
/* the position after a move; the position passed in is left untouched */
function applyMove(pos, m, side) {
  const cells = pos.cells.map((c) => ({ ...c }));
  const hands = { s: { ...pos.hands.s }, g: { ...pos.hands.g } };
  const [tf, tr] = sq(m.to);
  if (m.drop) {
    const k = m.usi[0];
    hands[side][k]--;
    if (!hands[side][k]) delete hands[side][k];
    cells.push({ f: tf, r: tr, k, side, prom: false });
  } else {
    const [ff, fr] = sq(m.from);
    const ti = cells.findIndex((c) => c.f === tf && c.r === tr);
    if (ti >= 0) { const t = cells[ti]; hands[side][t.k] = (hands[side][t.k] || 0) + 1; cells.splice(ti, 1); }
    const c = cells.find((x) => x.f === ff && x.r === fr);
    c.f = tf; c.r = tr;
    if (m.usi.endsWith('+')) c.prom = true;
  }
  return { cells, hands };
}
/* move text for a move made on the board. Where two pieces of a kind could go to the same square,
   the square it came from is added in brackets, as KIF does, in place of 右・左・上・引. */
function jaOf(pos, side, m, lastTo) {
  const g = gridOf(pos), [tf, tr] = sq(m.to);
  const dest = lastTo === m.to ? '同' : ZEN[tf] + KAN[tr];
  const goes = (c) => legalFrom(g, c.f, c.r).some(([a, b]) => a === tf && b === tr);
  let name, tail = '';
  if (m.drop) {
    const k = m.usi[0];
    name = KJ[k];
    if (pos.cells.some((c) => c.side === side && c.k === k && !c.prom && goes(c))) tail = '打';
  } else {
    const [ff, fr] = sq(m.from), c = g[fr - 1][ff - 1];
    name = c.k === 'K' ? '玉' : c.prom ? KJL[c.k] : KJ[c.k];
    if (m.usi.endsWith('+')) tail = '成';
    else if (canPromote(c, fr, tr)) tail = '不成';
    if (pos.cells.some((o) => o !== c && o.side === side && o.k === c.k && o.prom === c.prom && goes(o))) tail += `(${ff}${fr})`;
  }
  return (side === 's' ? '▲' : '△') + dest + name + tail;
}
/* the record as KIF text, for the import sample and for export */
function kifText(G) {
  const M = G.meta, P = G.positions, N = P.length - 1, p2 = (n) => String(n).padStart(2, '0');
  const clock = (s) => `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`;
  const start = 19 * 3600 + ((M.seed * 977) % 7200), day = M.date.replace(/-/g, '/');
  const rows = [];
  let t = 0;
  for (let i = 1; i <= N; i++) {
    const m = P[i].move, x = /^[▲△](同|[１-９][一二三四五六七八九])(成銀|成桂|成香|.)/.exec(m.ja);
    const txt = (x[1] === '同' ? '同　' : x[1]) + x[2] + (m.usi.endsWith('+') ? '成' : '') + (m.drop ? '打' : `(${sq(m.from).join('')})`);
    const dt = 2 + ((i * 7 + (i % 5) * 3 + M.seed) % (i > 35 ? 24 : 6));
    t += dt;
    rows.push(`${String(i).padStart(4, ' ')} ${txt.padEnd(9, '　')} (${String(Math.floor(dt / 60)).padStart(2, ' ')}:${p2(dt % 60)}/${clock(t)})`);
  }
  rows.push(`${String(N + 1).padStart(4, ' ')} 詰み`);
  return [`開始日時：${day} ${clock(start)}`, `終了日時：${day} ${clock(start + t)}`, '手合割：平手', `先手：${M.sente}`, `後手：${M.gote}`,
    '手数----指手---------消費時間--', ...rows, `まで${N}手で${M.winner === 'sente' ? '先手' : '後手'}の勝ち`].join('\n');
}
