// Captures every screen and state of the app mock, and reports text that is cut off or sticks out of the screen.
// node capture.js <standalone.html> <outDir> [width height]   (needs Playwright)
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const [file, outDir, W = '393', H = '852'] = process.argv.slice(2);
  require('fs').mkdirSync(outDir, { recursive: true });
  const url = 'file://' + path.resolve(file);
  const browser = await chromium.launch();
  const errors = [];
  const page = await browser.newPage({ viewport: { width: +W, height: +H }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 3).join('\n')));
  await page.goto(url);
  await page.waitForTimeout(1300);
  let n = 0;
  const shot = async (name) => {
    await page.evaluate(() => { document.querySelector('.phone').scrollIntoView(); });
    await page.waitForTimeout(380);
    await page.screenshot({ path: path.join(outDir, `${String(++n).padStart(2, '0')}-${name}.png`) }); global.__n = n + ' ' + name;
    const iss = await page.evaluate(() => {
      const scr = document.querySelector('#scr'), B = scr.getBoundingClientRect(), out = new Set();
      const scrollsX = (e) => { for (let p = e.parentElement; p && p !== scr.parentElement; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
      const textW = (e) => { const rg = document.createRange(); rg.selectNodeContents(e); return rg.getBoundingClientRect().width; };
      for (const e of scr.querySelectorAll('*')) {
        if (e.offsetParent === null || e.closest('svg')) continue;
        const cs = getComputedStyle(e), r = e.getBoundingClientRect();
        if (!r.width || !r.height || cs.visibility === 'hidden' || !e.textContent.trim()) continue;
        const tag = `${e.tagName.toLowerCase()}.${String(e.className).split(' ').join('.')} "${e.textContent.trim().replace(/\s+/g, ' ').slice(0, 22)}"`;
        const inner = e.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        if (cs.textOverflow === 'ellipsis' && textW(e) > inner + 0.6) out.add('cut: ' + tag);
        else if (cs.whiteSpace === 'nowrap' && cs.display !== 'inline' && e.clientWidth && [...e.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()) && textW(e) > inner + 0.6) out.add('spill: ' + tag);
        if ((r.right > B.right + 1 || r.left < B.left - 1) && !scrollsX(e)) out.add('outside: ' + tag);
      }
      return [...out];
    });
    for (const x of iss) { if (!global.__seen) global.__seen = new Map(); if (!global.__seen.has(x)) global.__seen.set(x, n + ' ' + name); }
 if (errors.length) { console.log('ERRORS after', name, errors.splice(0).join('\n')); }
  };
  const click = async (sel, i = 0) => { await page.evaluate(([s, k]) => { const els = [...document.querySelectorAll(s)].filter((e) => e.offsetParent !== null); (els[k < 0 ? els.length + k : k]).click(); }, [sel, i]); await page.waitForTimeout(160); };
  const act = (a, v) => click(`#scr [data-a="${a}"]${v != null ? `[data-v="${v}"]` : ''}`);
  const jump = async (j) => { await page.evaluate((x) => document.querySelector(`.jump [data-jump="${x}"]`).click(), j); await page.waitForTimeout(350); };
  const ctl = async (sel) => { await page.evaluate((s) => document.querySelector(s).click(), sel); await page.waitForTimeout(300); };
  const fill = async (sel, v) => { await page.fill(sel, v); await page.waitForTimeout(120); };
  const scrollTo = async (sel, y) => { await page.evaluate(([s, t]) => { const els = [...document.querySelectorAll(s)].filter((e) => e.offsetParent !== null); if (els[0]) els[0].scrollTop = t; }, [sel, y]); };
  const key = async (k, times = 1) => { for (let i = 0; i < times; i++) await page.keyboard.press(k); await page.waitForTimeout(150); };
  const square = async (f, r, flip) => {
    const b = await page.locator('#scr .bdw svg').boundingBox();
    const cx = flip ? f - 1 : 9 - f, cy = flip ? 9 - r : r - 1;
    await page.touchscreen.tap(b.x + ((10 + cx * 100 + 50 + 4) / 952) * b.width, b.y + ((38 + cy * 108 + 54 + 4) / 1044) * b.height);
    await page.waitForTimeout(150);
  };

  // first launch
  await jump('onb');
  for (let i = 1; i <= 7; i++) {
    if (i === 6) { await act('onbprac', '四間飛車'); await fill('#onb-goal', '初段になりたい'); }
    await shot('onboarding-' + i);
    if (i < 7) await act('onbnext');
  }
  await act('onbalt'); await shot('first-empty-library');
  await act('tab', 'stats'); await shot('first-empty-stats');
  await act('tab', 'list');
  await act('nav', 'import'); await shot('import-empty');
  await act('imppaste'); await scrollTo('#scr .pgc', 9999); await shot('import-who-are-you');
  await act('impside', 'g'); await scrollTo('#scr .pgc', 9999); await shot('import-side-picked');
  await act('impsave', '0'); await page.waitForTimeout(2800); await shot('game-not-analysed-free');
  await act('analyze'); await page.waitForTimeout(2600); await shot('game-analysing');
  await page.waitForTimeout(6500); await shot('game-first-analysis-dialog');
  await act('dlgok'); await shot('game-gote-view-after-first-analysis');
  await key('End'); await shot('game-end-lost');
  await act('back'); await shot('first-list-one-game');

  // in use
  await ctl('.pg-ctl [data-state="lived"]'); await shot('list');
  await scrollTo('#scr .gl', 700); await shot('list-scrolled');
  await act('filter'); await shot('list-filter-sheet');
  await click('#scr .shh [data-a="closesheet"]');
  await act('search'); await fill('#q', 'zzz'); await shot('list-no-results');
  await act('search');
  await act('nav', 'import'); await fill('#kif-in', 'これは棋譜ではありません'); await shot('import-invalid');
  await act('imppaste'); await shot('import-ok-top'); await scrollTo('#scr .pgc', 9999); await shot('import-ok-bottom');
  await act('impsave', '1'); await page.waitForTimeout(9500); await act('back');
  await act('nav', 'import'); await act('imptab', 'file'); await act('impfile'); await shot('import-duplicate');
  await jump('game'); await shot('game-analysed-blunder');
  await act('cand', '1'); await shot('game-candidate-2');
  await act('kf'); await shot('game-moves-sheet');
  await click('#scr .shh [data-a="closesheet"]');
  await act('gmenu'); await shot('game-menu');
  await act('kifout'); await shot('game-kif-export');
  await click('#scr .shh [data-a="closesheet"]');
  await act('gmenu'); await act('ginfo'); await shot('game-info');
  await act('tagedit', 's:st'); await shot('game-info-strategy-sheet');
  await click('#scr .shh [data-a="closesheet"]');
  await act('back');
  await key('ArrowRight', 31); await shot('game-mate-found');
  await key('End'); await shot('game-end-won');
  await jump('branch'); await page.waitForTimeout(900); await shot('branch-paid-known');
  await act('playline'); await page.waitForTimeout(900); await act('kf'); await shot('branch-moves-sheet');
  await click('#scr .shh [data-a="closesheet"]');
  await act('step', 'first');
  await square(2, 3); await shot('game-piece-picked');
  await square(2, 2); await shot('game-promote-choice');
  await act('promo', '0'); await page.waitForTimeout(900); await shot('branch-paid-unknown');
  await ctl('.pg-ctl [data-plan="free"]'); await shot('branch-free');
  await act('step', 'first'); await shot('game-analysed-free');
  await act('ai'); await shot('ai-locked-free');
  await ctl('.pg-ctl [data-plan="paid"]');
  await jump('ai'); await shot('ai-setup');
  await act('aigen'); await page.waitForTimeout(500); await shot('ai-generating');
  await page.waitForTimeout(1600); await shot('ai-commentary-half');
  await act('aisize'); await shot('ai-commentary-full');
  await scrollTo('#scr .aim', 9999); await shot('ai-commentary-full-bottom');
  await click('#scr .sq'); await page.waitForTimeout(1300); await shot('ai-chat-answer');
  await jump('stats'); await shot('stats-top');
  await scrollTo('#scr .pgc', 9999); await shot('stats-bottom');
  await act('stset', 'dim:mycs'); await scrollTo('#scr .pgc', 9999); await shot('stats-castles');
  await act('strow', '美濃囲い'); await shot('stats-filtered-list');
  await jump('set'); await shot('settings-paid');
  for (const pg of ['names', 'profile', 'backup', 'plan', 'about']) { await act('nav', pg); await shot('settings-' + pg); await act('back'); }
  await ctl('.pg-ctl [data-plan="free"]');
  await jump('set'); await shot('settings-free');
  await act('nav', 'plan'); await shot('plan-free');
  await jump('list'); await shot('list-free');
  // limits, connection, notices
  await ctl('.pg-ctl [data-plan="paid"]');
  await jump('limit'); await shot('limit-precise-paid');
  await ctl('.pg-ctl [data-plan="free"]'); await shot('limit-free');
  await act('analyze').catch(() => {}); 
  await click('#scr [data-a="nav"][data-v="plan"]').catch(() => {});
  await ctl('.pg-ctl [data-plan="paid"]');
  await jump('offline'); await page.waitForTimeout(3300); await shot('offline-analysis-paused');
  await act('back'); await shot('offline-list');
  await ctl('.pg-ctl [data-net="on"]'); await page.waitForTimeout(4200); await shot('notice-analysis-done');
  await ctl('.pg-ctl [data-net="off"]');
  await jump('game'); await ctl('.pg-ctl [data-net="off"]'); await act('ai'); await click('#scr .sq'); await shot('offline-dialog');
  await click('#scr .dla [data-a="dlgno"]'); await act('aiclose');
  await act('step', 'prev'); await act('playline'); await page.waitForTimeout(800); await shot('offline-branch');
  await ctl('.pg-ctl [data-net="on"]');
  await jump('fail'); await page.waitForTimeout(3200); await shot('analysis-failed');
  await jump('game'); await act('evalhelp'); await shot('eval-help');
  await click('#scr .shh [data-a="closesheet"]');
  await act('gmenu'); await act('ginfo'); await act('resedit'); await shot('result-edit');
  await act('resset', 'd'); await click('#scr .shh [data-a="closesheet"]'); await shot('result-draw-info');
  await act('back'); await key('End'); await shot('game-end-draw');
  await act('back'); await shot('list-with-draw');
  await act('tab', 'stats'); await shot('stats-with-draw');
  await jump('set'); await act('nav', 'backup'); await act('bkin'); await shot('restore-confirm');
  await click('#scr .dla [data-a="dlgno"]');
  await jump('set'); await act('replay'); await shot('replay-intro');
  await ctl('.pg-ctl [data-state="first"]'); await act('onbskip'); await shot('first-empty-with-sample');
  await act('kifhelp'); await shot('kif-help'); await click('#scr .shh [data-a="closesheet"]');
  await act('sample'); await page.waitForTimeout(500); await shot('sample-game');
  await browser.close();
  for (const [k, v] of (global.__seen || new Map())) console.log(`${k}   <- ${v}`);
  console.log('shots:', n);
  console.log(errors.length ? errors.join('\n') : 'no page errors');
})().catch((e) => { console.error('SCRIPT FAILED', String(e).split('\n').slice(0, 3).join('\n'), '\nat step', global.__n); process.exit(1); });
