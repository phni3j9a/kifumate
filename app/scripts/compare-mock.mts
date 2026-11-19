import { seedGames, type MockGame } from "../tests/helpers/seed-games";
// モックとアプリ（Web 表示）を、同じ画面・同じ状態・同じ大きさで撮り、左右に並べた画像を作る。
//   npm run compare                     … 360×800 と 393×852 の全場面
//   npm run compare -- 393x852 game     … 大きさと、名前に game を含む場面だけ
// 出力は .local/compare/<幅x高さ>/NN-名前.png（左：モック、中：アプリ Web、右：あれば Android 実機）。
// 実機の画面は `adb exec-out screencap -p > .local/compare/android/名前.png` で置くと、3列目に並ぶ。
// 未実装の購入先や、実モデル用の待機・失敗表示の追加は差として残す。
import { fakeAnalysis } from "../tests/helpers/fake-analysis";
import type { AnalysisResult } from "../src/analysis/types";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";

const APP = process.env.APP_URL || "http://localhost:8081";
const MOCK = "file://" + path.resolve("../mock/dist/app-pop.standalone.html");
const OUT = ".local/compare";
const args = process.argv.slice(2);
const sizes = args.filter((a) => /^\d+x\d+$/.test(a));
const only = args.filter((a) => !/^\d+x\d+$/.test(a));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureServer() {
  const up = () =>
    fetch(APP).then(
      (r) => r.ok,
      () => false,
    );
  if (await up()) return null;
  const server = spawn(
    "npm",
    ["run", "web", "--", "--port", new URL(APP).port],
    {
      stdio: "ignore",
      detached: true,
    },
  );
  for (let i = 0; i < 120 && !(await up()); i++) await pause(1000);
  return server;
}

async function run(width: number, height: number) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const m = await context.newPage(), // モック
    a = await context.newPage(), // アプリ
    sheet = await browser.newPage(); // 並べる台紙
  const errors: string[] = [];
  a.on("pageerror", (e) => {
    errors.push(e.message);
    console.error("ページエラー:", e.message);
  });
  const fake = await fakeAnalysis(a, { onboarding: true, firstReview: true });
  fake.paid = false;
  fake.remaining = 10;
  await m.goto(MOCK);
  await m.setContent(
    readFileSync(new URL(MOCK), "utf8").replace(
      "\n})();\n</script>",
      "\nwindow.__compare = code => eval(code);\n})();\n</script>",
    ),
  );
  await a.goto(APP);
  await m.waitForTimeout(1300);
  // モックの説明欄を消して、画面を左上にぴったり置く（半端な位置だと線がにじみ、差に出る）
  await m.addStyleTag({ content: ".pg-head,.notes{display:none!important}" });
  await a.getByText("kifumateへ ようこそ").waitFor({ timeout: 120000 });
  await a.getByRole("button", { name: "スキップ", exact: true }).click();
  await a.getByText("まだ棋譜がありません").waitFor();
  await a.evaluate(() => document.fonts.ready);
  const dir = `${OUT}/${width}x${height}`;
  for (const d of [dir, `${dir}/mock`, `${dir}/app`])
    mkdirSync(d, { recursive: true });

  /* ---- モックの操作（mock/tools/capture.js と同じやり方） ---- */
  const click = async (sel: string) => {
    await m.evaluate((s) => {
      const el = [...document.querySelectorAll<HTMLElement>(s)].find(
        (e) => e.offsetParent !== null,
      );
      if (!el) throw new Error("モックに見つからない: " + s);
      el.click();
    }, sel);
    await m.waitForTimeout(160);
  };
  const act = (name: string, v?: string) =>
    click(`#scr [data-a="${name}"]${v != null ? `[data-v="${v}"]` : ""}`);
  // 画面の外にある切り替え（状態・プラン）。消してあるので、見えているかは問わずに押す
  const ctl = async (sel: string) => {
    await m.evaluate(
      (s) => document.querySelector<HTMLElement>(s)!.click(),
      sel,
    );
    await m.waitForTimeout(300);
  };
  const plan = (p: "free" | "paid") => ctl(`.pg-ctl [data-plan="${p}"]`);
  const closeSheet = () => click('#scr .shh [data-a="closesheet"]');
  // 見本の2局目は後手が自分なので、盤は後手側から見ている
  const mockSquare = async (f: number, r: number) => {
    const b = (await m.locator("#scr .bdw svg.bd").boundingBox())!;
    await m.touchscreen.tap(
      b.x + ((10 + (f - 1) * 100 + 50 + 4) / 952) * b.width,
      b.y + ((38 + (9 - r) * 108 + 54 + 4) / 1042) * b.height,
    );
    await m.waitForTimeout(150);
  };
  /* ---- アプリの操作 ---- */
  const button = (name: string) => a.getByRole("button", { name, exact: true });
  const tap = async (name: string) => {
    await button(name).first().click();
    await a.waitForTimeout(250);
  };
  const tab = async (name: string) => {
    await a
      .getByRole("tab", { name })
      .click({ timeout: 15000 })
      .catch(async (e) => {
        await a.screenshot({ path: ".local/compare-failure.png" });
        console.error(await a.locator("body").innerText());
        throw e;
      });
    await a.waitForTimeout(250);
  };
  const appSquare = async (f: number, r: number) => {
    await a.getByTestId(`square-${f}-${r}`).click();
    await a.waitForTimeout(150);
  };
  const both = async (f: number, r: number) => {
    await mockSquare(f, r);
    await appSquare(f, r);
  };

  let n = 0;
  const shot = async (name: string) => {
    const file = `${String(++n).padStart(2, "0")}-${name}.png`;
    if (only.length && !only.some((o) => name.includes(o))) return;
    await pause(
      name.startsWith("analysis-") || name.startsWith("realtime-") ? 2800 : 350,
    );
    await m.screenshot({ path: `${dir}/mock/${file}` });
    await a.screenshot({ path: `${dir}/app/${file}` });
    const android = `${OUT}/android/${name}.png`;
    const img = (f: string) =>
      `data:image/png;base64,${readFileSync(f).toString("base64")}`;
    const cols: [string, string][] = [
      ["モック", `${dir}/mock/${file}`],
      ["アプリ（Web）", `${dir}/app/${file}`],
    ];
    if (existsSync(android)) cols.push(["アプリ（Android 実機）", android]);
    // 4列目は、モックとアプリ（Web）の画素の差。同じところは黒、ちがうところが浮き出る。
    await sheet.setViewportSize({
      width: (cols.length + 1) * (width + 16) + 16,
      height: height + 44,
    });
    await sheet.setContent(
      `<body style="margin:0;padding:8px 16px;display:flex;gap:16px;background:#E7E8EA;font:600 13px/28px sans-serif">${cols
        .map(
          ([label, f]) =>
            `<div>${label}　${name}<br><img src="${img(f)}" style="display:block;width:${width}px;outline:1px solid #999"></div>`,
        )
        .join(
          "",
        )}<div>差（モック − Web）<br><canvas width="${width * 2}" height="${height * 2}" style="display:block;width:${width}px;outline:1px solid #999"></canvas></div></body>`,
    );
    await sheet.evaluate(async () => {
      const [one, two] = [...document.images];
      await Promise.all([one!.decode(), two!.decode()]);
      const c = document.querySelector("canvas")!.getContext("2d")!;
      c.drawImage(one!, 0, 0);
      c.globalCompositeOperation = "difference";
      c.drawImage(two!, 0, 0);
    });
    await sheet.screenshot({ path: `${dir}/${file}` });
  };

  /* ---- 場面。左右で同じ状態になるように、同じ順に操作する ---- */
  await ctl('.jump [data-jump="empty"]'); // 何も保存されていない状態（無料プラン）
  await shot("list-empty");
  await act("kifhelp");
  await tap("KIFってなに？ どこで手に入る？");
  await shot("sheet-kif-help");
  await closeSheet();
  await tap("閉じる");
  await act("tab", "stats");
  await tab("戦績");
  await shot("stats-empty");

  // 取り込み：名前が未登録のとき
  await act("tab", "list");
  await tab("棋譜");
  await act("nav", "import");
  await tap("棋譜を取り込む");
  await shot("import-empty");
  await act("imptab", "file");
  await a.getByRole("radio", { name: "ファイル" }).click();
  await shot("import-file-tab");
  await act("imptab", "paste");
  await a.getByRole("radio", { name: "テキスト" }).click();
  await m.fill("#kif-in", "これは棋譜ではありません");
  await a
    .getByRole("textbox", { name: "KIF形式の棋譜" })
    .fill("これは棋譜ではありません");
  await a.getByText("棋譜として読み取れませんでした").waitFor();
  await shot("import-invalid");
  await act("imppaste"); // モックの見本の棋譜を、アプリにも同じ文字で入れる
  const kif = await m.inputValue("#kif-in");
  await a.getByRole("textbox", { name: "KIF形式の棋譜" }).fill(kif);
  await a.getByText("あなたはどちらですか？").waitFor();
  const bottom = async () => {
    await m.evaluate(
      () => (document.querySelector("#scr .pgc")!.scrollTop = 9999),
    );
    await a.mouse.move(width / 2, height / 2);
    await a.mouse.wheel(0, 9999);
    await pause(200);
  };
  await bottom();
  await shot("import-who-are-you");
  await act("back");
  await tap("閉じる");

  // 設定と、その下の画面
  await act("tab", "set");
  await tab("設定");
  await shot("settings");
  // 招待版はモック既存のカード・入力・比較表を組み合わせる。モックの製品外ファイルは変更しない。
  const invitationMock = async (paid = false, message = "") => {
    await m.evaluate(
      ({ paid, message }) =>
        (window as any).__compare(
          `push({t:'names'}); R.vpage.querySelector('.ph h2').textContent='招待コード'; R.vpage.querySelector('.pgc').innerHTML=${JSON.stringify(`<div class="cd" style="padding:14px"><b style="display:block;font-size:16px;font-weight:900;line-height:1">${paid ? "有料プランを利用中" : "無料プラン"}</b>${paid ? '<p class="hint">期限なし</p>' : ""}<button class="bt sm" style="margin-top:10px">今の権利を確認</button></div><h3 class="st">コードを入力</h3><p class="hint" style="margin-top:0">招待コードで、精密解析・分岐中の解析・AIコーチが使えます。この端末で有効になります。</p><input class="inp" placeholder="ABCD-EFGH-JKMN-PQRS" aria-label="招待コード"><p class="hint">大文字・小文字や全角・半角は、どちらでも入力できます。区切りは自動で入ります。</p><button class="bt pri wide">コードを使う</button>${message ? `<p style="font-size:13px;font-weight:700;line-height:1.6">${message}</p>` : ""}<p class="hint">機種変更やアプリの削除で、別の端末に権利を引き継ぐことはできません。コードには期限や使える端末数の上限があります。</p>`)};`,
        ),
      { paid, message },
    );
  };
  await invitationMock();
  await a.getByRole("button", { name: /招待コードを入力/ }).click();
  await shot("invitation-empty");
  await a
    .getByRole("textbox", { name: "招待コード", exact: true })
    .fill("abcdefghjkmnpqrs");
  await m.locator('[aria-label="招待コード"]').fill("ABCD-EFGH-JKMN-PQRS");
  await shot("invitation-input");
  fake.inviteError = "invite_invalid";
  await tap("コードを使う");
  const invalid =
    "コードが違うか、期限が切れているか、取り消されています。コードを確かめ、発行した人にご相談ください。";
  await act("back");
  await invitationMock(false, invalid);
  await m.locator('[aria-label="招待コード"]').fill("ABCD-EFGH-JKMN-PQRS");
  await shot("invitation-invalid");
  fake.inviteError = "";
  await tap("コードを使う");
  await a.getByText("有料プランを利用中", { exact: true }).waitFor();
  await act("back");
  await invitationMock(
    true,
    "招待コードを確認しました。有料機能が使えるようになりました。",
  );
  await shot("invitation-paid");
  await act("back");
  await tap("戻る");
  await act("nav", "plan");
  await a
    .getByRole("button", { name: /プランの内容を見る|有料プランを見る/ })
    .click();
  await m.evaluate(() =>
    (window as any).__compare(
      `R.vpage.querySelector('.pwl').innerHTML=pic('onb-5','pwi')+'<div><b style="font-size:18px;font-weight:900">招待コードで使えます</b><p>精密解析、分岐中の解析、AIコーチの解説と質問が使えます。</p></div>'; R.vpage.querySelector('.mockn').remove(); R.vpage.querySelector('.acts').innerHTML='<button class="bt pri wide">招待コードを入力</button><p class="hint">招待コードはこの端末だけで使えます。期限が切れたり、取り消されたりすると無料プランに戻ります。保存した解析結果と解説は、そのあとも読めます。</p>'; R.vpage.querySelector('.lnk').remove(); R.vpage.querySelector('.pgc').insertAdjacentHTML('afterbegin','<div class="cd" style="padding:14px"><b style="display:block;font-size:16px;font-weight:900;line-height:1">有料プランを利用中</b><p class="hint">期限なし</p><button class="bt sm" style="margin-top:10px">今の権利を確認</button></div>');`,
    ),
  );
  await shot("plan-invite-paid");
  fake.paid = false;
  await a.getByRole("button", { name: "今の権利を確認", exact: true }).click();
  await m.evaluate(() =>
    (window as any).__compare(
      `const card=R.vpage.querySelector('.pgc>.cd'); card.querySelector('b').textContent='無料プラン'; card.querySelector('.hint').remove();`,
    ),
  );
  await shot("plan-invite-free");
  await act("back");
  await tap("戻る");
  fake.remaining = 10;
  await a.reload();

  await m.evaluate(() =>
    (window as any).__compare(
      "DB.profile={practice:[],goal:''}; DB.style={focus:'総合',detail:'ふつう'}; show()",
    ),
  );
  await act("nav", "profile");
  await a.getByRole("button", { name: /^学習プロフィール/ }).click();
  await shot("coach-profile-free");
  await act("pract", "四間飛車");
  await tap("四間飛車");
  await m.fill(
    "#goal-in",
    "アマ初段になりたい。終盤で詰みを逃さないようにしたい。",
  );
  await a
    .getByRole("textbox", { name: "目標", exact: true })
    .fill("アマ初段になりたい。終盤で詰みを逃さないようにしたい。");
  await shot("coach-profile");
  await act("back");
  await tap("戻る");

  await act("nav", "names");
  await a.getByText("自分の対局者名", { exact: true }).click();
  await shot("names-empty");
  await m.fill("#name-in", "tsubame");
  await m.press("#name-in", "Enter");
  await a.getByRole("textbox", { name: "追加する対局者名" }).fill("tsubame");
  await tap("追加");
  await m.fill("#name-in", "つばめ");
  await m.press("#name-in", "Enter");
  await a.getByRole("textbox", { name: "追加する対局者名" }).fill("つばめ");
  await tap("追加");
  await shot("names");
  await act("namedel", "1");
  await tap("つばめ を削除");
  await shot("toast-undo");
  await act("toastact");
  await tap("元に戻す");
  await act("back");
  await tap("戻る");
  await act("nav", "about");
  await a.getByText("このアプリについて", { exact: true }).click();
  await shot("about");
  await act("back");
  await tap("戻る");

  // 取り込み：名前と一致、保存
  await act("tab", "list");
  await tab("棋譜");
  await act("nav", "import");
  await tap("棋譜を取り込む");
  await act("imppaste");
  await a.getByRole("textbox", { name: "KIF形式の棋譜" }).fill(kif);
  await a.getByText("重複はありません").waitFor();
  await shot("import-ok-top");
  await bottom();
  await shot("import-ok-bottom");
  await act("impsave", "0");
  await tap("保存だけする");
  await a.getByText("開始局面").waitFor();
  const gameUrl = a.url();
  await shot("game-saved-toast");
  await pause(2800);
  await shot("game-not-analysed");
  await act("evalhelp");
  await tap("評価値");
  await shot("sheet-evaluation-help");
  await closeSheet();
  await tap("閉じる");
  await act("ai");
  await tap("AIに聞く");
  await shot("coach-lock");
  await act("aiclose");
  await tap("AIコーチを閉じる");
  fake.paid = true;
  await plan("paid");
  await a.reload();
  await tap("AIに聞く");
  await act("ai");
  await shot("coach-need-precise");
  await act("aiclose");
  await tap("AIコーチを閉じる");
  fake.paid = false;
  await plan("free");
  await a.reload();
  await button("AIに聞く").waitFor();

  for (let i = 0; i < 60; i++) {
    await m.keyboard.press("ArrowRight");
    await button("1手進む").click();
  }
  await shot("game-midgame");
  await act("kf");
  await tap("棋譜を開く");
  await shot("sheet-moves");
  await closeSheet();
  await tap("閉じる");
  await act("gmenu");
  await tap("この対局のメニュー");
  await shot("sheet-menu");
  await act("kifout");
  await tap("KIFを書き出す");
  await shot("sheet-kif-export");
  await closeSheet();
  await tap("閉じる");
  // 38手目の局面で ▲2三歩 は成・不成を選べる
  for (let i = 0; i < 22; i++) {
    await m.keyboard.press("ArrowLeft");
    await button("1手戻る").click();
  }
  await both(2, 4);
  await shot("game-piece-picked");
  await both(2, 3);
  await shot("game-promote-choice");
  await both(9, 5); // 何もないマスで取り消す
  // 開始局面から、本譜とちがう手（▲2六歩 △3四歩）で分岐する
  await m.keyboard.press("Home");
  await tap("最初へ");
  await both(2, 7);
  await both(2, 6);
  await shot("branch-first-move-toast");
  await pause(2800);
  await both(3, 3);
  await both(3, 4);
  await shot("branch");
  // 分岐中の解析。モックの休止はオンのまま、結果と盤を保つ（次の手で準備し直す）。
  await shot("realtime-free");
  const rtMock = (code: string) =>
    m.evaluate((code) => (window as any).__compare(code), code);
  fake.paid = true;
  fake.rt.status = "preparing";
  await plan("paid");
  await a.reload();
  await button("解析する").waitFor();
  await appSquare(2, 7);
  await appSquare(2, 6);
  await appSquare(3, 3);
  await appSquare(3, 4);
  await button("分岐中の解析 オン").click();
  await rtMock("S.rtOn=false; stopRt(); renderPly()");
  await shot("realtime-off");
  await button("オンにする").click();
  await tap("1手戻る");
  await tap("1手進む");
  await rtMock(
    "S.rtOn=true; S.rtWarm=false; S.rtUntil=performance.now()+60000; renderPly()",
  );
  await a.getByText("準備中", { exact: true }).waitFor();
  await shot("realtime-preparing");
  fake.rt.status = "analyzing";
  await rtMock("S.rtWarm=true; renderPly()");
  await a.getByText("この局面の評価値と最善手を調べています").waitFor();
  await shot("realtime-analyzing");
  fake.rt.result = {
    ply: 2,
    score: { kind: "cp", value: 50 },
    candidates: [
      {
        rank: 1,
        depth: 10,
        move: "7g7f",
        score: { kind: "cp", value: 50 },
        pv: ["7g7f", "8c8d"],
      },
    ],
    mate: null,
  };
  fake.rt.status = "ready";
  fake.rt.idleMs = 10;
  await rtMock(
    "S.rtUntil=0; brNow().an={known:true,cp:50,mate:null,lines:[],next:moveOfUsi('7g7f','▲７六歩'),pv:['△８四歩']}; renderPly()",
  );
  await button("この手を盤で試す").waitFor();
  await shot("realtime-result");
  fake.rt.status = "paused";
  await rtMock("S.rtWarm=false; renderPly()");
  await button("分岐中の解析 オン、休止中").waitFor();
  await shot("realtime-paused");
  // 通信なし・上限では、この局面に保存した結果がない場面を比べる。
  fake.rt.result = null;
  fake.online = false;
  await tap("1手戻る");
  await tap("1手進む");
  await rtMock(
    "brNow().an={known:false,lines:[]}; DB.online=false; renderPly()",
  );
  await button("分岐中の解析 通信なし").waitFor();
  await shot("realtime-offline");
  fake.online = true;
  fake.rt.status = "ready";
  fake.rt.result = {
    ply: 2,
    score: { kind: "cp", value: 50 },
    candidates: [
      {
        rank: 1,
        depth: 10,
        move: "7g7f",
        score: { kind: "cp", value: 50 },
        pv: ["7g7f", "8c8d"],
      },
    ],
    mate: null,
  };
  fake.rt.low = true;
  fake.rt.remainingMs = 12 * 60000;
  await tap("もう一度試す");
  await rtMock(
    "DB.online=true; DB.usage.rt=DB.usage.rtMax-12; brNow().an={known:true,cp:50,mate:null,lines:[],next:moveOfUsi('7g7f','▲７六歩'),pv:['△８四歩']}; renderPly()",
  );
  await button("分岐中の解析 オン・残り12分").waitFor();
  await pause(2800);
  await shot("realtime-low");
  fake.rt.status = "limit";
  fake.rt.remainingMs = 0;
  await rtMock("DB.usage.rt=DB.usage.rtMax; renderPly()");
  await button("分岐中の解析 残り0分").waitFor();
  await button("更新日").waitFor();
  // モックは結果優先で上限の説明を隠すため、アプリ側だけ同じ文言の案内を別に残す。
  await shot("realtime-limit-result");
  fake.rt.result = null;
  await tap("1手戻る");
  await tap("1手進む");
  await rtMock(
    "DB.usage.rt=DB.usage.rtMax; brNow().an={known:false,lines:[]}; renderPly()",
  );
  await button("分岐中の解析 残り0分").waitFor();
  await shot("realtime-limit");
  // 後続の既存場面へ、同じ無料・2手の分岐を戻す。
  fake.paid = false;
  fake.rt.low = false;
  fake.rt.remainingMs = 18000000;
  fake.rt.idleMs = 30000;
  fake.rt.status = "ready";
  fake.rt.result = undefined;
  await plan("free");
  await a.reload();
  await button("解析する").waitFor();
  await appSquare(2, 7);
  await appSquare(2, 6);
  await appSquare(3, 3);
  await appSquare(3, 4);
  await act("kf");
  await tap("棋譜を開く");
  await shot("sheet-branch-moves");
  await closeSheet();
  await tap("閉じる");
  await rtMock("setPly(0)");
  await a
    .getByRole("slider", { name: /形勢グラフ/ })
    .click({ position: { x: 35, y: 20 } });
  await button("分岐に戻る").waitFor();
  await shot("branch-undo");
  await act("toastact");
  await tap("分岐に戻る");
  await act("exitbr");
  await tap("本譜に戻る");
  // 対局情報、結果の修正、削除の確認
  await act("gmenu");
  await tap("この対局のメニュー");
  await act("ginfo");
  await tap("対局情報");
  await shot("info");
  await act("resedit");
  await tap("結果を修正");
  await shot("sheet-result-edit");
  await closeSheet();
  await tap("閉じる");
  await act("back");
  await tap("戻る");
  await act("gmenu");
  await tap("この対局のメニュー");
  await act("gdel");
  await tap("この棋譜を削除");
  await shot("dialog-delete");
  await act("dlgno");
  await tap("やめる");

  // 一覧（1局）、絞り込み、検索結果なし、重複
  await act("back");
  await tap("戻る");
  await plan("paid"); // 無料プランの一覧は、解析の残り回数（次の段階で追加）が見出しに入る
  await shot("list");
  await act("filter");
  await tap("絞り込み");
  await shot("sheet-filter");
  await closeSheet();
  await tap("閉じる");
  await act("search");
  await tap("検索");
  await m.fill("#q", "zzz");
  await a.getByLabel("棋譜を検索").fill("zzz");
  await shot("list-no-results");
  await act("search");
  await tap("検索を閉じる");
  await plan("free");
  await act("nav", "import");
  await tap("取り込む");
  await act("imppaste");
  await a.getByRole("textbox", { name: "KIF形式の棋譜" }).fill(kif);
  await a.getByText("同じ棋譜がすでに保存されています").waitFor();
  await shot("import-duplicate");

  // 解析の全状態。モックの局面・値をAPI境界から渡し、製品コードに架空の結果を入れない。
  await act("back");
  await m.evaluate(() => {
    const w = window as any;
    w.__compare("A.open(DB.games[0].id)");
  });
  await a.goto(gameUrl);
  const sample = JSON.parse(
    readFileSync("../mock/data/sample-game-2.json", "utf8"),
  );
  const score = (p: any) =>
    p.mate != null
      ? { kind: "mate", value: p.mate, winner: p.mate < 0 ? "gote" : "sente" }
      : { kind: "cp", value: p.cp };
  fake.results = sample.positions.map((p: any) => ({
    ply: p.ply,
    score: score(p),
    candidates: p.cands.map((c: any, i: number) => ({
      rank: i + 1,
      depth: 10,
      score: score(c),
      move: c.usi,
      pv: c.pvUsi,
    })),
    mate: p.tsume
      ? {
          plies: p.tsume.len,
          pv: p.tsume.line.map((m: any) => m.usi),
          branches: [],
        }
      : null,
  })) as AnalysisResult[];
  // アプリ側の待機中にモックが完了しないよう、開始とタイマー停止を同じイベント内で行う。
  await m.evaluate(() => {
    (window as any).__compare(
      "A.analyze(); clearInterval(RUN.timer); RUN.done=30; renderGame();",
    );
  });
  await tap("解析する");
  await a.getByRole("button", { name: "中止", exact: true }).waitFor();
  fake.next = 31;
  await pause(2300);
  await shot("analysis-running");
  await m.evaluate(() => {
    (window as any).__compare("RUN.paused=true; renderGame();");
  });
  fake.online = false;
  await pause(2300);
  await shot("analysis-paused");
  fake.online = true;
  await m.evaluate(() => {
    (window as any).__compare("RUN.paused=false; renderGame();");
  });
  await act("stopan");
  await tap("中止");
  await shot("analysis-stop-confirm");
  await act("dlgok");
  await tap("中止する");
  await pause(500);
  await m.evaluate(() => {
    (window as any).__compare(
      "QUEUE.push({id:CUR.id,kind:'std'}); renderGame();",
    );
  });
  fake.status = "queued";
  fake.next = 0;
  await tap("解析する");
  await pause(400);
  await shot("analysis-queued");
  await act("unqueue");
  await tap("やめる");
  await pause(400);
  await m.evaluate(() => {
    (window as any).__compare("CUR.err=true; renderGame();");
  });
  fake.status = "failed";
  fake.next = 0;
  await tap("解析する");
  await pause(500);
  await shot("analysis-failed");
  await m.evaluate(() => {
    (window as any).__compare("CUR.err=false; DB.usage.free=10; renderGame();");
  });
  fake.remaining = 0;
  fake.createStatus = 429;
  await tap("もう一度");
  await pause(500);
  await shot("analysis-limit");
  await m.evaluate(() => {
    (window as any).__compare(
      "DB.usage.free=0; DB.online=false; renderGame();",
    );
  });
  fake.online = true;
  fake.remaining = 10;
  await a.goto(APP + "/settings");
  await pause(500);
  await a.goto(gameUrl);
  // APIの上限エラー表示は、再依頼してから通信断にすることで通常の未解析表示へ戻す。
  fake.createStatus = 202;
  fake.status = "running";
  await tap("もう一度");
  await pause(400);
  await tap("中止");
  await tap("中止する");
  await pause(300);
  fake.online = false;
  await a.goto(APP + "/settings");
  await pause(600);
  await a.goto(gameUrl);
  await a.bringToFront();
  await a
    .getByText("通信できません。つながると解析できます", { exact: true })
    .waitFor({ timeout: 15000 });
  await shot("analysis-offline");
  fake.online = true;
  fake.remaining = 99;
  fake.precise = 19;
  fake.paid = true;
  fake.createStatus = 202;
  fake.status = "running";
  await m.evaluate(() => {
    (window as any).__compare(
      "DB.online=true; DB.plan='paid'; syncPlan(); renderGame();",
    );
  });
  // quotaの更新を明示的に待つ（画面の再読み込みでも永続outboxから復帰する）。
  await a.goto(APP + "/settings");
  await a.getByText("有料プラン", { exact: true }).waitFor();
  await a.goto(gameUrl);
  await tap("精密解析");
  // 期限切れの応答不明は新しい解析を始めず、モックの共通ask部品と確認画面を比べる。
  fake.loseCreateResponse = true;
  await tap("解析する");
  await a.getByText("中断中", { exact: true }).first().waitFor();
  await a.clock.setSystemTime(new Date(Date.now() + 7 * 86400000));
  await a.reload();
  await tap("依頼を確認");
  await m.evaluate(() =>
    (window as any).__compare(
      "ask('前回の依頼の結果が分かりません','保存期間が過ぎている可能性があります。もう一度解析すると、今週の回数を新たに使うことがあります。','もう一度解析する',null,{no:'やめる'})",
    ),
  );
  await shot("analysis-expired-request");
  await act("dlgno");
  await tap("やめる");
  fake.loseCreateResponse = false;
  await tap("依頼を確認");
  await tap("もう一度解析する");
  fake.complete = true;
  await a
    .getByRole("button", { name: "中止", exact: true })
    .waitFor({ state: "hidden" });
  await a.getByRole("button", { name: "3位", exact: true }).waitFor();
  await rtMock(
    "DB.celebrated=false; RUN={id:CUR.id,kind:'pre',timer:0}; finishRun()",
  );
  await button("見てみる").waitFor();
  await shot("dialog-first-review");
  await act("dlgok");
  await tap("見てみる");
  await m.evaluate(() => {
    (window as any).__compare("CUR.an='pre'; CUR.err=false; renderGame();");
  });
  await m.keyboard.press("Home");
  await tap("最初へ");
  await shot("analysis-completed");
  // AIコーチ。非同期の偽APIだけを使い、実モデルへの費用は発生させない。
  const aiMock = (code: string) =>
    m.evaluate((code) => (window as any).__compare(code), code);
  await act("ai");
  await tap("AIに聞く");
  await shot("coach-style");
  await aiMock("AI.gen=true; renderAI()");
  fake.coach.status = "pending";
  await tap("解説をつくる");
  await a.getByText("解説を作っています…", { exact: true }).waitFor();
  await shot("coach-thinking");
  await aiMock(
    "AI.gen=false; CUR.ai={focus:AI.focus,detail:AI.detail,html:commentary(AI.focus,AI.detail),chat:[]}; renderAI()",
  );
  // 本文の内容をそろえて部品を比較。モック固有の「見本文」の注記だけを外す。
  fake.coach.sections = (await m
    .locator("#ai-main .blk, #scr .aim .blk")
    .evaluateAll((els) =>
      els.map((el) => ({
        kind: el.classList.contains("adv") ? "advice" : "facts",
        title: el.querySelector("h4")!.firstChild!.textContent!,
        text: [...el.querySelectorAll("p")]
          .map((p) => p.textContent)
          .join("\n"),
        references: [],
      })),
    )) as typeof fake.coach.sections;
  if (!fake.coach.sections.length)
    throw new Error("比較用のモック解説がありません");
  await m
    .locator("#scr .ain")
    .evaluate(
      (el) =>
        (el.textContent =
          "数字と指し手は、解析結果のままです。説明の文章はAIが書いています。"),
    );
  fake.coach.status = "completed";
  await a.getByText("この対局のまとめ", { exact: true }).waitFor();
  await shot("coach-commentary");
  await act("aisize");
  await tap("大きくする");
  await aiMock(
    "CUR.ai.chat.push({q:'次に何を練習するといい？',a:aiQuestions().find(q=>q.q==='次に何を練習するといい？').a(),face:'chat-explaining'}); renderAI(); R.aim.scrollTop=R.aim.scrollHeight",
  );
  fake.coach.sections = [
    {
      kind: "advice",
      title: "答え",
      text: "気になった局面を、分岐で指し直して確かめてみましょう。相手の手を自分で指してみると、ねらいが分かりやすくなります。",
      references: [],
    },
  ];
  await tap("次に何を練習するといい？");
  await a.getByText("答え", { exact: true }).waitFor();
  await a
    .getByTestId("coach-sheet")
    .getByText("答え", { exact: true })
    .scrollIntoViewIfNeeded();
  await shot("coach-question");
  // AI固有の失敗はモックにないため、共通の文章部品で同じ理由を並べる。
  fake.coach.status = "failed";
  await a
    .getByRole("textbox", { name: "AIコーチへの質問" })
    .fill("もう少し教えて");
  await tap("質問を送る");
  await a
    .getByText(
      "解説を終えられませんでした。回数は減っていません。もう一度試せます",
      { exact: true },
    )
    .waitFor();
  await aiMock(
    "R.aim.innerHTML='<p class=hint>解説を終えられませんでした。回数は減っていません。もう一度試せます</p><button class=tx-b>もう一度試す</button>'+R.aim.innerHTML; R.aim.scrollTop=0",
  );
  await a
    .getByText(
      "解説を終えられませんでした。回数は減っていません。もう一度試せます",
      { exact: true },
    )
    .scrollIntoViewIfNeeded();
  await shot("coach-failed");
  fake.coach.online = false;
  await act("aiclose");
  await tap("AIコーチを閉じる");
  await act("ai");
  await tap("AIに聞く");
  await a.getByText(/通信できません。保存済みの解説/).waitFor();
  await aiMock(
    "R.aim.innerHTML='<p class=hint>通信できません。保存済みの解説は読めます。つながってから、もう一度試してください。</p><button class=tx-b>もう一度試す</button>'+R.aim.innerHTML",
  );
  await shot("coach-offline");
  fake.coach.online = true;
  fake.coach.remaining = 0;
  fake.coach.low = true;
  await act("aiclose");
  await tap("AIコーチを閉じる");
  await aiMock("CUR.ai=null; DB.usage.ai=DB.usage.aiMax");
  await a.evaluate(async () => {
    const r = (globalThis as any).__r;
    const mod = [...r.getModules().entries()].find(
      ([, m]: any) =>
        m.verboseName === "node_modules/expo-sqlite/build/index.js",
    ) as any;
    const db = await r(mod[0]).openDatabaseAsync("kifumate.db");
    await db.runAsync("DELETE FROM coaches");
  });
  await a.reload();
  await tap("最初へ");
  await pause(2800);
  await act("ai");
  await tap("AIに聞く");
  await shot("coach-limit");
  await act("aiclose");
  await tap("AIコーチを閉じる");
  fake.coach.remaining = 99;
  fake.coach.low = false;
  await aiMock("DB.usage.ai=37");

  await act("cand", "1");
  await tap("2位");
  await shot("analysis-candidate-2");
  await act("cand", "2");
  await tap("3位");
  await shot("analysis-candidate-3");
  // グラフは手数を直接指定せず、実際の手順操作で同じ詰み局面へ移動。
  await m.evaluate(() => (window as any).__compare("setPly(92)"));
  await tap("最初へ");
  for (let i = 0; i < 92; i++) await button("1手進む").click();
  await shot("analysis-proven-mate");
  await act("back");
  await tap("戻る");
  await act("tab", "set");
  await tab("設定");
  await m.evaluate(() =>
    (window as any).__compare("DB.usage.precise=1; DB.usage.total=1; show();"),
  );
  await shot("analysis-settings-paid");
  await plan("free");
  fake.paid = false;
  fake.remaining = 9;
  await a.reload();
  await pause(700);
  await m.evaluate(() => (window as any).__compare("DB.usage.free=1; show();"));
  await shot("analysis-settings-free");
  // 戦績はモックの架空24局を検証DBへ同じタグ・勝敗で入れる。製品の判定精度とは独立した見た目の比較。
  await m.evaluate(() =>
    (window as any).__compare(
      "GSEQ=0; seedData(); DB.games.forEach(g=>g.an='none'); NAV.length=0; UI.tab='stats'; UI.st={period:'',side:'',dim:'myst'}; show()",
    ),
  );
  const statFixtures = (await m.evaluate(() =>
    (window as any).__compare(
      "DB.games.map(({id,date,sente,gote,self,win,plies,fav,tags})=>({id,date,sente,gote,self,win,plies,fav,tags}))",
    ),
  )) as MockGame[];
  await a.clock.setSystemTime(new Date("2026-11-16T12:00:00Z"));
  await seedGames(a, statFixtures);
  await tab("戦績");
  await shot("stats-summary");
  await bottom();
  await shot("stats-strategies");
  await act("stset", "dim:mycs");
  await a.getByRole("radio", { name: "自分の囲い", exact: true }).click();
  await bottom();
  await shot("stats-castles");
  await act("strow", "美濃囲い");
  await a.getByRole("button", { name: /^美濃囲い .*の対局を表示$/ }).click();
  await shot("stats-records");
  await act("back");
  await tap("戻る");
  await m.evaluate(() =>
    (window as any).__compare("UI.st.period='30'; UI.st.side='g'; show()"),
  );
  await a.getByRole("radio", { name: "30日", exact: true }).click();
  await a.getByRole("radio", { name: "後手", exact: true }).click();
  await a.mouse.wheel(0, -9999);
  await shot("stats-filtered");
  // 期間内に1局もない状態。
  const oldFixtures = [{ ...statFixtures[0]!, date: "2026-08-01" }];
  await m.evaluate(() =>
    (window as any).__compare(
      "DB.games=[DB.games[0]]; DB.games[0].date='2026-08-01'; show()",
    ),
  );
  await seedGames(a, oldFixtures);
  await a.getByRole("radio", { name: "30日", exact: true }).click();
  await a.getByRole("radio", { name: "後手", exact: true }).click();
  await shot("stats-no-results");
  // 関連する一覧のタグと絞り込み。
  await m.evaluate(() =>
    (window as any).__compare(
      "GSEQ=0; seedData(); DB.games.forEach(g=>g.an='none'); UI.tab='list'; UI.flt={...FL0}; UI.quick='all'; UI.q=''; show()",
    ),
  );
  await seedGames(a, statFixtures);
  await tab("棋譜");
  await shot("stats-list-tags");
  await act("filter");
  await tap("絞り込み");
  await m.locator("#scr .shc").evaluate((el) => (el.scrollTop = 9999));
  await a
    .getByRole("button", { name: "矢倉", exact: true })
    .last()
    .scrollIntoViewIfNeeded();
  await shot("stats-list-filter");
  await closeSheet();
  await tap("閉じる");
  // 手で直すシートは実際の操作で開く。モックで開けるサンプルへ。
  await m.evaluate(() =>
    (window as any).__compare(
      "NAV.length=0; GAME1.plies=5; GAME1.end='投了'; GAME1.an='none'; push({t:'info',id:GAME1.id})",
    ),
  );
  const infoId = (await m.evaluate(() =>
    (window as any).__compare("GAME1.id"),
  )) as string;
  await seedGames(
    a,
    statFixtures.map((g) => (g.id === infoId ? { ...g, plies: 5 } : g)),
  );
  await a.goto(`${APP}/info?id=${infoId}`);
  await bottom();
  await shot("stats-info-tags");
  await act("tagedit", "s:st");
  await tap("先手の戦法を修正");
  await shot("stats-edit-strategy");
  await closeSheet();
  await tap("閉じる");
  await act("tagedit", "s:cs");
  await tap("先手の囲いを修正");
  await shot("stats-edit-castle");
  await closeSheet();
  await tap("閉じる");
  // 初回の7場面。製品に検証入口を設けず、検証用DBを空にして通常の初回起動へ。
  await a.evaluate(async () => {
    const require = (globalThis as any).__r;
    const entry = [...require.getModules().entries()].find(
      ([, m]: any) =>
        m.verboseName === "node_modules/expo-sqlite/build/index.js",
    ) as any;
    const db = await require(entry[0]).openDatabaseAsync("kifumate.db");
    await db.execAsync(
      "DELETE FROM games;DELETE FROM aliases;DELETE FROM settings;DELETE FROM coach_meta;DELETE FROM analysis_meta;",
    );
  });
  await a.goto(APP);
  await a.getByText("kifumateへ ようこそ").waitFor();
  await ctl('.jump [data-jump="onb"]');
  for (let i = 0; i < 7; i++) {
    await shot(`onboarding-${i + 1}`);
    if (i < 6) {
      await act("onbnext");
      await tap(i === 0 ? "はじめる" : "次へ");
    }
  }
  await act("onbalt");
  await tap("あとで");
  await act("sample");
  await tap("見本の対局で試してみる");
  await act("step", "first");
  await tap("最初へ");
  await shot("sample-game"); // モックの合成値ではなく、実探索の同梱値を表示する差を残す。
  await act("back");
  await tap("戻る");
  await shot("sample-list");
  await act("tab", "set");
  await tab("設定");
  await act("nav", "backup");
  await a.getByText("バックアップと復元", { exact: true }).click();
  await shot("backup");
  await tap("書き出す");
  const downloading = a.waitForEvent("download");
  await tap("ファイルに保存");
  const download = await downloading,
    backupPath = path.resolve(`.local/backup-compare-${width}.kifumate`);
  await download.saveAs(backupPath);
  const chooser = a.waitForEvent("filechooser");
  await tap("ファイルを選ぶ");
  await (await chooser).setFiles(backupPath);
  await a.getByText("バックアップの内容", { exact: true }).waitFor();
  await m.evaluate(() =>
    (window as any).__compare(
      "openSheet('バックアップの内容', '<div style=\"text-align:center\">'+pic('sys-backup','empi')+'</div><b>バックアップの内容</b><p class=\"hint\">棋譜 1局・重複 1局。復元する方法を選んでください。</p><button class=\"bt pri wide\">既存データと統合する</button><button class=\"bt wide\" style=\"margin-top:10px\">すべて置きかえる</button>', {auto:true})",
    ),
  );
  await shot("backup-restore-choice");
  await closeSheet();
  await act("bkin");
  await tap("すべて置きかえる");
  await shot("backup-restore-confirm");
  await act("dlgno");
  await tap("やめる");
  await browser.close();
  console.log(`${width}x${height}: ${n}場面 → ${dir}`);
  if (errors.length)
    throw new Error("アプリのページエラー:\n" + errors.join("\n"));
}

const server = await ensureServer();
try {
  for (const size of sizes.length ? sizes : ["360x800", "393x852"]) {
    const [w, h] = size.split("x").map(Number);
    await run(w!, h!);
  }
} finally {
  if (server?.pid) process.kill(-server.pid);
}
