/* ---------- AI commentary and chat (paid). The text is assembled from the analysis data: the real
   app would have the language model write it, grounded in the same numbers. ---------- */
const AI = { open: false, full: false, gen: false, setup: false, focus: '総合', detail: 'ふつう' };

function openAI() {
  AI.open = true; AI.full = false; AI.setup = false;
  AI.focus = DB.style.focus; AI.detail = DB.style.detail;
  R.aiw.hidden = false;
  renderAI();
}
function closeAI() {
  if (!AI.open) return;
  AI.open = false;
  R.aiw.hidden = true;
}
/* While reading, half height leaves the whole board in view, so a move named in the text can be
   shown on it. Before there is a commentary, the sheet is as tall as what it has to say. */
function layoutAI() {
  if (!AI.open) return;
  const ready = aiStage() === 'ready', s = SCR.getBoundingClientRect(), b = R.youid.parentElement.getBoundingClientRect();
  R.aiw.style.height = !ready ? 'auto' : AI.full ? '92%' : Math.max(236, Math.round(s.bottom - b.bottom - 3)) + 'px';
  R.aiex.hidden = !ready;
  R.aiex.setAttribute('aria-label', AI.full ? '小さくする' : '大きくする');
  R.aiex.innerHTML = `<svg class="ic"><use href="#${AI.full ? 'i-down' : 'i-expand'}"/></svg>`;
}
function setAIFull(on) { AI.full = on; layoutAI(); }
const aiStage = () => (!paid() ? 'lock' : CUR.an === 'none' || (RUN && RUN.id === CUR.id) ? 'need' : AI.gen ? 'gen' : CUR.ai && !AI.setup ? 'ready' : 'setup');

/* ---------- facts taken from the analysis ---------- */
const ref = (i) => `<button type="button" class="mref" data-a="jump" data-v="${i}">${i}手目 ${mv(P[i].move.ja)}</button>`;
const before = (i) => `<button type="button" class="mref pre" data-a="jump" data-v="${i - 1}">指す前の局面</button>`;
const swing = (i) => `${fmtVal(P[i - 1])} → ${fmtVal(P[i])}`;
const blk = (title, src, ps, adv) => `<section class="blk${adv ? ' adv' : ''}"><h4>${title}<i>${src}</i></h4>${ps.map((p) => `<p>${p}</p>`).join('')}</section>`;
const ENG = '解析結果より', ADV = '学習プロフィールより';
function aiFacts() {
  const mine = (p) => moverSide(p.ply) === SELF, all = P.slice(1);
  const errs = all.filter((p) => p.mark === '悪手' || p.mark === '疑問手');
  const byLoss = (a, b) => b.loss - a.loss;
  let mateFrom = N;
  while (mateFrom > 1 && P[mateFrom - 1].mate != null && (P[mateFrom - 1].mate > 0) === (M.winner === 'sente')) mateFrom--;
  return {
    won: winnerSide() === SELF, mine,
    my: errs.filter(mine).sort(byLoss), their: errs.filter((p) => !mine(p)).sort(byLoss),
    good: all.filter((p) => p.mark === '好手' && mine(p)),
    missed: all.filter((p) => p.missedTsume && mine(p)),
    tsume: P.filter((p) => p.tsume), mateFrom,
  };
}
const whose = (f, p) => (f.mine(p) ? YOU() : OPP());
const tagText = (t) => (stNames(t).join('・') || '未分類') + (t.cs.length ? `、囲いは${t.cs.join(' → ')}` : '');
function openingLine() {
  const b = PH[0].b;
  let lo = 0, hi = 0;
  for (let i = 0; i <= b; i++) { const v = valOf(P[i]); lo = Math.min(lo, v); hi = Math.max(hi, v); }
  return Math.max(-lo, hi) < 450 ? `序盤（${b}手目まで）は評価値が ${sgn(lo)} 〜 ${sgn(hi)} の範囲で、ほぼ互角でした。` : `序盤（${b}手目まで）の終わりの評価値は ${fmtVal(P[b])} でした。`;
}
function secSummary(f) {
  const ps = [`${N}手で${f.won ? YOU() : OPP()}の勝ち（${esc(M.endReason)}）でした。${openingLine()}`];
  const big = [...f.my.slice(0, 2), ...f.their.slice(0, 2)].sort((a, b) => a.ply - b.ply);
  if (big.length) ps.push('形勢が大きく動いた手：' + big.map((p) => `${ref(p.ply)}（${whose(f, p)}の${p.mark}、${swing(p.ply)}）`).join('　'));
  return blk('この対局のまとめ', ENG, ps);
}
function secGood(f) {
  if (!f.good.length) return '';
  return blk('良かった手', ENG, [f.good.map((p) => ref(p.ply)).join(' ') + ' は好手でした。解析の最善手と同じ手を指せています。']);
}
function secFix(f, k, withPv, title) {
  const list = f.my.slice(0, k).sort((a, b) => a.ply - b.ply);
  if (!list.length) return blk(title || '直したい手', ENG, ['悪手・疑問手と判定された手はありませんでした。']);
  return blk(title || '直したい手', ENG, list.map((p) => {
    const best = (P[p.ply - 1].cands || [])[0];
    let t = `${ref(p.ply)}（${p.mark}）　評価値 ${swing(p.ply)}。`;
    if (best && best.usi !== p.move.usi) {
      t += `解析の最善手は ${mv(best.ja)} でした。`;
      if (withPv && best.pv.length > 1) t += `以下 ${best.pv.slice(1, 4).map(mv).join(' ')} と進む読み筋です。`;
    }
    return t + ' ' + before(p.ply);
  }));
}
function secEnd(f) {
  const ps = f.missed.map((p) => {
    const ts = P[p.ply - 1].tsume;
    return `${p.ply - 1}手目の局面に${ts.len}手詰めがありました（${ts.line.map((x) => mv(x.ja)).join(' ')}）。実戦の ${ref(p.ply)} では詰みを逃しています。 ${before(p.ply)}`;
  });
  if (f.won) { if (P[N - 1].mate != null) ps.push(`最後は ${ref(N)} まで、詰みを決めて勝ちました。`); }
  else if (f.mateFrom < N) ps.push(`${ref(f.mateFrom)} のあとは${OPP()}に詰み筋があり、そのまま寄せ切られました。`);
  if (!ps.length) ps.push('終盤に、詰みの見逃しは見つかりませんでした。');
  ps.push('<small>詰みは、解析で証明できた1手詰め・3手詰めだけを示しています。</small>');
  return blk('終盤', ENG, ps);
}
function secOpening(f) {
  const ps = [`${YOU()}は${tagText(CUR.tags[SELF])}。${OPP()}は${tagText(CUR.tags[OTHER])}でした。`, openingLine()];
  const first = P.slice(1).find((p) => p.mark === '悪手' || p.mark === '疑問手');
  if (first) ps.push(`最初に形勢が動いたのは ${ref(first.ply)}（${whose(f, first)}の${first.mark}、${swing(first.ply)}）です。`);
  ps.push('<small>戦法と囲いは自動判定の結果です。対局情報から直せます。</small>');
  return blk('序盤の駒組み', ENG, ps);
}
function secMiddle(f, k) {
  const ph = PH[1];
  if (!ph) return blk('中盤の攻防', ENG, ['この対局は序盤のまま終わりました。']);
  const list = [...f.my, ...f.their].filter((p) => p.ply >= ph.a && p.ply <= ph.b).slice(0, k).sort((a, b) => a.ply - b.ply);
  const ps = [`中盤（${ph.a}〜${ph.b}手目）は、評価値が ${fmtVal(P[ph.a - 1])} から ${fmtVal(P[ph.b])} に動きました。`];
  list.forEach((p) => {
    const best = (P[p.ply - 1].cands || [])[0];
    ps.push(`${ref(p.ply)}（${whose(f, p)}の${p.mark}、${swing(p.ply)}）${best && best.usi !== p.move.usi ? `　解析の最善手は ${mv(best.ja)}。` : ''}`);
  });
  return blk('中盤の攻防', ENG, ps);
}
function secAdvice(f) {
  const pr = DB.profile, mine = CUR.tags[SELF], theirs = CUR.tags[OTHER], ps = [];
  const hitMine = pr.practice.filter((s) => mine.st.includes(s)), hitOpp = pr.practice.filter((s) => theirs.st.includes(s));
  if (!OWN) ps.push('自分以外の対局です。気になった局面は、盤で手を進めて確かめられます。');
  else if (hitMine.length) ps.push(`練習中の「${hitMine.join('・')}」を指した一局です。${mine.cs.length > 1 ? `囲いを ${mine.cs.join(' → ')} と発展させられました。` : ''}同じ戦法の対局は、戦績の画面でまとめて振り返れます。`);
  else if (hitOpp.length) ps.push(`相手が、あなたの練習中の「${hitOpp.join('・')}」を指した一局です。相手の駒組みを見ておくと、自分で指すときの参考になります。`);
  else if (pr.practice.length) ps.push(`練習中の戦法（${pr.practice.join('・')}）とは別の戦型でした。`);
  if (OWN && pr.goal) {
    ps.push(`目標「${esc(pr.goal)}」に向けて：` + (f.missed.length ? `この対局では詰みを${f.missed.length}回逃しました。1手詰め・3手詰めを毎日数問解くと、終盤で勝ち切りやすくなります。`
      : f.my.length ? `まずは ${ref(f.my[0].ply)} のように評価値を大きく下げる手を、1局に1つ減らすことを目指しましょう。` : 'この対局は大きなミスなく指せています。'));
  }
  return ps.length ? blk('あなたへのアドバイス', ADV, ps, true) : '';
}
function commentary(focus, detail) {
  const f = aiFacts(), k = detail === 'かんたん' ? 1 : detail === 'ふつう' ? 2 : 4, pv = detail !== 'かんたん';
  let h;
  if (focus === '序盤の駒組み') h = secOpening(f);
  else if (focus === '中盤の攻防') h = secMiddle(f, k * 2);
  else if (focus === '終盤') h = secEnd(f) + secFix({ ...f, my: f.my.filter((p) => PH[2] && p.ply >= PH[2].a) }, k, pv, '終盤で直したい手');
  else if (focus === '悪手・改善点') h = secFix(f, detail === 'くわしく' ? 99 : k * 2, pv) + secGood(f);
  else h = secSummary(f) + secGood(f) + secFix(f, k, pv) + secEnd(f);
  return h + secAdvice(f);
}
function aiQuestions() {
  const f = aiFacts(), qs = [];
  if (f.my[0]) {
    const p = f.my[0], best = (P[p.ply - 1].cands || [])[0];
    qs.push({ q: `${p.ply}手目はどう指せばよかった？`, face: 'chat-idea', a: () => blk('答え', ENG, [
      `${before(p.ply)} での解析の最善手は ${mv(best.ja)}（評価値 ${fmtVal(best)}）です。読み筋は ${best.pv.map(mv).join(' ')}。`,
      `実戦の ${ref(p.ply)} は評価値 ${fmtVal(P[p.ply])} になりました。指す前の局面を開いて「試す」を押すと、この読み筋を盤の上で進められます。`]) });
  }
  if (f.tsume.length) {
    qs.push({ q: '詰みがあった局面を教えて', a: () => blk('答え', ENG, [...f.tsume.map((p) => {
      const nx = P[p.ply + 1], who = turnSide(p.ply) === SELF ? YOU() : OPP();
      return `<button type="button" class="mref pre" data-a="jump" data-v="${p.ply}">${p.ply}手目の局面</button> ${who}に${p.tsume.len}手詰め（${p.tsume.line.map((x) => mv(x.ja)).join(' ')}）。${nx && nx.missedTsume ? '実戦では逃しました。' : '実戦でもこの手を指しています。'}`;
    }), '<small>解析で証明できた1手詰め・3手詰めだけを挙げています。</small>']) });
  }
  qs.push({ q: '次に何を練習するといい？', face: 'chat-cheer', a: () => blk('答え', ADV, [
    `この対局で評価値を大きく下げた手は${f.my.length}回${f.missed.length ? `、詰みの見逃しは${f.missed.length}回` : ''}でした。`,
    f.missed.length ? '学習目標に合わせると、いまは短い詰将棋（1手・3手）を続けるのが近道です。' : f.my.length ? `${ref(f.my[0].ply)} の局面を、分岐で指し直して確かめてみましょう。相手の手を自分で指してみると、ねらいが分かりやすくなります。` : '同じ戦法の対局を続けて、形に慣れていきましょう。'], true) });
  return qs;
}

/* ---------- rendering ---------- */
function aiBody(st) {
  if (st === 'lock') return `<div class="lk">${pic('onb-5', 'lkim')}<b>AIコーチは有料プランの機能です</b><span>解析結果をもとに、対局の流れと改善点を文章で解説します。続けてチャットで質問できます。</span><button type="button" class="bt you sm" data-a="nav" data-v="plan">有料プランを見る</button></div>`;
  if (st === 'need') {
    const running = RUN && RUN.id === CUR.id;
    return `<div class="lk"><svg class="ic"><use href="#i-spark"/></svg><b>${running ? '解析が終わると、解説を作れます' : '解説には、解析結果が必要です'}</b><span>AIは、解析で出た評価値・候補手・詰みをもとに解説します。</span>${running ? '' : '<button type="button" class="bt pri sm" data-a="aianalyze">この対局を解析する</button>'}</div>`;
  }
  if (st === 'gen') return '<p class="ail">解説を作っています…</p>' + '<div class="skl"></div>'.repeat(3) + '<div class="skl" style="width:62%"></div>' + '<div class="skl" style="margin-top:20px"></div><div class="skl" style="width:80%"></div>';
  if (st === 'setup') {
    const pr = DB.profile;
    return `<p class="ail">どこを中心に解説しますか</p><div class="chw">${FOCUS.map((x) => `<button type="button" class="ch" data-a="aifocus" data-v="${x}" aria-pressed="${AI.focus === x}">${x}</button>`).join('')}</div>
      <p class="ail">詳しさ</p><div class="sg" role="group">${DETAIL.map((x) => `<button type="button" data-a="aidetail" data-v="${x}" aria-pressed="${AI.detail === x}">${x}</button>`).join('')}</div>
      <div class="prf"><div><b>学習プロフィール</b>練習中：${pr.practice.join('・') || 'なし'}${pr.goal ? `<br>目標：${esc(pr.goal)}` : ''}</div><button type="button" class="tx-b" data-a="nav" data-v="profile">変更</button></div>
      <div class="acts" style="margin-top:0"><button type="button" class="bt pri wide" data-a="aigen"><svg class="ic"><use href="#i-spark"/></svg>解説をつくる</button>${CUR.ai ? '<button type="button" class="tx-b" data-a="aicancel">いまの解説に戻る</button>' : ''}</div>`;
  }
  const ai = CUR.ai, qs = aiQuestions().filter((x) => !ai.chat.some((c) => c.q === x.q));
  let h = ai.html + '<p class="ain">評価値・候補手・詰みは解析結果の値です。文章はAIが作ります（このモックの文章は、解析データから組み立てたサンプルです）。</p>';
  ai.chat.forEach((c) => { h += `<p class="cq">${esc(c.q)}</p><div class="ca">${pic(c.a ? c.face : 'chat-thinking', 'cav')}<div>${c.a || '<section class="blk"><span class="dots"><i></i><i></i><i></i></span></section>'}</div></div>`; });
  if (qs.length) h += `<div class="sqs">${qs.map((x) => `<button type="button" class="sq" data-a="aiask" data-v="${esc(x.q)}">${esc(x.q)}</button>`).join('')}</div>`;
  return h;
}
const AI_FACE = { lock: 'chat-default', need: 'chat-default', setup: 'chat-listening', gen: 'chat-thinking', ready: 'chat-explaining' };
function renderAI(keepScroll) {
  if (!AI.open) return;
  const st = aiStage(), y = R.aim.scrollTop;
  R.aiav.src = IMG[AI_FACE[st]] || '';
  R.aisty.hidden = st !== 'ready';
  if (st === 'ready') R.aisty.innerHTML = `${CUR.ai.focus}・${CUR.ai.detail}<svg class="ic"><use href="#i-refresh"/></svg>`;
  R.aif.hidden = st !== 'ready';
  R.aim.innerHTML = aiBody(st);
  R.aim.scrollTop = keepScroll ? y : 0;
  layoutAI();
}
function askAI(q, answer, face) {
  const gm = CUR, c = { q, a: '', face: face || 'chat-explaining' };
  gm.ai.chat.push(c);
  renderAI(true);
  R.aim.scrollTop = R.aim.scrollHeight;
  setTimeout(() => {
    c.a = answer();
    if (AI.open && CUR === gm) { renderAI(true); const qsEl = R.aim.querySelectorAll('.cq'); const last = qsEl[qsEl.length - 1]; if (last) R.aim.scrollTop = last.offsetTop - 6; }
  }, 900);
}
A.ai = () => { clearPick(); openAI(); };
A.aiclose = closeAI;
A.aisize = () => setAIFull(!AI.full);
A.aifocus = (v) => { AI.focus = v; renderAI(true); };
A.aidetail = (v) => { AI.detail = v; renderAI(true); };
A.aistyle = () => { AI.setup = true; AI.focus = CUR.ai.focus; AI.detail = CUR.ai.detail; renderAI(); };
A.aicancel = () => { AI.setup = false; renderAI(); };
A.aianalyze = () => { closeAI(); startAnalysis(CUR, paid() ? S.kind : 'std'); };
A.aigen = () => {
  const gm = CUR;
  AI.gen = true; AI.setup = false;
  renderAI();
  setTimeout(() => {
    AI.gen = false;
    if (CUR !== gm) return;
    gm.ai = { focus: AI.focus, detail: AI.detail, html: commentary(AI.focus, AI.detail), chat: [] };
    renderAI();
  }, 1500);
};
A.aiask = (q) => { const x = aiQuestions().find((o) => o.q === q); if (x) askAI(x.q, x.a, x.face); };
SCR.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target.dataset.f;
  if (f === 'ai') {
    const inp = document.getElementById('ai-q'), q = inp.value.trim();
    if (!q || !CUR || !CUR.ai) return;
    inp.value = '';
    const x = aiQuestions().find((o) => o.q === q);
    askAI(q, x ? x.a : () => blk('答え', 'モック', ['モックでは、下に出ている候補の質問にだけ答えます。実際のアプリでは、この対局の解析結果をもとにAIが答えます。']), x ? x.face : 'chat-listening');
  } else if (f === 'name') {
    const inp = document.getElementById('name-in'), n = inp.value.trim();
    if (!n) return;
    if (DB.names.includes(n)) { toast('その名前は登録済みです'); return; }
    DB.names.push(n);
    show();
    toast(`「${n}」を登録しました`);
  }
});
