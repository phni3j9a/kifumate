// Behaviour checks for the app mock: node check.js <standalone.html>
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
(async () => {
  const file = process.argv[2];
  const src = fs.readFileSync(file, 'utf8');
  const browser = await chromium.launch();
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto('file://' + path.resolve(file));
  await page.waitForTimeout(1200);
  let pass = 0, fail = 0;
  const ok = (c, label) => { if (c) pass++; else { fail++; console.log('FAIL: ' + label); } };
  const wait = (ms) => page.waitForTimeout(ms);
  const text = () => page.evaluate(() => document.querySelector('#scr').innerText.replace(/\s+/g, ' '));
  const has = async (s, label) => ok((await text()).includes(s), (label || 'has') + ' :: ' + s);
  const hasNot = async (s, label) => ok(!(await text()).includes(s), (label || 'has not') + ' :: ' + s);
  const click = async (sel, i = 0) => { const found = await page.evaluate(([s, k]) => { const els = [...document.querySelectorAll(s)].filter((e) => e.offsetParent !== null); if (!els[k]) return false; els[k].click(); return true; }, [sel, i]); if (!found) { fail++; console.log('MISSING: ' + sel + ' | passed so far ' + pass + ' | screen: ' + (await text()).slice(0, 160)); } await wait(180); };
  const act = (a, v) => click(`#scr [data-a="${a}"]${v != null ? `[data-v="${v}"]` : ''}`);
  const jump = async (j) => { await page.evaluate((x) => document.querySelector(`.jump [data-jump="${x}"]`).click(), j); await wait(350); };
  const ctl = async (sel) => { await page.evaluate((s) => document.querySelector(s).click(), sel); await wait(300); };
  const key = async (k, times = 1) => { for (let i = 0; i < times; i++) await page.keyboard.press(k); await wait(150); };
  /* 勝負所の一覧（シートの中）と、盤の下の入口 */
  const tp = (sel) => page.locator('#scr .shc ' + sel);
  const tpEntry = (name) => page.locator('#scr').getByRole('button', { name, exact: true }).count();
  const card = async (name) => { await page.evaluate((n) => { const c = [...document.querySelectorAll('#scr [data-a="open"]')].find((e) => e.offsetParent !== null && e.textContent.includes(n)); c.click(); }, name); await wait(350); };

  // 0. names that must never appear in the app: the engine and its evaluation function, and other companies' services (README: 決まっていること)
  for (const w of ['やねうら', '水匠', 'YaneuraOu', 'Suisho', 'suisho', 'yaneura', 'NNUE', '将棋ウォーズ', '将棋クエスト', '81道場', 'ぴよ将棋', '将棋倶楽部24', 'lishogi']) ok(!src.includes(w), 'forbidden word in build: ' + w);

  // 1. analysed game: labels, end of game
  await jump('game');
  await has('あなた'); await has('相手が有利', 'opens at the first blunder');
  await key('End'); await has('あなたの勝ち！'); await has('85手で終局（詰み）');

  // 1b. 勝負所の一覧: 印の付いた手と、前後とも深く読んだ手を手数順に。行を押すとその局面へ移る
  await jump('game');
  ok(await tpEntry('勝負所の一覧、11手') === 1, 'the entry under the board shows the count');
  await act('turns'); await has('勝負所（11手）'); await has('あなたの勝率');
  ok((await tp('.tp').evaluateAll((els) => els.map((e) => e.dataset.v).join())) === '31,40,42,49,52,62,63,65,66,68,81', 'marked moves and deeply read moves, in move order');
  ok(await tp('.tp .td').count() === 6, 'the moves read deeply on both sides carry the deep result');
  ok((await tp('.tp').first().getAttribute('aria-label')) === '31手目 ▲3三角成、あなたの手、あなたの勝率 51%から51%、深読み 最善の手、評価値 +29、読み筋 △同桂 ▲2四歩 △同歩 ▲同銀', 'a deeply read move is listed without a mark');
  ok(await tp('.tpn').count() === 0, 'no note when the analysis has deep reading');
  await click('#scr .tp[data-v="62"]'); ok(await page.locator('#scr [data-b="sheet"]').isHidden(), 'a row closes the sheet'); await has('62手目'); await has('深く読んだ局面');
  await act('turns'); ok((await tp('.tp.cur').evaluateAll((els) => els.map((e) => e.dataset.v).join())) === '62', 'the move on the board is highlighted'); await act('closesheet');
  /* 印も深読みもない解析は見本データにないので、文面だけ確かめる。印は31手目にも付くので「31手目以降」 */
  ok(src.includes('印は、31手目以降で形勢が大きく動いた手に付きます。') && !src.includes('31手目より後'), 'nothing marked: says where marks start');

  // 2. stop an analysis: asks first, and the quota is untouched
  await jump('fresh');
  await has('この対局を解析する'); await has('今週あと12局');
  ok(await tpEntry('勝負所の一覧') === 1, 'no count before the analysis');
  await act('turns'); await has('解析すると、悪手・疑問手・好手など 印の付いた手がここに並びます。'); await act('closesheet');
  await act('analyze'); await wait(900); await has('解析中');
  await act('turns'); await has('解析が終わると、印の付いた手がここに並びます。'); await act('closesheet');
  await act('stopan'); await has('解析を中止しますか');
  await click('#scr .dla [data-a="dlgok"]'); await has('この対局を解析する', 'back to not analysed'); await has('今週あと12局', 'quota unchanged after stop');

  // 3. queue: a second analysis waits its turn, then runs
  await act('analyze'); await wait(600);
  await act('back'); await has('解析中', 'list shows the running pill');
  await card('tsugumi'); await act('analyze'); await has('解析待ち', 'second game queued');
  await act('unqueue'); await has('この対局を解析する', 'unqueued'); await act('analyze'); await has('解析待ち', 'queued again');
  await wait(9000); await has('解析中', 'queued game started after the first finished');
  await wait(9500); await hasNot('解析待ち');
  await act('back'); await act('tab', 'set'); await has('10 / 20局', 'two precise analyses counted'); await has('33 / 100局', 'and both count toward the weekly total');
  await hasNot('リアルタイム解析（今月）', 'real-time minutes are not shown in the settings');
  await jump('queue'); await has('解析待ち', 'queue shortcut'); await has('いまの解析が終わると、続けて始まります');

  // 4. free plan: count goes down by one per analysis; saved precise results stay readable
  await ctl('.pg-ctl [data-state="lived"]'); await ctl('.pg-ctl [data-plan="free"]');
  await has('今週の解析 あと7局', 'free count on the list');
  await jump('fresh'); await ctl('.pg-ctl [data-plan="free"]'); await has('今週の解析 あと7局');
  await act('analyze'); await wait(500); await act('turns'); await wait(10000); await has('勝負所（12手）', 'the open list fills in when the analysis ends');
  ok(await tp('.tpn').count() === 1 && await tp('.tp .td').count() === 0, 'one note for the list, not a lock on every row');
  await has('有料プランでは、勝負所を5秒ずつ深く読みます');
  /* 開いたままプランが変わったら、案内も押した先（精密解析でのやり直し）に合わせる */
  await ctl('.pg-ctl [data-plan="paid"]'); await has('精密解析では、勝負所を5秒ずつ深く読みます', 'the open list follows a plan change'); await hasNot('有料プランでは、勝負所を5秒ずつ深く読みます', 'the open list follows a plan change');
  await ctl('.pg-ctl [data-plan="free"]'); await has('有料プランでは、勝負所を5秒ずつ深く読みます', 'the open list follows a plan change');
  await act('deeplock'); await has('深読みは、有料プランで使えます'); await click('#scr .dla [data-a="dlgok"]'); await has('月額'); await act('back');
  await act('back'); await has('あと6局', 'free count after one analysis');
  await jump('game'); await ctl('.pg-ctl [data-plan="free"]'); await has('2位', 'saved precise candidates readable on free');
  await act('turns'); ok(await tp('.tp .td').count() === 6 && await tp('.tpn').count() === 0, 'saved deep results stay readable on the free plan'); await act('closesheet');
  await act('ai'); await has('AIコーチは有料プランの機能です'); await act('aiclose');
  await jump('limit'); await ctl('.pg-ctl [data-plan="free"]'); await has('今週の解析は残り0局'); await has('月曜の午前0時に、また10局使えます');
  await act('nav', 'plan'); await has('月額');
  await ctl('.pg-ctl [data-plan="paid"]');

  // 4b. the coach works on a precise analysis only; an ordinary one can be done again as precise
  await jump('fresh'); await act('kind', 'std'); await has('候補1手・AIコーチなし'); await act('analyze'); await wait(10500);
  await act('turns'); await has('精密解析では、勝負所を5秒ずつ深く読みます'); await act('deeplock'); await has('精密解析でやり直しますか'); await act('dlgno');
  await act('ai'); await has('AIコーチは、精密解析した対局で使えます'); await has('精密解析でやり直す');
  await act('aianalyze'); await has('精密解析でやり直しますか'); await click('#scr .dla [data-a="dlgok"]'); await has('解析しています');
  await wait(10500); await has('どこを中心に説明しますか', 'coach available after the precise analysis'); await act('aiclose');
  await jump('limit'); await has('今週の精密解析は残り0局'); await has('ふつうの解析（候補1手）は使えます');
  await jump('set'); await has('利用規約・ライセンス'); await act('nav', 'about'); await has('プライバシーポリシー'); await hasNot('サーバーに送るもの', 'the about page has no facts box'); await hasNot('バージョン'); await act('back');
  await act('nav', 'names'); await has('サーバーには送りません'); await act('back');
  await act('nav', 'backup'); await has('iPhone と Android の間では、有料プランは引き継げません'); await act('back');
  await act('nav', 'plan'); await has('合計 週100局'); await has('AIコーチは月100回まで');
  await has('ふつうの解析 週10局'); await has('リアルタイム解析'); await hasNot('指すたびに評価値'); await hasNot('読み筋の評価値'); await hasNot('精密解析した対局', 'plan table');

  // 4c. the coach's uses and the real-time minutes are only mentioned when less than a tenth is left
  await jump('branch'); await wait(900); await hasNot('残り', 'no remaining minutes while plenty is left');
  await jump('low'); await has('リアルタイム解析は、今月あと24分使えます'); await has('残り24分');
  await act('ai'); await has('AIコーチは、今月あと7回使えます'); await act('aigen'); await wait(1800); await has('今月あと6回');
  for (let i = 0; i < 6; i++) { await click('#scr .sq'); await wait(1000); }
  await has('今月のAIコーチは上限に達しました', 'the coach stops at the limit, and the text stays readable'); await has('この対局のまとめ'); await act('aiclose');

  // 5. branch: play the recommended move, look at the line, return with the back button
  await jump('branch'); await wait(900); await has('分岐 1手目'); await has('本譜（48手目）に戻る');
  ok(await page.locator('#scr [data-a="turns"]').count() === 0, 'on a branch the same place is the way back');
  await act('back'); await hasNot('分岐 1手目', 'back button leaves the branch first'); await has('48手目');
  await act('back'); await has('棋譜', 'second back leaves the game');

  // 5b. 本譜の深く読む。時間を進めて深まり・休止・再開を確認する。
  await jump('game');
  await has('深く読む'); await hasNot('深く読んだ結果');
  const graph = () => page.locator('#scr [data-b="graph"] svg path:not(.g-brl)').evaluateAll((els) => els.map((e) => e.getAttribute('d')).join(';'));
  const before = await graph();
  await act('deepread'); await has('終了');
  await page.getByText('深く読んだ結果（深さ8）', { exact: true }).waitFor(); pass++;
  await page.getByText('深く読んだ結果（深さ10）', { exact: true }).waitFor(); pass++;
  ok(await graph() === before, 'deep reading never replaces the saved graph');
  await page.clock.install();
  await key('ArrowRight');
  await page.clock.fastForward(290000);
  await hasNot('休止中', 'moving restarts the five-minute timer');
  await page.clock.fastForward(10001);
  await has('休止中'); await has('再開');
  await act('rtretry'); await hasNot('休止中');
  await act('deepread'); await has('深く読む'); await hasNot('深く読んだ結果');
  await ctl('.pg-ctl [data-plan="free"]'); await act('deepread');
  await has('リアルタイム解析は、有料プランで使えます');
  await act('dlgno'); await ctl('.pg-ctl [data-plan="paid"]');

  await act('deepread'); await act('gmenu'); await act('ginfo');
  await page.clock.fastForward(300001);
  await act('back'); await has('深く読む', '対局情報から戻っても深読みは再開しない'); await hasNot('深く読んだ結果'); await hasNot('休止中');

  await jump('branch'); await page.clock.fastForward(1101);
  await act('playline'); await has('分岐 2手目');
  await page.locator('#scr [data-b="graph"]').click();
  await act('deepread'); await has('終了'); await act('toastact');
  await has('分岐 2手目'); await hasNot('深く読んだ結果');
  await page.clock.fastForward(30001);
  ok(await page.getByRole('button', { name: 'リアルタイム解析 オン、休止中', exact: true }).count() === 1, '深読み中に復元した分岐は30秒で休止する');

  // 6. result corrected to a draw: no leftover mate note, not counted in the win rate
  await jump('game'); await act('gmenu'); await act('ginfo'); await act('resedit'); await act('resset', 'd');
  await click('#scr .shh [data-a="closesheet"]'); await has('85手・引き分け'); await has('手で修正');
  await act('back'); await key('End'); await has('85手で終局'); await hasNot('（詰み）', 'no mate note on a draw');
  await jump('stats'); await has('勝率に数えていません');

  // 7. offline: the coach asks for a connection; an analysis pauses and resumes
  await jump('game'); await ctl('.pg-ctl [data-net="off"]'); await act('ai'); await click('#scr .sq');
  await has('通信できません'); await click('#scr .dla [data-a="dlgno"]'); await act('aiclose');
  await ctl('.pg-ctl [data-net="on"]');
  await jump('offline'); await wait(3300); await has('中断中'); await has('通信が戻ると、続きから再開します');
  await ctl('.pg-ctl [data-net="on"]'); await wait(900); await has('解析中', 'resumes when the connection is back');
  await jump('fail'); await act('turns'); await has('解析が終わると、印の付いた手がここに並びます。'); await wait(3200);
  await has('解析すると、悪手・疑問手・好手など 印の付いた手がここに並びます。', 'the open list follows a failed analysis'); await hasNot('解析が終わると', 'the open list follows a failed analysis'); await act('closesheet');
  await has('解析を終えられませんでした'); await has('回数は減っていません');

  // 7b. keep the list open while disconnecting and reconnecting in the second stage.
  await ctl('.pg-ctl [data-state="lived"]'); await jump('fresh');
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  await act('analyze'); await act('back');
  const pill = page.locator('#scr [data-runpill]');
  for (let i = 0; i < 150 && await pill.innerText() !== '深読み中 1/6'; i++)
    await page.clock.runFor(70);
  ok(await pill.innerText() === '深読み中 1/6', 'list shows the second-stage progress');
  await ctl('.pg-ctl [data-net="off"]'); await page.clock.runFor(70);
  ok(await pill.innerText() === '中断中', 'offline pill does not use first-stage counts');
  await ctl('.pg-ctl [data-net="on"]'); await page.clock.runFor(70);
  ok(await pill.innerText() === '深読み中 1/6', 'reconnection restores the same second-stage progress');
  await page.clock.resume();

  // 8. first launch: onboarding, empty library, sample record, import asks which side
  await ctl('.pg-ctl [data-state="first"]'); await has('kifumateへ ようこそ');
  await act('onbskip'); await has('まだ棋譜がありません');
  await act('sample'); await wait(500); await has('先手'); await has('最善');
  await act('turns'); await has('先手の勝率'); await has('有料プランでは、勝負所を5秒ずつ深く読みます', 'the sample record has no deep reading'); await act('closesheet');
  /* 観戦で盤の向きを変えても、勝率・印・一覧は先手の側のまま（アプリと同じ。変わるのは盤と対局者名の上下だけ） */
  const sente = async () => {
    await act('turns');
    const rows = await tp('.tp').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    await act('closesheet');
    return [await page.locator('#scr [data-b="bar"]').getAttribute('aria-label'), await page.locator('#scr [data-b="ro"]').innerText(), ...rows].join('\n');
  };
  const upright = await sente();
  await act('gmenu'); await act('gflip');
  ok(await page.locator('#scr [data-b="youav"]').innerText() === '☖', 'turning the board puts gote at the bottom');
  ok(upright.includes('先手の勝率') && upright.includes('先手の手') && upright.includes('後手の手') && await sente() === upright, 'turning the board leaves the win rate and the list on sente\'s side');
  await act('gmenu'); await act('gflip');
  await act('back'); await act('nav', 'import'); await act('imppaste'); await has('あなたはどちらですか？');
  await act('impside', 'g'); await has('あなたは後手');
  await act('impsave', '0'); await wait(2800); await has('この対局を解析する');
  /* 一覧を開いたまま初回の解析が終わったら、案内の前に一覧を閉じる（ほかの確認と同じ）。「見てみる」で移った先の盤が見える */
  await act('analyze'); await wait(500); await act('turns'); await has('解析が終わると、印の付いた手がここに並びます。'); await wait(10000); await has('はじめての解析ができました');
  ok(await page.locator('#scr [data-b="sheet"]').isHidden(), 'the first-analysis dialog closes the open list first');
  await click('#scr .dla [data-a="dlgok"]'); await has('54手目'); ok(await tpEntry('勝負所の一覧、12手') === 1, 'the entry shows the count after the first analysis');
  await act('back'); await act('nav', 'import'); await act('imppaste'); await has('同じ棋譜がすでに保存されています', 'duplicate blocked');

  await browser.close();
  console.log(`pass ${pass}, fail ${fail}`);
  console.log(errors.length ? errors.join('\n') : 'no page errors');
  process.exit(fail || errors.length ? 1 : 0);
})().catch((e) => { console.error('SCRIPT FAILED', String(e).split('\n').slice(0, 4).join('\n')); process.exit(1); });
