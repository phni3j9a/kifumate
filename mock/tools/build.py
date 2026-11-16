#!/usr/bin/env python3
"""モックのビルド: src のHTMLに部品とサンプル棋譜データを埋め込んで dist に書き出す。

  python3 mock/tools/build.py

入力:
  src/<name>.html              … ページ本体。次の印を置いたところが差し替わる
      /*#include app/x.css*/   … src からの相対パスのファイルをその場に展開（CSS・JS用）
      /*__GAME__*/null         … data/sample-game.json（1局目）
      /*__GAME2__*/null        … data/sample-game-2.json（2局目。使うページだけ）
      /*__IMAGES__*/{}         … assets/mascot/*.webp を「名前: data URI」の形で（使うページだけ）
出力:
  dist/<name>.html             … 公開用（外枠なしの断片。公開時に <html> 等が付く）
  dist/<name>.standalone.html  … そのままブラウザで開ける単体ファイル
"""
import base64
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
DATA = {"/*__GAME__*/null": "sample-game.json", "/*__GAME2__*/null": "sample-game-2.json"}
INCLUDE = re.compile(r"/\*#include ([\w./-]+)\*/")
SHELL_HEAD = (
    '<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    "<style>:root{color-scheme:light;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}"
    "body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>\n"
    "</head>\n<body>\n"
)
SHELL_TAIL = "\n</body>\n</html>\n"


def blob(name: str) -> str:
    data = json.loads((ROOT / "data" / name).read_text(encoding="utf-8"))
    data["meta"].pop("generator", None)  # 生成方法の覚え書き（エンジン名を含む）はページに埋め込まない
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def images() -> str:
    # ページ1枚で完結させるため、画像は data URI にして埋め込む
    out = {}
    for f in sorted((ROOT / "assets" / "mascot").glob("*.webp")):
        out[f.stem] = "data:image/webp;base64," + base64.b64encode(f.read_bytes()).decode("ascii")
    return json.dumps(out, separators=(",", ":"))


def expand(text: str) -> str:
    # 部品の中の include も展開する
    return INCLUDE.sub(lambda m: expand((SRC / m.group(1)).read_text(encoding="utf-8")), text)


def main() -> None:
    dist = ROOT / "dist"
    dist.mkdir(parents=True, exist_ok=True)
    for src in sorted(SRC.glob("*.html")):
        out = expand(src.read_text(encoding="utf-8"))
        if "/*__GAME__*/null" not in out:
            raise SystemExit(f"{src.name}: データの埋め込み位置（/*__GAME__*/null）がありません")
        for mark, name in DATA.items():
            if mark in out:
                out = out.replace(mark, blob(name))
        if "/*__IMAGES__*/{}" in out:
            out = out.replace("/*__IMAGES__*/{}", images())
        (dist / src.name).write_text(out, encoding="utf-8")
        (dist / (src.stem + ".standalone.html")).write_text(SHELL_HEAD + out + SHELL_TAIL, encoding="utf-8")
        print(f"built {src.name}: {len(out) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
