import { readdirSync, readFileSync, statSync } from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
const forbidden =
  /やねうら|水匠|yaneura|suisho|nnue|将棋ウォーズ|将棋クエスト|81道場|ぴよ将棋|将棋倶楽部24|lishogi|shogi\s*wars|shogi\s*quest|81dojo/i;
const paths = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry);
    if (statSync(file).isDirectory()) walk(file);
    else paths.push(file);
  }
}
walk("src");
paths.push("app.json");
if (process.argv[2]) walk(process.argv[2]);
for (const file of paths) {
  // バイナリアセットも文字列化してメタデータ・ファイル名を検査する。
  assert(
    !forbidden.test(file + "\n" + readFileSync(file).toString("utf8")),
    `禁止名称を検出: ${file}`,
  );
}
console.log(`製品ソース・アセット ${paths.length}件：禁止名称なし`);
