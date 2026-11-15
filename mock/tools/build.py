#!/usr/bin/env python3
"""モックのビルド: src のHTMLにサンプル棋譜データを埋め込んで dist に書き出す。

  python3 mock/tools/build.py

出力:
  dist/<name>.html             … 公開用（外枠なしの断片。公開時に <html> 等が付く）
  dist/<name>.standalone.html  … そのままブラウザで開ける単体ファイル
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
PLACEHOLDER = "/*__GAME__*/null"
SHELL_HEAD = (
    '<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    "<style>:root{color-scheme:light;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}"
    "body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>\n"
    "</head>\n<body>\n"
)
SHELL_TAIL = "\n</body>\n</html>\n"


def main() -> None:
    # 省略時は data/sample-game.json を読み、dist/ に書き出す（引数: [データJSON] [出力先]）
    data_path = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "sample-game.json"
    dist = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "dist"
    data = json.loads(data_path.read_text(encoding="utf-8"))
    blob = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    dist.mkdir(parents=True, exist_ok=True)
    for src in sorted((ROOT / "src").glob("*.html")):
        html = src.read_text(encoding="utf-8")
        if PLACEHOLDER not in html:
            raise SystemExit(f"{src.name}: データの埋め込み位置（{PLACEHOLDER}）がありません")
        out = html.replace(PLACEHOLDER, blob)
        (dist / src.name).write_text(out, encoding="utf-8")
        (dist / (src.stem + ".standalone.html")).write_text(SHELL_HEAD + out + SHELL_TAIL, encoding="utf-8")
        print(f"built {src.name}: {len(out) / 1024:.0f} KB, {len(data['positions']) - 1} plies")


if __name__ == "__main__":
    main()
