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

let toastTimer = 0;
function toast(msg) {
  R.toast.textContent = msg;
  R.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { R.toast.hidden = true; }, 2600);
}

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
  R.dlgb.innerHTML = `${o.img ? pic(o.img, 'dli') : ''}<b>${title}</b><p>${text}</p><div class="dla">${o.single ? '' : '<button type="button" class="bt" data-a="dlgno">やめる</button>'}<button type="button" class="bt ${o.danger ? '' : 'pri'}" ${o.danger ? 'style="background:var(--coral)"' : ''} data-a="dlgok">${okLabel}</button></div>`;
  dlgOk = onOk || null;
  R.toast.hidden = true;
  R.dlg.hidden = false;
}
A.dlgno = () => { R.dlg.hidden = true; dlgOk = null; };
A.dlgok = () => { const f = dlgOk; R.dlg.hidden = true; dlgOk = null; if (f) f(); };

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
function back() {
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
