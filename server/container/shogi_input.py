# SPDX-License-Identifier: GPL-3.0-only
"""cshogi に渡す前の共通の形式・駒数検査。"""
import re

MOVE = re.compile(r"(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])\Z")


class InvalidInput(ValueError):
    pass


def validate_sfen(sfen):
    """C++ パーサへ渡す前に構造と駒数を検査し、不正入力によるクラッシュを防ぐ。"""
    parts = sfen.split(" ")
    if len(parts) != 4 or parts[1] not in ("b", "w") or not re.fullmatch(r"[1-9][0-9]{0,5}", parts[3]):
        raise InvalidInput()
    ranks = parts[0].split("/")
    if len(ranks) != 9:
        raise InvalidInput()
    counts = {p: 0 for p in "PLNSGBRK"}
    kings = {"K": 0, "k": 0}
    for rank in ranks:
        squares = 0
        tokens = re.findall(r"\+[PLNSBRplnsbr]|[PLNSGBRKplnsgbrk1-9]", rank)
        if "".join(tokens) != rank:
            raise InvalidInput()
        for token in tokens:
            if token.isdigit():
                squares += int(token)
            else:
                p = token[-1]
                counts[p.upper()] += 1
                if p in kings:
                    kings[p] += 1
                squares += 1
        if squares != 9:
            raise InvalidInput()
    if kings != {"K": 1, "k": 1}:
        raise InvalidInput()
    if not parts[2]:
        raise InvalidInput()
    if parts[2] != "-":
        tokens = re.findall(r"([1-9][0-9]?)?([PLNSGBRplnsgbr])", parts[2])
        if "".join(n + p for n, p in tokens) != parts[2] or len({p for _, p in tokens}) != len(tokens):
            raise InvalidInput()
        for n, p in tokens:
            counts[p.upper()] += int(n or 1)
    if any(counts[p] > limit for p, limit in zip("PLNSGBRK", [18, 4, 4, 4, 4, 2, 2, 2])):
        raise InvalidInput()
