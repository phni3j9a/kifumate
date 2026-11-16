/* ---------- onboarding: shown once, on the first launch ----------
   Seven scenes, following the mascot kit: welcome, import, reading the graph, branches, the coach,
   a goal, ready. Every scene can be skipped; the two with fields (your player name, your goal) are
   optional and can be filled in later from the settings. */
const ONB = { on: false, replay: false, step: 0, name: '', practice: [], goal: '', dir: 1 };
const onbMark = (kind) => `<svg viewBox="-9 -9 18 18" aria-hidden="true"><g class="g-m ${kind}">${kind === 'mate' ? '<rect class="bg" x="-7" y="-7" width="14" height="14" rx="3.5"/><text y="3.2" text-anchor="middle">詰</text>' : `<circle class="bg" r="7.2"/>${glyph(kind, 3)}`}</g></svg>`;
const ONB_STEPS = [
  { img: 'onb-1', tint: '#FFE9A8', title: 'kifumateへ ようこそ',
    body: '指した将棋を取り込んで、形勢がどこで動いたかを振り返るアプリです。できることを順に紹介します。',
    next: 'はじめる', alt: 'バックアップから復元する' },
  { img: 'onb-2', tint: '#C9F3EA', title: '棋譜を取り込む',
    body: 'KIF形式の棋譜を、貼り付けるかファイルを選んで取り込みます。対局サービスへのログインは要りません。',
    extra: () => `<label class="fl" for="onb-name" style="margin-top:0">対局で使っている名前</label><input id="onb-name" class="inp" autocomplete="off" autocapitalize="off" maxlength="30" placeholder="例：tsubame" value="${esc(ONB.name)}"><p class="hint">棋譜の中のあなたを見分けて、勝ち負けを数えるために使います（この端末の中だけ）。空のままでも進めます。あとで追加や変更ができます。</p>` },
  { img: 'onb-3', tint: '#DCE6FF', title: '形勢グラフを読む',
    body: '解析すると、形勢の動きがグラフになります。線が上にあるほど、あなたが有利です。印をタップすると、その手に移ります。',
    extra: () => `<div class="onlg">${[['bad', '悪手'], ['dub', '疑問手'], ['good', '好手'], ['mate', '詰みあり']].map(([k, t]) => `<span>${onbMark(k)}${t}</span>`).join('')}</div>` },
  { img: 'onb-4', tint: '#FFE9A8', title: '分岐を試す',
    body: '盤の駒を動かして、「こう指していたら？」を確かめられます。本譜（実際に指した手順）や戦績は変わりません。' },
  { img: 'onb-5', tint: '#C9F3EA', title: 'コーチに質問',
    body: '解析結果をもとに、AIコーチが対局を言葉で解説します。気になったことは、続けて質問できます。',
    extra: () => '<span class="onpaid"><svg class="ic"><use href="#i-lock"/></svg>AIコーチは有料プランの機能です。解析（週10局まで）と分岐は、無料で使えます。</span>' },
  { img: 'onb-6', tint: '#DCE6FF', title: '目標を決める',
    body: '練習中の戦法と目標を教えてください。コーチ（有料プラン）の解説に反映します。',
    extra: () => `<p class="fl" style="margin-top:0">練習中の戦法（いくつでも）</p><div class="opt" role="group" aria-label="練習中の戦法">${PRACTICE.map((s) => `<button type="button" class="ch mul" data-a="onbprac" data-v="${s}" aria-pressed="${ONB.practice.includes(s)}">${s}</button>`).join('')}</div><label class="fl" for="onb-goal">目標</label><input id="onb-goal" class="inp" autocomplete="off" maxlength="60" placeholder="例：初段になりたい" value="${esc(ONB.goal)}">`,
    alt: 'あとで決める' },
  { img: 'onb-7', tint: '#FFE9A8', title: 'さあ、はじめよう',
    body: '準備ができました。まずは1局、取り込んでみましょう。',
    next: '最初の棋譜を取り込む', alt: 'あとで' },
];
function renderOnb() {
  const i = ONB.step, s = ONB_STEPS[i], last = i === ONB_STEPS.length - 1;
  /* seen again from the settings: nothing to restore, and the last scene just closes */
  const alt = ONB.replay ? (last ? '閉じる' : i ? s.alt : '') : s.alt, next = ONB.replay && last ? '棋譜を取り込む' : s.next || '次へ';
  const dots = ONB_STEPS.map((_, k) => `<i class="${k === i ? 'on' : k < i ? 'done' : ''}"></i>`).join('');
  R.vonb.innerHTML = `<div class="ontop">
      <div class="onsl">${i ? '<button type="button" class="rb" data-a="onbprev" aria-label="前へ"><svg class="ic"><use href="#i-prev"/></svg></button>' : `<span class="onbrand">${pic('app-icon', 'onic')}kifumate</span>`}</div>
      <div class="ondots" role="img" aria-label="${ONB_STEPS.length}枚中 ${i + 1}枚目">${dots}</div>
      <div class="onsl r">${last ? '' : '<button type="button" class="tx-b" data-a="onbskip">スキップ</button>'}</div>
    </div>
    <div class="onsc ${ONB.dir > 0 ? 'in-r' : 'in-l'}">
      <div class="onst" style="background:${s.tint}">${pic(s.img, 'onimg')}</div>
      <h2 class="ont">${s.title}</h2>
      <p class="onbd">${s.body}</p>
      ${s.extra ? `<div class="onx">${s.extra()}</div>` : ''}
    </div>
    <div class="onft"><button type="button" class="bt pri wide" data-a="onbnext">${next}</button><div class="onalt">${alt ? `<button type="button" class="tx-b" data-a="onbalt">${alt}</button>` : ''}</div></div>`;
}
function onbGo(d) {
  const n = ONB.step + d;
  if (n < 0 || n >= ONB_STEPS.length) return;
  ONB.step = n; ONB.dir = d;
  renderOnb();
}
/* what was typed is kept even when the rest is skipped */
function endOnb(toImport) {
  const n = ONB.name.trim();
  if (n && !DB.names.includes(n)) DB.names.push(n);
  DB.profile.practice = ONB.practice.slice();
  DB.profile.goal = ONB.goal.trim();
  ONB.on = false; ONB.replay = false;
  show();
  if (toImport) push({ t: 'import' });
}
A.replay = () => {
  closeLayers();
  Object.assign(ONB, { on: true, replay: true, step: 0, name: '', practice: DB.profile.practice.slice(), goal: DB.profile.goal, dir: 1 });
  show();
};
A.onbnext = () => { if (ONB.step === ONB_STEPS.length - 1) endOnb(true); else onbGo(1); };
A.onbprev = () => onbGo(-1);
A.onbskip = () => endOnb(false);
A.onbprac = (v) => {
  const a = ONB.practice, k = a.indexOf(v), y = R.vonb.querySelector('.onsc').scrollTop;
  if (k >= 0) a.splice(k, 1); else a.push(v);
  ONB.dir = 0;
  renderOnb();
  const sc = R.vonb.querySelector('.onsc');
  sc.classList.remove('in-l', 'in-r');
  sc.scrollTop = y;
};
A.onbalt = () => {
  if (ONB.step === 0) {
    ask('バックアップから復元', '前の端末で書き出したファイルを選ぶと、棋譜・解析結果・設定がこの端末に戻ります。', 'ファイルを選ぶ', () => { startLived(true); ask('復元しました', `棋譜 ${DB.games.length}局と設定が、この端末に戻りました。<br>有料プランを使っていた場合は、設定の「購入を復元」で引き継げます。`, 'OK', null, { single: true, img: 'sys-backup' }); }, { img: 'sys-backup', no: 'やめる' });
  } else if (ONB.step === ONB_STEPS.length - 1) endOnb(false);
  else { if (!ONB.replay) { ONB.practice = []; ONB.goal = ''; } onbGo(1); }
};
/* swipe left and right between scenes */
(() => {
  let x0 = null, y0 = 0;
  R.vonb.addEventListener('pointerdown', (e) => { x0 = e.target.closest('input, button') ? null : e.clientX; y0 = e.clientY; });
  R.vonb.addEventListener('pointerup', (e) => {
    if (x0 == null) return;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 48 && Math.abs(dy) < 60) onbGo(dx < 0 ? 1 : -1);
  });
  R.vonb.addEventListener('pointercancel', () => { x0 = null; });
})();
