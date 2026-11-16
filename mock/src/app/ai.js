/* ---------- The AI coach: commentary and questions (paid). The text here is assembled from the
   analysis data; the real app has the language model write it, grounded in the same numbers.
   Reading what was made stays possible on any plan; making new commentary or asking needs the plan. */
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
  R.vgame.classList.remove('aifull');
}
/* Two heights, the same in every state. Half: the sheet's top edge sits just under the lower name row,
   so the whole board stays in view and a move named in the text can be shown on it. Full: the top
   edge sits just under the win-rate header, covering the board completely (never cutting through it). */
function layoutAI() {
  if (!AI.open) return;
  const s = SCR.getBoundingClientRect(), b = R.youid.parentElement.getBoundingClientRect(), h = R.bar.parentElement.getBoundingClientRect();
  R.aiw.style.height = Math.round(AI.full ? s.bottom - h.bottom - 2 : Math.max(250, s.bottom - b.bottom - 3)) + 'px';
  R.vgame.classList.toggle('aifull', AI.full);
  R.aiex.setAttribute('aria-label', AI.full ? '小さくする' : '大きくする');
  R.aiex.innerHTML = `<svg class="ic"><use href="#${AI.full ? 'i-down' : 'i-expand'}"/></svg>`;
}
function setAIFull(on) { AI.full = on; layoutAI(); }
const aiStage = () => (AI.gen ? 'gen' : CUR.ai && !AI.setup ? 'ready' : !paid() ? 'lock' : CUR.an === 'none' || (RUN && RUN.id === CUR.id) ? 'need' : CUR.an !== 'pre' ? 'redo' : aiLeft() ? 'setup' : 'cap');

/* ---------- facts taken from the analysis ---------- */
/* a move named in the text: tapping it shows that position on the board. Yours are yellow, the opponent's blue. */
const ref = (i) => `<button type="button" class="mref${OWN && moverSide(i) !== SELF ? ' opp' : ''}" data-a="jump" data-v="${i}">${i}手目 ${mv(P[i].move.ja)}</button>`;
const before = (i) => `<button type="button" class="mref pre" data-a="jump" data-v="${i - 1}">指す前の局面</button>`;
const swing = (i) => `${fmtVal(P[i - 1])} → ${fmtVal(P[i])}`;
const blk = (title, src, ps, adv) => `<section class="blk${adv ? ' adv' : ''}"><h4>${title}<i>${src}</i></h4>${ps.map((p) => `<p>${p}</p>`).join('')}</section>`;
const ENG = '解析結果にもとづく説明', ADV = '学習プロフィールにもとづく助言';
function aiFacts() {
  const mine = (p) => moverSide(p.ply) === SELF, all = P.slice(1);
  const errs = all.filter((p) => p.mark === '悪手' || p.mark === '疑問手');
  const byLoss = (a, b) => b.loss - a.loss;
  return {
    won: winnerSide() === SELF, mine,
    my: errs.filter(mine).sort(byLoss), their: errs.filter((p) => !mine(p)).sort(byLoss),
    good: all.filter((p) => p.mark === '好手' && mine(p)),
    missed: all.filter((p) => p.missedTsume && mine(p)),
    tsume: P.filter((p) => p.tsume),
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
  const ps = [`${N}手で${resultText()}（${esc(M.endReason)}）でした。${openingLine()}`];
  const big = [...f.my.slice(0, 2), ...f.their.slice(0, 2)].sort((a, b) => a.ply - b.ply);
  if (big.length) ps.push('形勢が大きく動いた手：' + big.map((p) => `${ref(p.ply)}（${whose(f, p)}の${p.mark}、${swing(p.ply)}）`).join('　'));
  return blk('この対局のまとめ', ENG, ps);
}
function secGood(f) {
  if (!f.good.length) return '';
  return blk('良かった手', ENG, [f.good.map((p) => ref(p.ply)).join(' ') + ' は好手でした。解析のおすすめと同じ手を指せています。']);
}
function secFix(f, k, withPv, title) {
  const list = f.my.slice(0, k).sort((a, b) => a.ply - b.ply);
  if (!list.length) return blk(title || '直したい手', ENG, ['悪手・疑問手と判定された手はありませんでした。']);
  return blk(title || '直したい手', ENG, list.map((p) => {
    const best = (P[p.ply - 1].cands || [])[0];
    let t = `${ref(p.ply)}（${p.mark}）評価値 ${swing(p.ply)}。`;
    if (best && best.usi !== p.move.usi) {
      t += `解析のおすすめは ${mv(best.ja)} でした。`;
      if (withPv && best.pv.length > 1) t += `以下 ${best.pv.slice(1, 4).map(mv).join(' ')} と進む読み筋です。`;
    }
    return t + ' ' + before(p.ply);
  }));
}
function secEnd(f) {
  const ps = f.missed.map((p) => {
    const ts = P[p.ply - 1].tsume;
    return `${p.ply - 1}手目の局面に${ts.len}手詰めがありました（${ts.line.map((x) => mv(x.ja)).join(' ')}）。本譜の ${ref(p.ply)} では詰みを逃しています。 ${before(p.ply)}`;
  });
  /* only mates that were proven are called mates; anything else is described as a lead */
  const theirs = P.find((p) => p.tsume && turnSide(p.ply) !== SELF);
  if (f.won) { if (M.endReason === '詰み') ps.push(`最後は ${ref(N)} まで指して、詰ませて勝ちました。`); }
  else if (theirs) ps.push(`<button type="button" class="mref pre" data-a="jump" data-v="${theirs.ply}">${theirs.ply}手目の局面</button> で${OPP()}に${theirs.tsume.len}手詰めが生じ、そのまま詰まされました。`);
  else if (winnerSide()) ps.push(`終盤は${OPP()}が大きくリードしたまま、押し切られました。`);
  if (!ps.length) ps.push('終盤に、詰みの見逃しは見つかりませんでした。');
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
    ps.push(`${ref(p.ply)}（${whose(f, p)}の${p.mark}、${swing(p.ply)}）${best && best.usi !== p.move.usi ? ` 解析のおすすめは ${mv(best.ja)}。` : ''}`);
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
      `${before(p.ply)} での解析のおすすめは ${mv(best.ja)}（評価値 ${fmtVal(best)}）です。読み筋は ${best.pv.map(mv).join(' ')}。`,
      `本譜の ${ref(p.ply)} は評価値 ${fmtVal(P[p.ply])} になりました。指す前の局面を開いて「試す」を押すと、この読み筋を盤の上で進められます。`]) });
  }
  if (f.tsume.length) {
    qs.push({ q: '詰みがあった局面を教えて', a: () => blk('答え', ENG, [...f.tsume.map((p) => {
      const nx = P[p.ply + 1], who = turnSide(p.ply) === SELF ? YOU() : OPP();
      return `<button type="button" class="mref pre" data-a="jump" data-v="${p.ply}">${p.ply}手目の局面</button> ${who}に${p.tsume.len}手詰め（${p.tsume.line.map((x) => mv(x.ja)).join(' ')}）。${nx && nx.missedTsume ? '本譜では逃しました。' : '本譜でもこの手を指しています。'}`;
    }), '<small>証明できた1手詰め・3手詰めだけを挙げています。</small>']) });
  }
  qs.push({ q: '次に何を練習するといい？', face: 'chat-cheer', a: () => blk('答え', ADV, [
    `この対局で評価値を大きく下げた手は${f.my.length}回${f.missed.length ? `、詰みの見逃しは${f.missed.length}回` : ''}でした。`,
    f.missed.length ? '学習目標に合わせると、いまは短い詰将棋（1手・3手）を続けるのが近道です。' : f.my.length ? `${ref(f.my[0].ply)} の局面を、分岐で指し直して確かめてみましょう。相手の手を自分で指してみると、ねらいが分かりやすくなります。` : '同じ戦法の対局を続けて、形に慣れていきましょう。'], true) });
  return qs;
}

/* a question about the position on the board right now, answered from the saved analysis of that move */
function posAnswer(i) {
  const p = P[i], ps = [], j = judge(p);
  const lead = !j.lv ? 'ほぼ互角' : (j.side === SELF ? YOU() : OPP()) + 'が' + JN[j.lv];
  ps.push(`${i ? ref(i) + ' の局面' : '開始局面'}の評価値は ${fmtVal(p)}（${lead}）です。`);
  if (i && p.mark) ps.push(`この手は${moverSide(i) === SELF ? YOU() : OPP()}の${p.mark}で、指す前の評価値は ${fmtVal(P[i - 1])} でした。`);
  if (p.tsume) ps.push(`この局面には、${turnSide(i) === SELF ? YOU() : OPP()}に${p.tsume.len}手詰めがあります（${p.tsume.line.map((x) => mv(x.ja)).join(' ')}）。`);
  else if (i < N && p.cands && p.cands[0]) ps.push(`ここでの${turnSide(i) === SELF ? YOU() + 'のおすすめ' : OPP() + 'の最善'}は ${mv(p.cands[0].ja)}。読み筋は ${p.cands[0].pv.map(mv).join(' ')}。`);
  return blk('答え', ENG, ps);
}

/* ---------- rendering ---------- */
const fl = (t) => `<p class="fl">${t}</p>`;
function aiBody(st) {
  if (st === 'lock') return `<div class="lk">${pic('onb-5', 'lkim')}<b>AIコーチは有料プランの機能です</b><span>解析結果をもとに、対局の流れと改善点を文章で説明します。続けて質問もできます。</span></div>`;
  if (st === 'need') {
    const running = RUN && RUN.id === CUR.id;
    return `<div class="lk">${pic('chat-default', 'lkav')}<b>${running ? '解析しています' : '先に、この対局の精密解析が必要です'}</b><span>${running ? (RUN.kind === 'pre' ? '解析が終わると、ここで解説を作れます。' : 'ふつうの解析をしています。AIコーチは、精密解析した対局で使えます。') : 'AIコーチは、精密解析で出た評価値・候補手・詰みをもとに説明します。'}</span></div>`;
  }
  if (st === 'cap') return `<div class="lk">${pic('sys-limit', 'lkim')}<b>今月のAIコーチは上限に達しました</b><span>月が変わると、また使えます。これまでに作った解説は、そのまま読めます。</span></div>`;
  if (st === 'redo') return `<div class="lk">${pic('chat-default', 'lkav')}<b>AIコーチは、精密解析した対局で使えます</b><span>この対局は「ふつうの解析」です。精密解析でやり直すと、候補が3手まで出て、解説も作れます。</span></div>`;
  if (st === 'gen') return '<p class="fl">解説を作っています…</p>' + '<div class="skl"></div>'.repeat(3) + '<div class="skl" style="width:62%"></div>' + '<div class="skl" style="margin-top:20px"></div><div class="skl" style="width:80%"></div>';
  if (st === 'setup') {
    const pr = DB.profile;
    return `${fl('どこを中心に説明しますか')}<div class="chw">${FOCUS.map((x) => `<button type="button" class="ch" data-a="aifocus" data-v="${x}" aria-pressed="${AI.focus === x}">${x}</button>`).join('')}</div>
      ${fl('詳しさ')}<div class="sg" role="group">${DETAIL.map((x) => `<button type="button" data-a="aidetail" data-v="${x}" aria-pressed="${AI.detail === x}">${x}</button>`).join('')}</div>
      <div class="prf"><div><b>学習プロフィール</b>練習中：${pr.practice.join('・') || 'なし'}${pr.goal ? `<br>目標：${esc(pr.goal)}` : ''}</div><button type="button" class="tx-b" data-a="nav" data-v="profile">変更</button></div>
      ${CUR.ai ? '<p class="hint" style="margin:0 2px">作り直すと、いまの解説と質問の履歴は新しいものに置きかわります。</p>' : ''}`;
  }
  const ai = CUR.ai, qs = paid() ? aiQuestions().filter((x) => !ai.chat.some((c) => c.q === x.q)) : [];
  let h = ai.html + '<p class="ain">数字と指し手は、解析結果のままです。説明の文章はAIが書いています。<span class="mk0">モック</span>この文章は、解析データから組み立てた見本です。</p>';
  ai.chat.forEach((c) => { h += `<p class="cq">${esc(c.q)}</p><div class="ca">${pic(c.a ? c.face : 'chat-thinking', 'cav')}<div>${c.a || '<section class="blk"><span class="dots"><i></i><i></i><i></i></span></section>'}</div></div>`; });
  if (paid() && aiLeft()) h += `<div class="sqs"><button type="button" class="sq" data-a="aiask" data-v="@pos">いまの局面について教えて</button>${qs.map((x) => `<button type="button" class="sq" data-a="aiask" data-v="${esc(x.q)}">${esc(x.q)}</button>`).join('')}</div>`;
  return h;
}
/* the bottom of the sheet always holds the one thing to do next */
function aiFoot(st) {
  if (st === 'lock') return '<button type="button" class="bt pri wide" data-a="nav" data-v="plan">有料プランを見る</button>';
  if (st === 'need' && RUN && RUN.id === CUR.id) return '';
  if (st === 'need' || st === 'redo') {
    if (!preciseLeft()) return `<p class="ailk">今週の精密解析は残り0局です。${WEEK}に、また使えます。</p>`;
    return `<p class="ailk">精密解析を1局分使います（今週あと${preciseLeft()}局）</p><button type="button" class="bt pri wide" data-a="aianalyze">${st === 'redo' ? '精密解析でやり直す' : '精密解析する'}</button>`;
  }
  const few = aiLow() ? `<p class="ailk">AIコーチは、今月あと${aiLeft()}回使えます</p>` : '';
  if (st === 'ready' && paid()) return aiLeft() ? few : '<p class="ailk">今月のAIコーチは上限に達しました。月が変わると、また使えます。</p>';
  if (st === 'setup') return `${few}<button type="button" class="bt pri wide" data-a="aigen"><svg class="ic"><use href="#i-spark"/></svg>${CUR.ai ? 'このスタイルで作り直す' : '解説をつくる'}</button>${CUR.ai ? '<button type="button" class="tx-b" data-a="aicancel">いまの解説に戻る</button>' : ''}`;
  if (st === 'ready' && !paid()) return '<p class="ailk">新しい解説や質問は、有料プランで使えます。</p><button type="button" class="bt pri wide" data-a="nav" data-v="plan">有料プランを見る</button>';
  return '';
}
const AI_FACE = { cap: 'chat-default', lock: 'chat-default', need: 'chat-default', redo: 'chat-default', setup: 'chat-listening', gen: 'chat-thinking', ready: 'chat-explaining' };
function renderAI(keepScroll) {
  if (!AI.open) return;
  const st = aiStage(), y = R.aim.scrollTop, foot = aiFoot(st);
  R.aiav.src = IMG[AI_FACE[st]] || '';
  R.aisty.hidden = st !== 'ready' || !paid();
  /* the finished text carries its own note that it is a sample, so the header tag gives way to the style button */
  R.aiw.querySelector('.smp').hidden = st === 'ready';
  if (st === 'ready') R.aisty.innerHTML = `<svg class="ic"><use href="#i-filter"/></svg>${CUR.ai.focus}・${CUR.ai.detail}`;
  R.aif.hidden = st !== 'ready' || !paid() || !aiLeft();
  R.aic.hidden = !foot;
  R.aic.innerHTML = foot;
  R.aim.innerHTML = aiBody(st);
  R.aim.scrollTop = keepScroll ? y : 0;
  layoutAI();
}
function askAI(q, answer, face) {
  if (!aiLeft()) return;
  const gm = CUR, c = { q, a: '', face: face || 'chat-explaining' };
  gm.ai.chat.push(c);
  useAI();
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
A.aistyle = () => { if (!aiLeft()) { toast('今月のAIコーチは上限に達しました。月が変わると、また使えます'); return; } AI.setup = true; AI.focus = CUR.ai.focus; AI.detail = CUR.ai.detail; renderAI(); };
A.aicancel = () => { AI.setup = false; renderAI(); };
A.aianalyze = () => {
  const after = () => { if (AI.open) renderAI(); };
  if (CUR.an === 'none') { startAnalysis(CUR, 'pre'); after(); } else redoPrecise(after);
};
A.aigen = () => {
  if (!needNet(() => A.aigen())) return;
  const gm = CUR;
  AI.gen = true; AI.setup = false;
  renderAI();
  setTimeout(() => {
    AI.gen = false;
    if (CUR !== gm) return;
    gm.ai = { focus: AI.focus, detail: AI.detail, html: commentary(AI.focus, AI.detail), chat: [] };
    useAI();
    renderAI();
  }, 1500);
};
A.aiask = (q) => {
  if (!needNet(() => A.aiask(q))) return;
  if (q === '@pos') { const i = S.ply; askAI(S.br ? `${i}手目から分かれた局面について教えて` : i ? `${i}手目の局面について教えて` : '開始局面について教えて', () => (S.br ? blk('答え', ENG, ['分岐の局面は、分岐中の解析の結果をもとに答えます。<span class="mk0">モック</span>ここでは、本譜の局面にだけ答えます。']) : posAnswer(i)), 'chat-explaining'); return; }
  const x = aiQuestions().find((o) => o.q === q);
  if (x) askAI(x.q, x.a, x.face);
};
SCR.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target.dataset.f;
  if (f === 'ai') {
    const inp = document.getElementById('ai-q'), q = inp.value.trim();
    if (!q || !CUR || !CUR.ai) return;
    if (!DB.online) { toast('通信できません。つながってから、もう一度送ってください'); return; }
    inp.value = '';
    const x = aiQuestions().find((o) => o.q === q);
    askAI(q, x ? x.a : () => blk('答え', 'モック', ['<span class="mk0">モック</span>下に出ている候補の質問にだけ答えます。実際のアプリでは、この対局の解析結果をもとにAIコーチが答えます。解析にない手順を挙げるときは、「解析で確かめていない手順です」と断ります。']), x ? x.face : 'chat-listening');
  } else if (f === 'name') {
    const inp = document.getElementById('name-in'), n = inp.value.trim();
    if (!n) return;
    if (DB.names.includes(n)) { toast('その名前は登録済みです'); return; }
    DB.names.push(n);
    show();
    const hit = DB.games.filter((g) => !g.self && !g.sample && (g.sente === n || g.gote === n));
    if (hit.length) ask(`保存済みの棋譜に「${esc(n)}」がいます`, `${hit.length}局で、対局者の名前が「${esc(n)}」です。自分の対局として戦績に数えますか？`, '数える', () => { hit.forEach((g) => { g.self = g.sente === n ? 's' : 'g'; g._v = null; }); show(); toast(`${hit.length}局を自分の対局にしました`); }, { no: 'そのまま' });
    else toast(`「${n}」を登録しました`);
  }
});
