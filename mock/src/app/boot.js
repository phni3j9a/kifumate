/* ---------- page-level controls and start-up ---------- */
function syncPlan() {
  document.body.dataset.plan = DB.plan;
  document.querySelectorAll('.pg-ctl button[data-plan]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.plan === DB.plan)));
  S.rtUntil = 0;
  show();
  if (AI.open) renderAI();
}
document.querySelector('.pg-ctl').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-plan]');
  if (b) { DB.plan = b.dataset.plan; syncPlan(); }
});

/* shortcuts from the notes beside the phone, so a reviewer can land on a screen or state directly */
function resetTo(tab) {
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
  list: () => resetTo('list'),
  import: () => { resetTo('list'); push({ t: 'import' }); },
  game: () => { resetTo('list'); openRecord(GAME1); },
  fresh: () => { resetTo('list'); let g = game2(); if (!g) { IMP.side = 'g'; g = addGame2(); } openRecord(g); },
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
  if (!inGame || !R.sheet.hidden || !R.dlg.hidden) return;
  const k = { ArrowLeft: 'prev', ArrowRight: 'next', Home: 'first', End: 'last' }[e.key];
  if (k) { A.step(k); e.preventDefault(); }
});
if (window.ResizeObserver) {
  new ResizeObserver(() => { if (!R.vgame.hidden) buildGraph(); }).observe(R.graph);
  new ResizeObserver(() => layoutAI()).observe(SCR);
}
bindGraph();
syncPlan();
