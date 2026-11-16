#!/usr/bin/env python3
"""マスコット素材集（リポジトリ直下の assets/mascot-kit）から、モックで使う分だけを小さくして
mock/assets/mascot に書き出す。

  python3 mock/tools/make_mascot.py [素材集のフォルダ]

素材集は 1024px のPNG（約29MB）。ここで作るのは、モックの画面に実際に置く大きさに合わせた
WebP（透過あり）で、build.py がページに埋め込む。
余白を切り詰めてから縮小するので、画面側は「高さを決めて置く」だけでよい。
"""
import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "mascot"
# 出力名: (素材集の中のパス, 長辺のピクセル数)。長辺は「画面に置く大きさ × 2〜3倍」を目安にしている
USE = {
    # オンボーディング（全身）
    "onb-1": ("01-onboarding/01-welcome.png", 600),
    "onb-2": ("01-onboarding/02-import.png", 600),
    "onb-3": ("01-onboarding/03-read-evaluation.png", 600),
    "onb-4": ("01-onboarding/04-try-variation.png", 600),
    "onb-5": ("01-onboarding/05-ask-coach.png", 600),
    "onb-6": ("01-onboarding/06-set-goal.png", 600),
    "onb-7": ("01-onboarding/07-ready.png", 600),
    # AIコーチの丸枠アイコン（表情）
    "chat-default": ("02-chat/512/01-default.png", 132),
    "chat-listening": ("02-chat/512/02-listening.png", 132),
    "chat-thinking": ("02-chat/512/03-thinking.png", 132),
    "chat-explaining": ("02-chat/512/04-explaining.png", 132),
    "chat-idea": ("02-chat/512/05-idea.png", 132),
    "chat-cheer": ("02-chat/512/06-cheer.png", 132),
    "chat-support": ("02-chat/512/07-support.png", 132),
    # 空の画面・状態表示
    "sys-empty": ("04-system/01-empty-library.png", 440),
    "sys-noresults": ("04-system/02-no-results.png", 360),
    "sys-invalid": ("04-system/03-invalid-record.png", 300),
    "sys-duplicate": ("04-system/04-duplicate.png", 300),
    "sys-backup": ("04-system/08-backup.png", 320),
    # 学習の節目
    "learn-first": ("05-learning/01-first-review.png", 400),
    # アプリアイコン
    "app-icon": ("00-app/app-icon.png", 192),
}


def main() -> None:
    kit = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "assets" / "mascot-kit"
    OUT.mkdir(parents=True, exist_ok=True)
    total = 0
    for name, (rel, size) in USE.items():
        im = Image.open(kit / rel)
        if "A" in im.getbands():
            im = im.convert("RGBA")
            box = im.getchannel("A").getbbox()
            if box:
                im = im.crop(box)
        else:
            im = im.convert("RGB")
        im.thumbnail((size, size), Image.LANCZOS)
        out = OUT / f"{name}.webp"
        im.save(out, "WEBP", quality=86, method=6)
        total += out.stat().st_size
        print(f"{name:16s} {im.size[0]:4d}x{im.size[1]:<4d} {out.stat().st_size / 1024:6.1f} KB")
    print(f"total {total / 1024:.0f} KB in {len(USE)} files")


if __name__ == "__main__":
    main()
