/* ---------- the other screens: list, import, statistics, settings ---------- */
const WD = '日月火水木金土';
const dparts = (d) => { const [y, m, dd] = d.split('-').map(Number); return { y, m, d: dd, w: WD[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()] }; };
const dshort = (d) => { const o = dparts(d); return `${o.m}/${o.d}（${o.w}）`; };
const dlong = (d) => { const o = dparts(d); return `${o.y}年${o.m}月${o.d}日（${o.w}）`; };
const daysAgo = (d) => Math.round((Date.parse(TODAY + 'T00:00:00Z') - Date.parse(d + 'T00:00:00Z')) / 86400000);
/* win rate = wins / (wins + losses); draws and records whose result is not known are left out of it */
const tally = (gs) => {
  const c = { w: 0, l: 0, d: 0, u: 0 };
  gs.forEach((g) => { const r = resOf(g); if (r) c[r]++; });
  return { n: gs.length, ...c, r: c.w + c.l ? Math.round((100 * c.w) / (c.w + c.l)) : 0 };
};
const wl = (t, sp) => `${t.w}勝${sp || ''}${t.l}敗${t.d ? `${sp || ''}${t.d}分` : ''}`;
const hasSt = (t, n) => (n === '未分類' ? !t.st.length : t.st.includes(n));
const hasCs = (t, n) => (n === '未分類' ? !t.cs.length : t.cs.includes(n));

function gameMatch(g, f) {
  if (f.scope === 'self' && !g.self) return false;
  if (f.scope === 'other' && g.self) return false;
  if (f.period && daysAgo(g.date) > +f.period) return false;
  if (f.fav && !g.fav) return false;
  if (f.an === 'none' && g.an !== 'none') return false;
  if (f.side || f.res || f.myst || f.mycs || f.opst) {
    if (!g.self) return false;
    if (f.side && g.self !== f.side) return false;
    if (f.res && resOf(g) !== f.res) return false;
    if (f.myst && !hasSt(myTags(g), f.myst)) return false;
    if (f.opst && !hasSt(opTags(g), f.opst)) return false;
    if (f.mycs && !hasCs(myTags(g), f.mycs)) return false;
  }
  if (f.q) {
    const hay = [g.sente, g.gote, ...g.tags.s.st, ...g.tags.s.cs, ...g.tags.g.st, ...g.tags.g.cs].join(' ').toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
}
function listFilter() {
  const f = { ...UI.flt, q: UI.q.trim() };
  if (UI.quick === 'fav') f.fav = true;
  else if (UI.quick === 'w' || UI.quick === 'l') f.res = UI.quick;
  else if (UI.quick === 'none') f.an = 'none';
  return f;
}
const fltCount = () => Object.keys(FL0).filter((k) => UI.flt[k]).length;

/* ---------- game cards ---------- */
/* evaluation curve for the card: real for the two sample records, made up (but ending on the right side) for the rest */
function valsFor(g) {
  if (g._v && g._vs === g.self) return g._v;
  const sign = g.self === 'g' ? -1 : 1;
  let out;
  if (g.data) out = g.data.positions.map((p) => sign * (p.mate != null ? (p.mate > 0 ? 3000 : -3000) : p.cp));
  else {
    let s = 0;
    for (const ch of g.id + g.date) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const n = 34, end = sign * (g.win === 's' ? 1 : g.win === 'g' ? -1 : 0) * (2200 + rnd() * 800);
    let w = 0;
    out = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      w += (rnd() - 0.5) * 560 * (t < 0.25 ? 0.2 : 1);
      if (t > 0.3 && rnd() < 0.09) w += (rnd() - 0.5) * 2000;
      w *= 0.95;
      out.push(Math.round(w * (1 - t * t * t) + end * t * t * t));
    }
  }
  g._v = out; g._vs = g.self;
  return out;
}
let SPN = 0;
function spark(vals) {
  const W = 62, H = 28, mid = H / 2, n = vals.length - 1, id = 'sp' + (++SPN);
  const X = (i) => 1 + ((W - 2) * i) / n, Y = (v) => mid - ((mid - 2) * Math.max(-3000, Math.min(3000, v))) / 3000;
  let d = '';
  vals.forEach((v, i) => { d += (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); });
  const area = `${d}L${X(n).toFixed(1)} ${mid}L${X(0).toFixed(1)} ${mid}Z`;
  return `<svg class="spk" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><defs><clipPath id="${id}u"><rect width="${W}" height="${mid}"/></clipPath><clipPath id="${id}d"><rect y="${mid}" width="${W}" height="${mid}"/></clipPath></defs><path class="g-up" d="${area}" clip-path="url(#${id}u)"/><path class="g-dn" d="${area}" clip-path="url(#${id}d)"/><line class="spz" x1="0" x2="${W}" y1="${mid}" y2="${mid}"/><path class="spl" d="${d}"/></svg>`;
}
function gameCard(g) {
  const own = !!g.self, r = resOf(g), run = RUN && RUN.id === g.id, wait = QUEUE.some((q) => q.id === g.id);
  const ST = { w: ['勝', '勝ち'], l: ['負', '負け'], d: ['分', '引き分け'], u: ['？', '結果は不明'] };
  const stamp = r ? `<span class="rs ${r}" role="img" aria-label="${ST[r][1]}">${ST[r][0]}</span>` : '<span class="rs o" role="img" aria-label="自分以外の対局">他</span>';
  let tags;
  if (own) {
    const my = myTags(g), op = opTags(g), cs = csFinal(my);
    tags = stNames(my).map((n) => `<i class="t">${n}</i>`).join('') + (cs ? `<i class="t">${cs}</i>` : '') + (!my.st.length && !cs ? '<i class="t un">未分類</i>' : '') + (stNames(op).length ? `<i class="t op"><small>相手</small>${stNames(op)[0]}</i>` : '');
  } else {
    tags = ['s', 'g'].map((s) => `<i class="t op"><small>${s === 's' ? '☗' : '☖'}</small>${stNames(g.tags[s])[0] || '未分類'}</i>`).join('');
  }
  const right = run ? `<span class="runpill" data-runpill>${RUN.paused ? '中断中' : '解析中'} ${RUN.done}/${RUN.total}</span>` : wait ? '<span class="runpill wt">解析待ち</span>' : g.an === 'none' ? '<span class="nopill">未解析</span>' : spark(valsFor(g));
  return `<div class="gcd" role="button" tabindex="0" data-a="open" data-v="${g.id}">${stamp}<div class="gin"><div class="g1"><b>${own ? esc(oppName(g)) : `${esc(g.sente)} 対 ${esc(g.gote)}`}</b><span class="sd">${g.sample ? 'サンプル' : own ? `あなたは${g.self === 's' ? '☗先手' : '☖後手'}` : '自分以外の対局'}</span></div><div class="tg">${tags}</div><div class="g3"><span>${dshort(g.date)}・${g.plies}手</span>${g.an === 'pre' && !run ? '<span class="pre">精密解析</span>' : ''}</div></div><div class="gx">${right}<button type="button" class="fv" data-a="fav" data-v="${g.id}" aria-pressed="${g.fav}" aria-label="お気に入り"><svg class="ic"><use href="#i-star"/></svg></button></div></div>`;
}
function listHTML(gs, canClear) {
  if (!gs.length) {
    const q = UI.q.trim(), why = !canClear ? '条件に合う棋譜がありません' : q ? `「${esc(q)}」に合う棋譜がありません` : fltCount() ? '条件に合う棋譜がありません' : { fav: 'お気に入りの棋譜はまだありません', w: '勝った対局はまだありません', l: '負けた対局はありません', none: '未解析の棋譜はありません' }[UI.quick] || '条件に合う棋譜がありません';
    return `<div class="emp sm">${pic('sys-noresults', 'empi')}<h3>${why}</h3>${canClear ? '<button type="button" class="bt sm" data-a="fclear">すべての棋譜を表示</button>' : ''}</div>`;
  }
  let h = '', cur = '';
  [...gs].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).forEach((g) => {
    const k = g.date.slice(0, 7);
    if (k !== cur) { cur = k; h += `<h3 class="mh">${+k.slice(0, 4)}年${+k.slice(5)}月</h3>`; }
    h += gameCard(g);
  });
  return h;
}
function fsumHTML(n) {
  const f = UI.flt, parts = [];
  if (f.scope) parts.push(f.scope === 'self' ? '自分の対局' : '自分以外');
  if (f.side) parts.push(f.side === 's' ? '先手' : '後手');
  if (f.period) parts.push(`直近${f.period}日`);
  if (f.myst) parts.push(`自分：${f.myst}`);
  if (f.mycs) parts.push(`囲い：${f.mycs}`);
  if (f.opst) parts.push(`相手：${f.opst}`);
  if (UI.q.trim()) parts.push(`「${esc(UI.q.trim())}」`);
  if (!parts.length) return '';
  const t = tally(DB.games.filter((g) => g.self && gameMatch(g, listFilter())));
  return `<div class="fsum"><span>${parts.join('・')}　${n}局${t.n ? `（${wl(t)}）` : ''}</span><button type="button" data-a="fclear">解除</button></div>`;
}

/* ---------- tab: list ---------- */
const offlineBar = () => (DB.online ? '' : '<p class="offb"><svg class="ic"><use href="#i-info"/></svg>オフラインです。保存済みの棋譜と解析結果は見られます。</p>');
function listTab() {
  if (!DB.games.length) {
    return `<header class="ab"><h2>棋譜</h2></header>${offlineBar()}<div class="emp">${pic('sys-empty', 'empi')}<h3>まだ棋譜がありません</h3><p>指した将棋のKIFを取り込むと、ここに並びます。解析して、振り返りを始めましょう。</p><button type="button" class="bt pri" data-a="nav" data-v="import"><svg class="ic"><use href="#i-plus"/></svg>棋譜を取り込む</button><button type="button" class="tx-b" data-a="sample">見本の対局で試してみる</button>${KIF_HELP}</div>`;
  }
  const u = DB.usage, gs = DB.games.filter((g) => gameMatch(g, listFilter())), nf = fltCount();
  const chip = (v, label) => `<button type="button" class="ch" data-a="quick" data-v="${v}" aria-pressed="${UI.quick === v}">${label}</button>`;
  return `<header class="ab"><h2>棋譜</h2><span class="abn">${DB.games.length}局</span>${paid() ? '' : `<button type="button" class="upl" data-a="nav" data-v="plan">今週の解析 <b>あと${Math.max(0, u.freeMax - u.free)}局</b><svg class="ic"><use href="#i-next"/></svg></button>`}${UI.search ? '' : '<button type="button" class="rb" data-a="search" aria-label="検索"><svg class="ic"><use href="#i-search"/></svg></button>'}</header>
    ${UI.search ? `<label class="sf"><svg class="ic"><use href="#i-search"/></svg><input id="q" type="text" inputmode="search" enterkeyhint="search" autocomplete="off" placeholder="対局者名・戦法・囲い" value="${esc(UI.q)}"><button type="button" data-a="search" aria-label="検索を閉じる"><svg class="ic"><use href="#i-x"/></svg></button></label>` : ''}
    ${offlineBar()}<div class="chs" role="group" aria-label="絞り込み"><button type="button" class="ch act" data-a="filter"><svg class="ic"><use href="#i-filter"/></svg>絞り込み${nf ? `<span class="n">${nf}</span>` : ''}</button>${chip('all', 'すべて')}${chip('fav', 'お気に入り')}${chip('w', '勝ち')}${chip('l', '負け')}${chip('none', '未解析')}</div>
    <div data-b2="fsum">${fsumHTML(gs.length)}</div>
    <div class="gl fabpad" data-b2="gl">${listHTML(gs, true)}</div>
    <button type="button" class="fab" data-a="nav" data-v="import"><svg class="ic"><use href="#i-plus"/></svg>取り込む</button>`;
}
function refreshList() {
  const gl = R.tabc.querySelector('[data-b2="gl"]'), fs = R.tabc.querySelector('[data-b2="fsum"]');
  if (!gl) return;
  const gs = DB.games.filter((g) => gameMatch(g, listFilter()));
  gl.innerHTML = listHTML(gs, true);
  fs.innerHTML = fsumHTML(gs.length);
}
function filterSheetHTML() {
  const f = UI.flt, own = DB.games.filter((g) => g.self);
  const grp = (key, label, opts) => `<h3 class="fgrp">${label}</h3><div class="opt">${opts.map(([v, t]) => `<button type="button" class="ch" data-a="fset" data-v="${key}:${v}" aria-pressed="${(f[key] || '') === v}">${t}</button>`).join('')}</div>`;
  const names = (arr) => uniq(arr).map((s) => [s, s]);
  const n = DB.games.filter((g) => gameMatch(g, listFilter())).length;
  return grp('scope', '対象', [['', 'すべて'], ['self', '自分の対局'], ['other', '自分以外']])
    + grp('side', '先手・後手', [['', 'すべて'], ['s', '☗先手'], ['g', '☖後手']])
    + grp('period', '期間', [['', 'すべて'], ['90', '90日'], ['30', '30日']])
    + grp('myst', '自分の戦法', [['', 'すべて'], ['居飛車', '居飛車（全部）'], ['振り飛車', '振り飛車（全部）'], ...names(own.flatMap((g) => myTags(g).st.slice(1))), ['未分類', '未分類']])
    + grp('mycs', '自分の囲い', [['', 'すべて'], ...names(own.flatMap((g) => myTags(g).cs)), ['未分類', '未分類']])
    + grp('opst', '相手の戦法', [['', 'すべて'], ['居飛車', '居飛車（全部）'], ['振り飛車', '振り飛車（全部）'], ...names(own.flatMap((g) => opTags(g).st.slice(1)))])
    + `<div class="acts stk"><button type="button" class="bt pri wide" data-a="closesheet">${n}局を表示</button>${fltCount() ? '<button type="button" class="tx-b" data-a="fclearsheet">条件をすべて外す</button>' : ''}</div>`;
}
A.open = (id) => {
  const g = gameById(id);
  if (!g.data) { toast('モックで中まで開けるのは、見本の棋譜が入った対局（11/8 kawasemi 戦、11/10 tsugumi 戦、取り込んだ対局）だけです'); return; }
  push({ t: 'game', id });
};
A.fav = (id, el) => { const g = gameById(id); g.fav = !g.fav; el.setAttribute('aria-pressed', g.fav); if (UI.quick === 'fav' && !topNav()) refreshList(); };
const listTop = () => { const el = R.tabc.querySelector('.gl'); if (el) el.scrollTop = 0; };
A.quick = (v) => { UI.quick = v; show(); listTop(); };
A.search = () => {
  UI.search = !UI.search;
  if (!UI.search) UI.q = '';
  show();
  if (UI.search) { const q = document.getElementById('q'); if (q) q.focus(); }
};
A.filter = () => openSheet('絞り込み', filterSheetHTML(), { id: 'flt', h: '70%' });
A.fset = (v) => {
  const i = v.indexOf(':'), y = R.shc.scrollTop;
  UI.flt[v.slice(0, i)] = v.slice(i + 1);
  R.shc.innerHTML = filterSheetHTML();
  R.shc.scrollTop = y;
  renderRoot();
  listTop();
};
A.fclear = () => { UI.flt = { ...FL0 }; UI.q = ''; UI.search = false; UI.quick = 'all'; show(); };
A.fclearsheet = () => { UI.flt = { ...FL0 }; R.shc.innerHTML = filterSheetHTML(); R.shc.scrollTop = 0; renderRoot(); listTop(); };
SCR.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'q') { UI.q = t.value; refreshList(); }
  else if (t.id === 'kif-in') {
    IMP.text = t.value;
    const r = R.vpage.querySelector('[data-b2="impres"]'), c = R.vpage.querySelector('[data-b2="impclr"]');
    if (r) r.innerHTML = impResultHTML();
    if (c) c.hidden = !t.value;
    t.classList.toggle('ng', impState() === 'bad');
  }
  else if (t.id === 'goal-in') DB.profile.goal = t.value;
  else if (t.id === 'onb-name') ONB.name = t.value;
  else if (t.id === 'onb-goal') ONB.goal = t.value;
});

/* ---------- import ---------- */
const IMP = { tab: 'paste', text: '', file: '', pick: undefined };
const game2 = () => DB.games.find((g) => g.data === window.KIFU2);
/* Your side in the record: matched against the registered names; a choice made by hand wins.
   's' / 'g' = that side, 'x' = not your game, null = no name matches and nothing chosen yet. */
const impAuto = () => { const m = window.KIFU2.meta, g = DB.names.includes(m.gote), s2 = DB.names.includes(m.sente); return g && s2 ? null : g ? 'g' : s2 ? 's' : null; };
const impBoth = () => { const m = window.KIFU2.meta; return DB.names.includes(m.gote) && DB.names.includes(m.sente); };
const impSide = () => (IMP.pick !== undefined ? IMP.pick : impAuto());
const impState = () => (IMP.tab === 'file' ? (IMP.file ? 'ok' : '') : !IMP.text.trim() ? '' : /手数-+指手|^\s*\d+\s+\S+/m.test(IMP.text) ? 'ok' : 'bad');
const KIF_HELP = '<button type="button" class="tx-b" data-a="kifhelp">KIFってなに？ どこで手に入る？</button>';
function impResultHTML() {
  const st = impState(), row = (cls, icon, title, body) => `<div class="vl"><span class="ck${cls}"><svg class="ic"><use href="#${icon}"/></svg></span><div class="vx"><b>${title}</b>${body}</div></div>`;
  if (!st) return `<p class="hint">対局サービスへのログインや連携は要りません。棋譜のテキストかファイルがあれば取り込めます。</p><div class="lnk l">${KIF_HELP}</div>`;
  if (st === 'bad') return `<div class="cd vri bad">${pic('sys-invalid', 'vrim')}<div><b>棋譜として読み取れませんでした</b><p>KIF形式の「手数----指手」の行と、その下に指し手が入っているか確かめてください。</p></div></div><div class="lnk l">${KIF_HELP}</div>`;
  const m = window.KIFU2.meta, dup = game2(), auto = impAuto();
  let h = `<div class="cd vr">${row('', 'i-check', '棋譜を読み取れました', `<div class="vs"><i>日付</i><span>${dlong(m.date)}</span><i>先手</i><span>☗ ${esc(m.sente)}</span><i>後手</i><span>☖ ${esc(m.gote)}</span><i>結果</i><span>${m.plies}手で${m.winner === 'sente' ? '先手' : '後手'}の勝ち（${esc(m.endReason)}）</span></div>`)}`;
  if (dup) {
    return h + `</div><div class="cd vri warn">${pic('sys-duplicate', 'vrim')}<div><b>同じ棋譜がすでに保存されています</b><p>二重に保存すると戦績も二重に数えられるため、取り込みません。</p></div></div><div class="acts"><button type="button" class="bt pri wide" data-a="open" data-v="${dup.id}">保存済みの棋譜を開く</button></div>`;
  }
  const side = impSide(), name = side === 's' ? m.sente : side === 'g' ? m.gote : '';
  const seg = `<div class="sg" role="group" aria-label="あなたはどちら">${[['s', `☗ ${esc(m.sente)}`], ['g', `☖ ${esc(m.gote)}`], ['x', '自分ではない']].map(([v, t]) => `<button type="button" data-a="impside" data-v="${v}" aria-pressed="${side === v}">${t}</button>`).join('')}</div>`;
  if (side == null) h += row(' wn', 'i-info', 'あなたはどちらですか？', `${impBoth() ? '先手と後手のどちらも、登録した名前に当てはまります。' : DB.names.length ? '登録した名前に当てはまる対局者がいません。選んだ名前は、自分の対局者名として登録されます。' : '対局者名がまだ登録されていません。選んだ名前は、自分の対局者名として登録されます。'}${seg}`);
  else if (side === 'x') h += row('', 'i-check', '自分の対局ではない', `保存・再生・解析はできます。戦績には数えません。${seg}`);
  else h += row('', 'i-check', `あなたは${side === 's' ? '先手' : '後手'}`, `${side === auto ? `登録した名前「${esc(name)}」と一致しました。` : DB.names.includes(name) ? '手で指定しました。' : `保存すると、「${esc(name)}」を自分の対局者名に登録します。`}${seg}`);
  h += row('', 'i-check', '重複はありません', '保存済みの棋譜に、同じ対局は見つかりませんでした。') + '</div>';
  const off = side == null ? ' disabled' : '';
  if (!canRun('std')) return h + `<div class="acts"><button type="button" class="bt pri wide" data-a="impsave" data-v="0"${off}>保存する</button><small>今週の解析は使い切りました。解析は、${WEEK}（日本時間）以降にできます。</small></div>`;
  /* on the paid plan the kind of analysis is chosen here, so a precise analysis is never spent unnoticed */
  const kind = paid() && preciseLeft() ? S.kind : 'std';
  const pick = paid() ? `<div class="sg" role="group" aria-label="解析の種類"><button type="button" data-a="impkind" data-v="pre" aria-pressed="${kind === 'pre'}"${preciseLeft() ? '' : ' disabled'}>精密解析（今週あと${preciseLeft()}局）</button><button type="button" data-a="impkind" data-v="std" aria-pressed="${kind === 'std'}">ふつうの解析</button></div>` : '';
  const note = !DB.online ? '通信できないため、解析はつながってから始まります' : RUN ? 'いまの解析が終わったら、続けて解析します' : !paid() ? `今週の解析　あと${freeLeft()}局` : kind === 'pre' ? '精密解析を1局分使います（候補3手・深い読み・AIコーチ）' : '候補1手です。AIコーチは、精密解析した対局で使えます';
  return h + `<div class="acts">${pick}<button type="button" class="bt pri wide" data-a="impsave" data-v="1"${off}>保存して解析する</button><small>${note}</small><button type="button" class="bt wide" data-a="impsave" data-v="0"${off}>保存だけする</button></div>`;
}
A.impkind = (v) => { S.kind = v; R.vpage.querySelector('[data-b2="impres"]').innerHTML = impResultHTML(); };
A.kifhelp = () => openSheet('KIFについて', `<div class="evh"><p><b>KIF</b>は、将棋の棋譜を保存するための形式です。対局者の名前、日付、指し手が、テキストで書かれています。</p><p>多くの対局サイトや対局アプリには、「棋譜をコピー」「棋譜を保存」「KIF出力」などのメニューがあり、そこから取り出せます。</p><p>コピーしたら「テキスト」で貼り付け、ファイルなら「ファイル」で選んで取り込みます。</p></div><pre class="kifs">開始日時：2026/11/15 20:05:08\n先手：hiyodori\n後手：tsubame\n手数----指手---------消費時間--\n   1 ７六歩(77)   ( 0:04/00:00:04)\n   2 ３四歩(33)   ( 0:02/00:00:06)</pre><p class="hint">こういう形のテキストです。拡張子は .kif か .kifu です。</p>`, { auto: true });
function importPage() {
  const tab = (v, t) => `<button type="button" data-a="imptab" data-v="${v}" aria-pressed="${IMP.tab === v}">${t}</button>`;
  const input = IMP.tab === 'paste'
    ? `<textarea id="kif-in" class="ta kif${impState() === 'bad' ? ' ng' : ''}" spellcheck="false" autocomplete="off" aria-label="KIF形式の棋譜" placeholder="KIF形式の棋譜をここに貼り付けます">${esc(IMP.text)}</textarea><div style="display:flex;gap:8px;margin-top:8px"><button type="button" class="bt sm" data-a="imppaste"><svg class="ic"><use href="#i-paste"/></svg>クリップボードから貼り付け</button><button type="button" class="bt sm" data-a="impclear" data-b2="impclr"${IMP.text ? '' : ' hidden'}>消す</button></div>`
    : IMP.file ? `<div class="fpick"><span class="fchip"><svg class="ic"><use href="#i-file"/></svg>${esc(IMP.file)}</span><button type="button" class="tx-b" data-a="impclear">ほかのファイルを選ぶ</button></div>`
      : '<div class="fpick"><button type="button" class="bt sm" data-a="impfile"><svg class="ic"><use href="#i-file"/></svg>ファイルを選ぶ</button><span>.kif / .kifu のファイルを選べます</span></div>';
  return { title: '棋譜を取り込む', close: true, html: `<div class="pgc"><div class="sg" role="group">${tab('paste', 'テキスト')}${tab('file', 'ファイル')}</div><div style="margin-top:10px">${input}</div><p class="mockn"><b>モック</b>　「クリップボードから貼り付け」「ファイルを選ぶ」を押すと、見本の棋譜が入ります。何を入れても、見本の対局として扱います。</p><div data-b2="impres">${impResultHTML()}</div></div>` };
}
/* a ready-made, already analysed record for someone with no KIF at hand; never counted in the statistics */
A.sample = () => {
  let g = DB.games.find((x) => x.sample);
  if (!g) { g = gameFromData(window.KIFU, 'pre', false); g.self = null; g.sample = true; DB.games.push(g); }
  push({ t: 'game', id: g.id });
};
A.imptab = (v) => { IMP.tab = v; show(); };
A.imppaste = () => { IMP.text = kifText(window.KIFU2); show(); };
A.impfile = () => { IMP.file = 'kifu_20261115.kif'; show(); };
A.impclear = () => { IMP.text = ''; IMP.file = ''; show(); };
A.impside = (v) => { IMP.pick = v; R.vpage.querySelector('[data-b2="impres"]').innerHTML = impResultHTML(); };
/* saving a record you chose a side for also registers that player name, so the next one is recognised */
function addGame2() {
  const gm = gameFromData(window.KIFU2, 'none', false), side = impSide(), name = side === 's' ? gm.sente : side === 'g' ? gm.gote : '';
  gm.self = side === 's' || side === 'g' ? side : null;
  let added = '';
  if (name && !DB.names.includes(name)) { DB.names.push(name); added = name; }
  DB.games.unshift(gm);
  IMP.text = ''; IMP.file = ''; IMP.pick = undefined;
  return { gm, added };
}
A.impsave = (v) => {
  const { gm, added } = addGame2();
  NAV.length = 0; UI.tab = 'list'; UI.scroll.list = 0;
  push({ t: 'game', id: gm.id });
  const queued = v === '1' && !!RUN;
  if (v === '1') startAnalysis(gm, paid() && preciseLeft() ? S.kind : 'std');
  if (!queued && R.dlg.hidden) toast(added ? `保存しました。「${added}」を自分の対局者名に登録しました` : '保存しました');
};

/* ---------- tab: statistics ---------- */
let TREND = null;
function trendSVG(chron) {
  const pts = [];
  for (let i = 4; i < chron.length; i++) { const win = chron.slice(Math.max(0, i - 9), i + 1); pts.push({ r: tally(win).r, d: chron[i].date, n: win.length }); }
  TREND = null;
  if (pts.length < 2) return '<p class="empty">5局以上になると表示されます。</p>';
  const W = 320, H = 108, pl = 30, pr = 36, pt = 10, pb = 18, f1 = (n) => n.toFixed(1);
  const X = (k) => pl + ((W - pl - pr) * k) / (pts.length - 1), Y = (r) => pt + ((H - pt - pb) * (100 - r)) / 100;
  let d = '', dots = '';
  pts.forEach((p, k) => { d += (k ? 'L' : 'M') + f1(X(k)) + ' ' + f1(Y(p.r)); if (k < pts.length - 1) dots += `<circle class="t-pt" cx="${f1(X(k))}" cy="${f1(Y(p.r))}" r="2.3"/>`; });
  const last = pts[pts.length - 1], lx = X(pts.length - 1), ly = Y(last.r), o = (s) => { const q = dparts(s); return `${q.m}/${q.d}`; };
  TREND = { pts, X, W, pl, pr };
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="直近10局の勝率の推移。最新は${last.r}%">
    ${[0, 50, 100].map((r) => `<line class="${r === 50 ? 't-g5' : 't-gl'}" x1="${pl}" x2="${W - pr}" y1="${f1(Y(r))}" y2="${f1(Y(r))}"/><text class="t-yl" x="${pl - 5}" y="${f1(Y(r))}" dy=".35em" text-anchor="end">${r}%</text>`).join('')}
    <path class="t-ar" d="${d}L${f1(lx)} ${f1(Y(0))}L${f1(X(0))} ${f1(Y(0))}Z" opacity=".55"/><path class="t-ln" d="${d}"/>${dots}
    <line class="t-hv" y1="${pt}" y2="${H - pb}" visibility="hidden"/>
    <circle class="t-end" cx="${f1(lx)}" cy="${f1(ly)}" r="4.5"/><text class="t-el" x="${f1(lx + 8)}" y="${f1(ly)}" dy=".35em">${last.r}%</text>
    <text class="t-yl" x="${pl}" y="${H - 4}">${o(pts[0].d)}</text><text class="t-yl" x="${W - pr}" y="${H - 4}" text-anchor="end">${o(last.d)}</text>
  </svg><div class="g-tip" hidden><b></b><span></span></div>`;
}
function statRows(gs, dim) {
  const tagOf = dim === 'opst' ? opTags : myTags;
  let h = '';
  const row = (name, list, cls, depth) => {
    const t = tally(list);
    return `<button type="button" class="sr${cls}" data-a="strow" data-v="${name}"><span class="sn"${depth ? ` style="padding-left:${16 * depth}px"` : ''}>${name}</span><span class="sc">${t.n}局 ${wl(t)}</span><b class="sv">${t.r}%</b><svg class="ic"><use href="#i-next"/></svg><span class="sbar${t.w ? (t.r === 100 ? ' f' : '') : ' z'}"><i style="width:${t.r}%"></i></span></button>`;
  };
  if (dim === 'mycs') {
    const names = uniq(gs.flatMap((g) => myTags(g).cs)), of = (n) => gs.filter((g) => myTags(g).cs.includes(n));
    const emit = (n, depth) => { h += row(n, of(n), depth ? ' kid' : '', depth); names.filter((k) => CS_PARENT[k] === n).forEach((k) => emit(k, depth + 1)); };
    names.filter((n) => !names.includes(CS_PARENT[n])).sort((a, b) => of(b).length - of(a).length).forEach((n) => emit(n, 0));
  } else {
    for (const fam of ['居飛車', '振り飛車']) {
      const fg = gs.filter((g) => tagOf(g).st[0] === fam);
      if (!fg.length) continue;
      h += row(fam, fg, '', 0);
      const of = (n) => fg.filter((g) => tagOf(g).st.includes(n));
      uniq(fg.flatMap((g) => tagOf(g).st.slice(1))).sort((a, b) => of(b).length - of(a).length).forEach((n) => { h += row(n, of(n), ' kid', 1); });
    }
  }
  const un = gs.filter((g) => (dim === 'mycs' ? !myTags(g).cs.length : !tagOf(g).st.length));
  if (un.length) h += row('未分類', un, ' un', 0);
  return h || '<p class="empty">対局がありません。</p>';
}
const statGames = () => DB.games.filter((g) => g.self && (!UI.st.period || daysAgo(g.date) <= +UI.st.period) && (!UI.st.side || g.self === UI.st.side));
function statsTab() {
  const st = UI.st, gs = statGames(), t = tally(gs);
  const seg = (key, opts) => `<div class="sg s" role="group">${opts.map(([v, l]) => `<button type="button" data-a="stset" data-v="${key}:${v}" aria-pressed="${st[key] === v}">${l}</button>`).join('')}</div>`;
  const chron = [...gs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const half = (label, list) => { const x = tally(list); return `<span>${label}</span><span class="sbar${x.w ? (x.r === 100 ? ' f' : '') : ' z'}"><i style="width:${x.r}%"></i></span><span>${wl(x)}</span>`; };
  const DOT = { w: '', l: 'l', d: 'd', u: 'u' };
  if (!DB.games.some((g) => g.self)) {
    return `<header class="ab"><h2>戦績</h2></header><div class="emp">${pic('sys-empty', 'empi')}<h3>まだ集計できる対局がありません</h3><p>自分の対局を取り込むと、勝率や、戦法・囲いごとの成績がここに出ます。</p><button type="button" class="bt pri" data-a="nav" data-v="import"><svg class="ic"><use href="#i-plus"/></svg>棋譜を取り込む</button></div>`;
  }
  if (!t.n) return `<header class="ab"><h2>戦績</h2></header><div class="pgc"><div class="frow">${seg('period', [['', '全期間'], ['90', '90日'], ['30', '30日']])}${seg('side', [['', '両方'], ['s', '先手'], ['g', '後手']])}</div><p class="empty">この条件の対局はありません。</p></div>`;
  return `<header class="ab"><h2>戦績</h2><span class="abn">自分の対局 ${t.n}局</span></header>
    <div class="pgc">
      <div class="frow">${seg('period', [['', '全期間'], ['90', '90日'], ['30', '30日']])}${seg('side', [['', '両方'], ['s', '先手'], ['g', '後手']])}</div>
      <div class="cd smy"><span class="dnt" style="background:conic-gradient(var(--you) 0 ${t.r}%, var(--opp) 0)"><span><b>${t.r}%</b><i>勝率</i></span></span><div class="big">${wl(t, ' ')}<small>${t.n}局</small></div><div class="hf">${half('☗先手', gs.filter((g) => g.self === 's'))}${half('☖後手', gs.filter((g) => g.self === 'g'))}</div></div>
      <h3 class="st">最近の勝敗（左が古い対局）</h3>
      <div class="cd hs">${chron.slice(-20).map((g) => `<i class="${DOT[resOf(g)]}" title="${dshort(g.date)} ${esc(oppName(g))}"></i>`).join('')}<div class="lg"><span><i></i>勝ち</span><span><i class="l"></i>負け</span>${t.d ? '<span><i class="d"></i>引き分け</span>' : ''}${t.u ? '<span><i class="u"></i>結果不明</span>' : ''}</div></div>
      ${t.d || t.u ? '<p class="hint">引き分けと、結果がわからない対局は、勝率に数えていません。</p>' : ''}
      <h3 class="st">勝率の移り変わり（直近10局ごと）</h3>
      <div class="cd tr" data-b2="trend">${trendSVG(chron)}</div>
      <h3 class="st">戦法・囲いごとの成績</h3>
      <div class="sg" role="group">${[['myst', '自分の戦法'], ['opst', '相手の戦法'], ['mycs', '自分の囲い']].map(([v, l]) => `<button type="button" data-a="stset" data-v="dim:${v}" aria-pressed="${st.dim === v}">${l}</button>`).join('')}</div>
      <div class="cd srs" style="margin-top:10px">${statRows(gs, st.dim)}</div>
      <p class="hint">行をタップすると、その対局の一覧が開きます。複数の戦法や囲いに当てはまる対局は、それぞれの行に数えます（合計の対局数は重複しません）。</p>
      <p class="hint">戦法や囲いの判定がちがうときは、対局を開いて「…」→「対局情報」から直せます。</p>
    </div>`;
}
A.stset = (v) => { const i = v.indexOf(':'); UI.st[v.slice(0, i)] = v.slice(i + 1); show(); };
A.strow = (name) => {
  const dim = UI.st.dim, lab = { myst: '自分の戦法', opst: '相手の戦法', mycs: '自分の囲い' }[dim];
  push({ t: 'flist', title: name, lab, f: { scope: 'self', [dim]: name, period: UI.st.period, side: UI.st.side } });
};
function flistPage(t) {
  const gs = DB.games.filter((g) => gameMatch(g, t.f)), x = tally(gs);
  return { title: esc(t.title), sub: `${t.lab}・${x.n}局 ${wl(x)}`, html: `<div class="gl">${listHTML(gs)}</div>` };
}
SCR.addEventListener('pointermove', (e) => {
  const box = e.target.closest('[data-b2="trend"]');
  if (!box || !TREND) return;
  const svg = box.querySelector('svg'), tip = box.querySelector('.g-tip'), hv = box.querySelector('.t-hv');
  if (!svg || !tip) return;
  const r = svg.getBoundingClientRect(), T = TREND, x = ((e.clientX - r.left) / r.width) * T.W;
  const k = Math.max(0, Math.min(T.pts.length - 1, Math.round(((x - T.pl) / (T.W - T.pl - T.pr)) * (T.pts.length - 1)))), p = T.pts[k], q = dparts(p.d);
  hv.setAttribute('x1', T.X(k)); hv.setAttribute('x2', T.X(k)); hv.setAttribute('visibility', 'visible');
  tip.firstChild.textContent = p.r + '%';
  tip.lastChild.textContent = `${q.m}/${q.d} までの${p.n}局`;
  tip.style.left = Math.max(70, Math.min(r.width - 70, (T.X(k) / T.W) * r.width)) + 'px';
  tip.style.top = '6px';
  tip.hidden = false;
});
SCR.addEventListener('pointerout', (e) => {
  const box = e.target.closest('[data-b2="trend"]');
  if (!box || (e.relatedTarget && box.contains(e.relatedTarget))) return;
  const tip = box.querySelector('.g-tip'), hv = box.querySelector('.t-hv');
  if (tip) tip.hidden = true;
  if (hv) hv.setAttribute('visibility', 'hidden');
});

/* ---------- tab: settings, and its pages ----------
   The analysis engine and its evaluation function are never named in the app: naming the evaluation
   function in the service carries a fee, and the decision is to leave both names out. ---------- */
const meter = (label, used, max, unit, note) => `<div class="mtr"><span>${label}</span><b>${used} / ${max}${unit}</b><div class="mt"><i style="width:${Math.min(100, (100 * used) / max)}%"></i></div>${note ? `<small>${note}</small>` : ''}</div>`;
function settingsTab() {
  const u = DB.usage;
  const plan = paid()
    ? `<div class="cd plc"><div class="pn"><b>有料プラン</b><i>利用中</i></div>${meter('精密解析（今週）', u.precise, u.preciseMax, '局')}${meter('解析の合計（今週）', u.total, u.totalMax, '局', '合計には精密解析も含みます。毎週 月曜の午前0時（日本時間）に 0 に戻ります')}<button type="button" class="bt sm wide" data-a="nav" data-v="plan">プランの内容を見る</button></div>`
    : `<div class="cd plc"><div class="pn"><b>無料プラン</b></div>${meter('今週の解析', u.free, u.freeMax, '局', '毎週 月曜の午前0時（日本時間）に 0 に戻ります')}<button type="button" class="bt sm wide" data-a="nav" data-v="plan">有料プランを見る</button><div class="lnk"><button type="button" class="tx-b" data-a="restorebuy">購入を復元</button></div></div>`;
  const row = (v, icon, title, sub) => `<button type="button" class="rw" data-a="nav" data-v="${v}"><span class="ri"><svg class="ic"><use href="#${icon}"/></svg></span><span class="rx"><b>${title}</b><span>${sub}</span></span><svg class="ic"><use href="#i-next"/></svg></button>`;
  return `<header class="ab"><h2>設定</h2></header><div class="pgc">${plan}
    <h3 class="st">対局と解説</h3>
    <div class="cd">${row('names', 'i-user', '自分の対局者名', esc(DB.names.join('、')) || '未登録')}${row('profile', 'i-flag', '学習プロフィール', `練習中の戦法：${DB.profile.practice.join('・') || 'なし'}`)}</div>
    <h3 class="st">データ</h3>
    <div class="cd">${row('backup', 'i-box', 'バックアップと復元', '機種変更のときはここから')}</div>
    <h3 class="st">このアプリ</h3>
    <div class="cd"><button type="button" class="rw" data-a="replay"><span class="ri"><svg class="ic"><use href="#i-play"/></svg></span><span class="rx"><b>使い方をもう一度見る</b><span>はじめの紹介を最初から</span></span><svg class="ic"><use href="#i-next"/></svg></button>${row('about', 'i-info', 'このアプリについて', 'バージョン・ライセンス')}</div></div>`;
}
function namesPage() {
  return { title: '自分の対局者名', html: `<div class="pgc"><p class="hint" style="margin:0 4px 10px">棋譜に書かれた対局者名と照らし合わせて、あなたが先手か後手か、勝ったか負けたかを判定します。名前はいくつでも登録できます。この端末の中だけで使い、サーバーには送りません。</p>
    <div class="cd">${DB.names.map((n, i) => `<div class="nmrow"><b>${esc(n)}</b><button type="button" data-a="namedel" data-v="${i}" aria-label="${esc(n)} を削除"><svg class="ic"><use href="#i-x"/></svg></button></div>`).join('') || '<p class="empty">まだ登録がありません。</p>'}</div>
    <form class="addr" data-f="name"><input id="name-in" class="inp" placeholder="対局者名を追加" autocomplete="off" maxlength="30" aria-label="追加する対局者名"><button type="submit" class="bt pri">追加</button></form>
    <p class="hint">どの名前にも当てはまらない棋譜や、先手と後手の両方に当てはまる棋譜は、取り込むときにどちらかを選べます。</p>
    <p class="hint">名前を外しても、取り込み済みの棋譜の勝ち負けは変わりません。これから取り込む棋譜で、自動では見分けなくなります。</p></div>` };
}
A.namedel = (i) => {
  const n = DB.names.splice(+i, 1)[0];
  show();
  toast(`「${n}」を外しました`, { label: '元に戻す', fn: () => { DB.names.splice(+i, 0, n); show(); } });
};
function profilePage() {
  const pr = DB.profile, all = PRACTICE;
  return { title: '学習プロフィール', html: `<div class="pgc">${paid() ? '' : '<p class="mockn" style="margin:0 0 10px">AIコーチ（有料プラン）の解説に使われる設定です。</p>'}
    <h3 class="st">練習中の戦法（いくつでも）</h3><div class="opt">${all.map((s) => `<button type="button" class="ch mul" data-a="pract" data-v="${s}" aria-pressed="${pr.practice.includes(s)}">${s}</button>`).join('')}</div>
    <h3 class="st">目標</h3><textarea id="goal-in" class="ta" style="height:92px" maxlength="200" aria-label="目標" placeholder="例：初段になりたい、終盤を強くしたい">${esc(pr.goal)}</textarea>
    <h3 class="st">いつもの解説スタイル</h3>${fl('どこを中心に')}<div class="opt">${FOCUS.map((x) => `<button type="button" class="ch" data-a="dfocus" data-v="${x}" aria-pressed="${DB.style.focus === x}">${x}</button>`).join('')}</div>
    ${fl('詳しさ')}<div class="sg" role="group" aria-label="詳しさ">${DETAIL.map((x) => `<button type="button" data-a="ddetail" data-v="${x}" aria-pressed="${DB.style.detail === x}">${x}</button>`).join('')}</div>
    <p class="hint">変更はすぐに保存され、次に作る解説から反映されます。解説を作るときに、その対局だけ別のスタイルにもできます。</p></div>` };
}
A.pract = (v) => { const a = DB.profile.practice, i = a.indexOf(v); if (i >= 0) a.splice(i, 1); else a.push(v); show(); };
A.dfocus = (v) => { DB.style.focus = v; show(); };
A.ddetail = (v) => { DB.style.detail = v; show(); };
function backupPage() {
  const n = DB.games.length;
  return { title: 'バックアップと復元', html: `<div class="pgc">
    <div class="cd bkc"><b>バックアップを書き出す</b><p>棋譜 ${n}局、解析結果、戦法と囲いの修正、AIコーチの解説と質問の履歴、学習プロフィール、設定を、1つのファイルにまとめます。</p><button type="button" class="bt pri wide" data-a="bkout"><svg class="ic"><use href="#i-export"/></svg>書き出す</button><small class="bkd">${DB.first ? 'まだ書き出していません' : '最後に書き出した日：2026年11月2日'}</small></div>
    <div class="cd bkc"><b>バックアップから復元する</b><p>書き出したファイルを選ぶと、中身を確かめてから、この端末のデータを置きかえます。iPhone と Android の間でも、棋譜や設定を移せます。</p><button type="button" class="bt wide" data-a="bkin"><svg class="ic"><use href="#i-file"/></svg>ファイルを選ぶ</button></div>
    <p class="hint">データはこの端末の中だけに保存されています。アカウント登録や自動の同期はありません。機種変更の前に、ここから書き出してください。</p>
    <p class="hint">有料プランの購入情報は、バックアップには入りません。同じ種類の端末どうし（iPhone から iPhone、Android から Android）なら、新しい端末の「有料プラン」画面の「購入を復元」で引き継げます。iPhone と Android の間では、有料プランは引き継げません。</p></div>` };
}
A.bkout = () => ask('バックアップを書き出しました', `kifumate-backup-${TODAY.replace(/-/g, '')}　棋譜 ${DB.games.length}局<br>実際のアプリでは、ここで保存先や共有先を選ぶ画面が開きます。`, 'OK', null, { single: true, img: 'sys-backup' });
/* restoring: choose the file first, see what is in it, then confirm replacing what is on this device */
A.bkin = () => ask('このバックアップで置きかえますか', `<b class="bkf">2026年11月2日のバックアップ（棋譜 22局）</b>いまこの端末にある棋譜 ${DB.games.length}局と設定は消えて、この内容に置きかわります。元には戻せません。`, '置きかえる', () => toast('復元しました（モックでは何も変わりません）'), { danger: true, img: 'sys-backup' });
function planPage() {
  const u = DB.usage, rowc = (a, b, c) => `<tr><td>${a}</td><td>${b}</td><td>${c}</td></tr>`;
  const ok = '<span class="ok"><svg class="ic"><use href="#i-check"/></svg></span>', no = '<span class="no">—</span>';
  const head = paid()
    ? `<div class="cd plc"><div class="pn"><b>有料プラン</b><i>利用中</i></div>${meter('精密解析（今週）', u.precise, u.preciseMax, '局')}${meter('解析の合計（今週）', u.total, u.totalMax, '局', '合計には精密解析も含みます。毎週 月曜の午前0時（日本時間）に 0 に戻ります')}</div>`
    : `<div class="cd pwl">${pic('onb-5', 'pwi')}<div><div class="prc"><small>月額</small>780<small>円</small></div><p>精密解析、分岐中の解析、AIコーチの解説と質問が使えます。</p></div></div>`;
  return { title: '有料プラン', html: `<div class="pgc">${head}
    <table class="cmp"><thead><tr><th>できること</th><th>無料</th><th>有料</th></tr></thead><tbody>
      ${rowc('棋譜の保存・再生<br>戦績の集計', ok, ok)}
      ${rowc('対局の解析', `<b>ふつうの解析<br>週${u.freeMax}局</b><br>候補1手`, `<b>精密解析<br>週${u.preciseMax}局</b><br>候補3手・深い読み<br>合計 週${u.totalMax}局`)}
      ${rowc('分岐して手を試す', ok, ok)}
      ${rowc('分岐中の解析', no, ok)}
      ${rowc('AIコーチ', no, '<b>解説と質問</b>')}
    </tbody></table>
    <p class="hint">分岐中の解析は月${u.rtMax}分（解析が動いている間を数えます）、AIコーチは月${u.aiMax}回まで使えます。残りが少なくなったら、お知らせします。</p>
    <p class="mockn"><b>モック</b>　価格は仮の数字です。週の区切り（月曜の午前0時）と、分岐中の解析・AIコーチの上限の期間（月ごと）は、仮に置いています。</p>
    <div class="acts">${paid() ? '<button type="button" class="bt wide" data-a="toast" data-v="実際のアプリでは、ストアの定期購入の画面が開きます">プランを管理する</button>' : '<button type="button" class="bt pri wide" data-a="subscribe">月額780円で登録する</button><small>毎月自動で更新されます。解約はいつでも、ストアの設定からできます。</small>'}</div>
    <div class="lnk"><button type="button" class="tx-b" data-a="restorebuy">購入を復元</button><button type="button" class="tx-b" data-a="toast" data-v="利用規約のページを開きます（モック）">利用規約</button><button type="button" class="tx-b" data-a="toast" data-v="プライバシーポリシーのページを開きます（モック）">プライバシーポリシー</button></div></div>` };
}
/* restoring a purchase has two outcomes: found (shown here) and nothing found */
A.restorebuy = () => {
  if (paid()) { ask('有料プランを利用中です', 'この端末では、すでに有料プランが使えます。', 'OK', null, { single: true }); return; }
  ask('購入を確認しますか', 'ストアに、このアカウントでの購入がないか問い合わせます。', '確認する', () => { DB.plan = 'paid'; syncPlan(); ask('有料プランを復元しました', '前に購入した有料プランが、この端末でも使えるようになりました。<br><span class="mk0">モック</span>購入が見つからないときは「復元できる購入が見つかりませんでした。購入したときと同じストアのアカウントか確かめてください。」と出します。', 'OK', null, { single: true }); }, { no: 'やめる' });
};
A.subscribe = () => { DB.plan = 'paid'; syncPlan(); toast('有料プランに登録しました（モック）'); };
function aboutPage() {
  const lnk = (t, v) => `<button type="button" class="rw" data-a="toast" data-v="${v}"><span class="rx"><b>${t}</b></span><svg class="ic"><use href="#i-next"/></svg></button>`;
  return { title: 'このアプリについて', html: `<div class="pgc"><div class="abt">${pic('app-icon', 'abic')}<div><b>kifumate</b><span>棋譜の記録と振り返り</span></div></div><div class="cd kv"><i>バージョン</i><span>0.1（モック）</span><i>データの保存</i><span>この端末の中だけ</span><i>棋譜の解析</i><span>サーバーで行います</span><i>サーバーに送るもの</i><span>解析する対局の指し手と、AIコーチに使う解析結果・学習プロフィール</span><i>送らないもの</i><span>対局者名</span></div>
    <div class="cd" style="margin-top:12px">${lnk('利用規約', '利用規約のページを開きます（モック）')}${lnk('プライバシーポリシー', 'プライバシーポリシーのページを開きます（モック）')}${lnk('お問い合わせ', 'お問い合わせのページを開きます（モック）')}<button type="button" class="rw" data-a="toast" data-v="ライセンス表示の画面を開きます（モック）"><span class="rx"><b>ライセンス</b><span>このアプリに含まれるソフトウェア</span></span><svg class="ic"><use href="#i-next"/></svg></button></div></div>` };
}
/* record details: who you are in it, and the strategy and castle tags with manual correction */
function infoPage(t) {
  const g = gameById(t.id);
  const side = (s) => {
    const tg = g.tags[s], mine = g.self === s, c = mine ? '' : ' op';
    return `<div class="tgb"><div class="th"><span class="av${mine ? ' y' : ''}">${s === 's' ? '☗' : '☖'}</span>${esc(s === 's' ? g.sente : g.gote)}${mine ? '（あなた）' : ''}<em>${tg.edited ? '手で修正' : '自動判定'}</em></div><div class="tgl"><i>戦法</i><span class="tv">${stNames(tg).map((n) => `<span class="t${c}">${n}</span>`).join('') || '<span class="t un">未分類</span>'}</span><button type="button" class="ed" data-a="tagedit" data-v="${s}:st">修正</button><i>囲い</i><span class="tv">${tg.cs.map((n) => `<span class="t${c}">${n}</span>`).join('<span class="ar">→</span>') || '<span class="t un">未分類</span>'}</span><button type="button" class="ed" data-a="tagedit" data-v="${s}:cs">修正</button></div></div>`;
  };
  const an = RUN && RUN.id === g.id ? '解析中' : g.an === 'pre' ? '精密解析ずみ' : g.an === 'std' ? '解析ずみ' : 'まだ解析していません';
  return { title: '対局情報', html: `<div class="pgc"><div class="cd kv"><i>日付</i><span>${dlong(g.date)}</span><i>結果</i><span>${g.plies}手・${resText(g)}${g.win === 's' || g.win === 'g' ? `（${esc(g.end)}）` : ''}${g.winEdited ? '<em class="edm">手で修正</em>' : ''}<button type="button" class="ed" data-a="resedit">修正</button></span><i>解析</i><span>${an}</span></div>
    <h3 class="st">あなたはどちら</h3><div class="sg" role="group" aria-label="あなたはどちら">${[['s', `☗ ${esc(g.sente)}`], ['g', `☖ ${esc(g.gote)}`], ['', '自分ではない']].map(([v, l]) => `<button type="button" data-a="gside" data-v="${v}" aria-pressed="${(g.self || '') === v}">${l}</button>`).join('')}</div>
    <p class="hint">登録した対局者名から自動で見分けています。ちがうときはここで直せます。「自分ではない」にすると、戦績には数えません。</p>
    <h3 class="st">戦法と囲い</h3><div class="cd">${side('s')}${side('g')}</div>
    <p class="hint">自動判定がちがうときは「修正」から直せます。分からないものは「未分類」のままにできます。囲いが途中で変わった対局は、通った形を順に記録します。</p></div>` };
}
A.gside = (v) => {
  const g = gameById(topNav().id);
  g.self = v || null;
  if (CUR === g) { const p = S.ply; loadGame(g); S.ply = p; }
  show();
};
/* the result: read from the record, corrected here when the record has none or has it wrong */
function resSheetHTML(g) {
  const opt = [['s', `☗ ${esc(g.sente)} の勝ち`], ['g', `☖ ${esc(g.gote)} の勝ち`], ['d', '引き分け'], ['u', 'わからない']];
  return `<div class="opt rows">${opt.map(([v, t]) => `<button type="button" class="ch" data-a="resset" data-v="${v}" aria-pressed="${g.win === v}">${t}</button>`).join('')}</div><p class="hint">棋譜に結果が書かれていないときや、ちがっているときに直せます。引き分けと「わからない」は、勝率に数えません。</p><div class="acts"><button type="button" class="bt pri wide" data-a="closesheet">これでよい</button></div>`;
}
A.resedit = () => { const g = gameById(topNav().id); openSheet('結果を直す', resSheetHTML(g), { auto: true, onClose: () => show() }); };
A.resset = (v) => { const g = gameById(topNav().id); g.win = v; g.winEdited = true; g._v = null; R.shc.innerHTML = resSheetHTML(g); };
let TE = null;
const keepAuto = (g) => { if (!g.autoTags) g.autoTags = JSON.parse(JSON.stringify(g.tags)); };
function tagSheetHTML() {
  const g = gameById(TE.id), tg = g.tags[TE.side];
  const done = `<div class="acts"><button type="button" class="bt pri wide" data-a="closesheet">これでよい</button>${tg.edited ? '<button type="button" class="tx-b" data-a="tagauto">自動判定に戻す</button>' : ''}</div>`;
  if (TE.kind === 'st') {
    const fam = tg.st[0] || '';
    return `<p class="optl">大きな分類</p><div class="sg" role="group">${['居飛車', '振り飛車', ''].map((f) => `<button type="button" data-a="tagfam" data-v="${f}" aria-pressed="${fam === f}">${f || '未分類'}</button>`).join('')}</div>`
      + (fam ? `<p class="optl" style="margin-top:14px">戦法（当てはまるものをいくつでも）</p><div class="opt">${ST_MASTER[fam].map((n) => `<button type="button" class="ch mul" data-a="tagtog" data-v="${n}" aria-pressed="${tg.st.includes(n)}">${n}</button>`).join('')}</div>` : '<p class="hint">分からないときは「未分類」のままにできます。</p>') + done;
  }
  return `<p class="optl">囲い（組んだ順にタップ。途中で変わったものも選べます）</p><div class="opt">${CS_MASTER.map((n) => `<button type="button" class="ch mul" data-a="tagtog" data-v="${n}" aria-pressed="${tg.cs.includes(n)}">${tg.cs.includes(n) && tg.cs.length > 1 ? `<span class="n k">${tg.cs.indexOf(n) + 1}</span>` : ''}${n}</button>`).join('')}</div><p class="hint">いまの記録：${tg.cs.join(' → ') || '未分類'}</p>` + done;
}
A.tagedit = (v) => {
  const [side, kind] = v.split(':'), g = gameById(topNav().id);
  TE = { id: g.id, side, kind };
  openSheet(`${side === 's' ? '☗' : '☖'} ${side === 's' ? g.sente : g.gote} の${kind === 'st' ? '戦法' : '囲い'}`, tagSheetHTML(), { auto: true, onClose: () => show() });
};
A.tagfam = (v) => { const g = gameById(TE.id), tg = g.tags[TE.side]; keepAuto(g); tg.st = v ? [v] : []; tg.edited = true; R.shc.innerHTML = tagSheetHTML(); };
A.tagauto = () => { const g = gameById(TE.id); g.tags[TE.side] = JSON.parse(JSON.stringify(g.autoTags[TE.side])); R.shc.innerHTML = tagSheetHTML(); };
A.tagtog = (v) => {
  const g = gameById(TE.id), tg = g.tags[TE.side];
  keepAuto(g);
  const list = TE.kind === 'st' ? tg.st : tg.cs, i = list.indexOf(v);
  if (i >= (TE.kind === 'st' ? 1 : 0)) list.splice(i, 1); else list.push(v);
  tg.edited = true;
  R.shc.innerHTML = tagSheetHTML();
};

/* ---------- rendering the tab screens and the pushed pages ---------- */
const TABS = { list: listTab, stats: statsTab, set: settingsTab };
function renderRoot(restore) {
  const old = R.tabc.querySelector('.gl, .pgc');
  const y = restore ? UI.scroll[UI.tab] || 0 : old && R.tabc.dataset.tab === UI.tab ? old.scrollTop : 0;
  R.tabc.dataset.tab = UI.tab;
  R.tabc.innerHTML = TABS[UI.tab]();
  R.tb.querySelectorAll('button').forEach((b) => { if (b.dataset.v === UI.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  const el = R.tabc.querySelector('.gl, .pgc');
  if (el) el.scrollTop = y;
}
const PAGES = { import: importPage, flist: flistPage, names: namesPage, profile: profilePage, backup: backupPage, plan: planPage, about: aboutPage, info: infoPage };
function renderPage(t, restore) {
  const pg = PAGES[t.t](t), sel = '.pgc, .gl';
  const old = R.vpage.querySelector(sel), y = restore ? t.y || 0 : old && R.vpage.dataset.key === t.t ? old.scrollTop : 0;
  R.vpage.dataset.key = t.t;
  R.vpage.innerHTML = `<header class="ph"><button type="button" class="rb" data-a="back" aria-label="${pg.close ? '閉じる' : '戻る'}"><svg class="ic"><use href="#${pg.close ? 'i-x' : 'i-prev'}"/></svg></button><h2>${pg.title}${pg.sub ? `<small>${pg.sub}</small>` : ''}</h2></header>${pg.html}`;
  const now = R.vpage.querySelector(sel);
  if (now) now.scrollTop = y;
}
