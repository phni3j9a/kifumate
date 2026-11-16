/* ---------- page-level controls and start-up ---------- */
function syncPlan() {
  document.body.dataset.plan = DB.plan;
  document.querySelectorAll('.pg-ctl button[data-plan]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.plan === DB.plan)));
  S.rtUntil = 0;
  show();
  if (AI.open) renderAI();
}
/* the mock has two data states: a first launch (nothing saved, onboarding) and an app in use */
function resetUI() {
  if (RUN) { clearInterval(RUN.timer); RUN = null; }
  closeLayers();
  CUR = null; S.br = null; clearSel();
  NAV.length = 0;
  Object.assign(UI, { tab: 'list', quick: 'all', q: '', search: false, flt: { ...FL0 }, scroll: {} });
  Object.assign(IMP, { tab: 'paste', text: '', file: '', pick: undefined });
}
function syncState() {
  document.querySelectorAll('.pg-ctl button[data-state]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.state === 'first') === DB.first)));
}
function startFirstRun(withOnboarding) {
  resetUI();
  clearData();
  DB.plan = 'free';
  Object.assign(ONB, { on: withOnboarding, step: 0, name: '', practice: [], goal: '', dir: 1 });
  syncState();
  syncPlan();
}
function startLived() {
  resetUI();
  seedData();
  DB.plan = 'paid';
  ONB.on = false;
  syncState();
  syncPlan();
}
document.querySelector('.pg-ctl').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.plan) { DB.plan = b.dataset.plan; syncPlan(); }
  else if (b.dataset.state) { if (b.dataset.state === 'first') startFirstRun(true); else startLived(); }
});

/* shortcuts from the notes beside the phone, so a reviewer can land on a screen or state directly */
function resetTo(tab) {
  if (DB.first || ONB.on) startLived();
  closeLayers();
  if (topNav() && topNav().t === 'game') leaveGame();
  NAV.length = 0;
  UI.tab = tab || 'list';
  show();
}
function openRecord(g, ply) {
  if (!gameById(g.id)) DB.games.push(g);
  push({ t: 'game', id: g.id });
  if (ply != null) setPly(ply);
}
const JUMPS = {
  onb: () => startFirstRun(true),
  empty: () => startFirstRun(false),
  list: () => resetTo('list'),
  import: () => { resetTo('list'); push({ t: 'import' }); },
  game: () => { resetTo('list'); openRecord(GAME1); },
  fresh: () => { resetTo('list'); let g = game2(); if (!g) g = addGame2().gm; openRecord(g); },
  branch: () => {
    resetTo('list');
    const b = window.KIFU.positions.findIndex((p, i) => i > 30 && p.mark === '悪手' && i % 2 === 1);
    openRecord(GAME1, Math.max(0, b - 1));
    if (anMode() === 'done') { S.sel = 0; A.playline(); }
  },
  ai: () => { resetTo('list'); openRecord(GAME1); openAI(); },
  stats: () => resetTo('stats'),
  set: () => resetTo('set'),
  plan: () => { resetTo('set'); push({ t: 'plan' }); },
};
document.querySelector('.jump').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-jump]');
  if (!b) return;
  JUMPS[b.dataset.jump]();
  const ph = document.querySelector('.phone'), r = ph.getBoundingClientRect();
  if (r.top < 0 || r.bottom > window.innerHeight) ph.scrollIntoView({ block: 'start', behavior: 'smooth' });
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const t = topNav(), inGame = !!t && t.t === 'game';
  if (e.key === 'Escape') {
    if (!R.dlg.hidden) A.dlgno();
    else if (!R.sheet.hidden) closeSheet();
    else if (AI.open) closeAI();
    else if (inGame) clearPick();
    return;
  }
  if (ONB.on) { if (R.dlg.hidden && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) onbGo(e.key === 'ArrowRight' ? 1 : -1); return; }
  if (!inGame || !R.sheet.hidden || !R.dlg.hidden) return;
  const k = { ArrowLeft: 'prev', ArrowRight: 'next', Home: 'first', End: 'last' }[e.key];
  if (k) { A.step(k); e.preventDefault(); }
});
if (window.ResizeObserver) {
  new ResizeObserver(() => { if (!R.vgame.hidden) buildGraph(); }).observe(R.graph);
  new ResizeObserver(() => layoutAI()).observe(SCR);
}
bindGraph();
/* the link can open straight into the first launch: …#first-run */
const fromHash = () => { if (location.hash === '#first-run') startFirstRun(true); };
window.addEventListener('hashchange', fromHash);
syncState();
if (location.hash === '#first-run') startFirstRun(true); else syncPlan();
