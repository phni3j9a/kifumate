// モックとアプリ（Web 表示）を、同じ画面・同じ状態・同じ大きさで撮り、左右に並べた画像を作る。
//   npm run compare                     … 360×800 と 393×852 の全場面
//   npm run compare -- 393x852 game     … 大きさと、名前に game を含む場面だけ
// 出力は .local/compare/<幅x高さ>/NN-名前.png（左：モック、中：アプリ Web、右：あれば Android 実機）。
// 実機の画面は `adb exec-out screencap -p > .local/compare/android/名前.png` で置くと、3列目に並ぶ。
// モックにしかない入口（解析・有料プラン・AIコーチなど）は、そのまま差として写る。
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
    "npx",
    ["expo", "start", "--web", "--port", new URL(APP).port],
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
  a.on("pageerror", (e) => errors.push(e.message));
  const fake = await fakeAnalysis(a);
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
  await a.getByText("まだ棋譜がありません").waitFor({ timeout: 120000 });
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
    await a.getByRole("tab", { name }).click();
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
    await pause(name.startsWith("analysis-") ? 2800 : 350);
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
  await act("kf");
  await tap("棋譜を開く");
  await shot("sheet-branch-moves");
  await closeSheet();
  await tap("閉じる");
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
  await act("analyze");
  await tap("解析する");
  await a.getByRole("button", { name: "中止", exact: true }).waitFor();
  await m.evaluate(() => {
    (window as any).__compare(
      "clearInterval(RUN.timer); RUN.done=30; renderGame();",
    );
  });
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
  await pause(700);
  await a.goto(gameUrl);
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
  await pause(5500);
  await m.evaluate(() => {
    (window as any).__compare("CUR.an='pre'; CUR.err=false; renderGame();");
  });
  await m.keyboard.press("Home");
  await tap("最初へ");
  await shot("analysis-completed");
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
