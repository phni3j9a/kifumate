/* ---------- shell: element lookups, navigation, toast, sheet, dialog ---------- */
const SCR = document.getElementById('scr');
const R = {};
document.querySelectorAll('[data-b]').forEach((el) => { R[el.dataset.b] = el; });
const FL0 = { scope: '', side: '', period: '', myst: '', mycs: '', opst: '' };
const UI = {
  tab: 'list', quick: 'all', q: '', search: false, flt: { ...FL0 }, sheet: null,
  st: { period: '', side: '', dim: 'myst' }, scroll: {},
};
const NAV = [];      /* pages pushed on top of the tab screens: { t: 'game' | 'import' | 'flist' | … } */
const A = {};        /* actions, called from data-a="name" data-v="value" */
const paid = () => DB.plan === 'paid';
const topNav = () => NAV[NAV.length - 1] || null;
const uniq = (arr) => [...new Set(arr)];

/* a short message; with a label it becomes a snackbar at the bottom that offers one action */
let toastTimer = 0, toastFn = null;
function toast(msg, o) {
  o = o || {};
  R.toast.textContent = msg;
  R.toast.classList.toggle('act', !!o.label);
  toastFn = o.fn || null;
  if (o.label) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.a = 'toastact'; b.textContent = o.label;
    R.toast.appendChild(b);
  }
  R.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { R.toast.hidden = true; }, o.label ? 6000 : 2600);
}
A.toastact = () => { const f = toastFn; toastFn = null; R.toast.hidden = true; if (f) f(); };

/* one bottom sheet, reused for the move list, menus, filters and pickers */
let sheetClose = null;
function openSheet(title, html, o) {
  o = o || {};
  R.toast.hidden = true;
  R.shtitle.textContent = title;
  R.shc.innerHTML = html;
  R.shb.classList.toggle('auto', !!o.auto);
  R.shb.style.height = o.h || '';
  R.sheet.hidden = false;
  R.shc.scrollTop = 0;
  UI.sheet = o.id || 'x';
  sheetClose = o.onClose || null;
}
function closeSheet() {
  if (R.sheet.hidden) return;
  R.sheet.hidden = true;
  UI.sheet = null;
  R.shc.innerHTML = '';
  const f = sheetClose;
  sheetClose = null;
  if (f) f();
}
A.closesheet = closeSheet;

/* a small confirm dialog (the viewer has no confirm()/alert(), and the app would use its own anyway) */
let dlgOk = null;
function ask(title, text, okLabel, onOk, o) {
  o = o || {};
  R.dlgb.innerHTML = `${o.img ? pic(o.img, 'dli') : ''}<b>${title}</b><p>${text}</p><div class="dla">${o.single ? '' : `<button type="button" class="bt" data-a="dlgno">${o.no || 'やめる'}</button>`}<button type="button" class="bt ${o.danger ? '' : 'pri'}" ${o.danger ? 'style="background:var(--coral)"' : ''} data-a="dlgok">${okLabel}</button></div>`;
  dlgOk = onOk || null;
  R.toast.hidden = true;
  R.dlg.hidden = false;
  const ok = R.dlgb.querySelector('[data-a="dlgok"]');
  if (ok && !matchMedia('(pointer:coarse)').matches) ok.focus();
}
A.dlgno = () => { R.dlg.hidden = true; dlgOk = null; };
A.dlgok = () => { const f = dlgOk; R.dlg.hidden = true; dlgOk = null; if (f) f(); };

/* Analysis, the coach and real-time analysis run on the server. Without a connection the saved records
   and results still open; anything that needs the server explains itself and offers to try again. */
function needNet(retry) {
  if (DB.online) return true;
  ask('通信できません', '解析やAIコーチはサーバーで動くため、通信が必要です。保存済みの棋譜と解析結果は、このまま見られます。', 'もう一度試す', () => { if (DB.online) retry(); else toast('まだ通信できません'); }, { img: 'sys-offline', no: '閉じる' });
  return false;
}
function closeLayers() { closeSheet(); R.dlg.hidden = true; closeAI(); R.toast.hidden = true; }

/* which of the three containers is showing: the tab screens, a pushed page, or the game screen */
/* restore: put the scroll position back where it was left (coming back, or switching tabs) */
function show(anim, restore) {
  const t = topNav(), which = ONB.on ? 'onb' : !t ? 'root' : t.t === 'game' ? 'game' : 'page';
  R.vonb.hidden = which !== 'onb';
  R.vroot.hidden = which !== 'root';
  R.vpage.hidden = which !== 'page';
  R.vgame.hidden = which !== 'game';
  SCR.dataset.view = which;
  if (which !== 'game') SCR.dataset.turn = '-';
  if (which === 'onb') renderOnb();
  else if (which === 'root') renderRoot(restore);
  else if (which === 'page') renderPage(t, restore);
  else enterGame(t);
  if (anim && which !== 'onb') {
    const el = which === 'root' ? R.vroot : which === 'page' ? R.vpage : R.vgame;
    el.classList.remove('in');
    void el.offsetWidth;
    el.classList.add('in');
  }
}
function push(p) { closeLayers(); keepScroll(); NAV.push(p); show(true); }
/* Back undoes the most recent thing first: an open sheet or the coach, then a branch on the game
   screen, and only then the screen itself. */
function back() {
  const cur = topNav();
  if (cur && cur.t === 'game' && !ONB.on) {
    if (!R.sheet.hidden || !R.dlg.hidden || AI.open) { closeLayers(); return; }
    if (S.br) { exitBranch(); return; }
  }
  closeLayers();
  const t = NAV.pop();
  if (t && t.t === 'game') leaveGame();
  show(false, true);
}
/* a hidden container forgets its scroll position, so it is noted before leaving a screen */
function keepScroll() {
  const t = topNav();
  if (!t) { const el = R.tabc.querySelector('.gl, .pgc'); if (el) UI.scroll[UI.tab] = el.scrollTop; }
  else if (t.t !== 'game') { const el = R.vpage.querySelector('.gl, .pgc'); if (el) t.y = el.scrollTop; }
}
A.back = back;
A.nav = (v) => push({ t: v });
A.tab = (v) => {
  if (topNav()) { if (topNav().t === 'game') leaveGame(); NAV.length = 0; }
  else if (UI.tab === v) UI.scroll[v] = 0;
  else keepScroll();
  UI.tab = v;
  show(false, true);
};

SCR.addEventListener('click', (e) => {
  const t = e.target.closest('[data-a]');
  if (!t || !SCR.contains(t) || t.disabled) return;
  const f = A[t.dataset.a];
  if (f) f(t.dataset.v, t, e);
});
SCR.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"][data-a]')) { e.preventDefault(); e.target.click(); }
});
