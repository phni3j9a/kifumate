#!/usr/bin/env python3
"""kifumate UIモック用のサンプル棋譜＋解析データ生成スクリプト。

cshogi（盤面・合法手生成・KI2表記・詰み探索）の上で動く自作の簡易探索
（negamax alpha-beta + 静止探索、評価＝駒割り＋玉周りの守り駒／攻め駒）で
自己対局と全局解析を行い、mock/data/sample-game.json を出力する。

これはモックの見た目を確認するためのデータであり、実際の将棋エンジン
（やねうら王＋水匠）の出力ではない。

使い方（sample-game.json は seed 101 の対局を深さ6・1局面30秒上限で解析したもの）:
  python3 gen_sample_game.py bench                              # 探索速度の確認
  python3 gen_sample_game.py selfplay GAMES.json 101 117        # 自己対局（4並列）。点数順に保存
  python3 gen_sample_game.py show GAMES.json                    # 候補対局の一覧
  python3 gen_sample_game.py analyze GAMES.json 0 OUT.json 6 30 # 全局解析して OUT.json と OUT.json.raw.json を出力
  python3 gen_sample_game.py rebuild OUT.json                   # raw から JSON だけ作り直す
  python3 gen_sample_game.py verify OUT.json                    # 自己検証
時間制限つきの探索と並列実行のため、再実行しても完全に同じ結果になるとは限らない。
"""
import json
import math
import os
import random
import sys
import time
from multiprocessing import Pool

import cshogi
import cshogi.KI2 as KI2
from cshogi import (BLACK, WHITE, move_cap, move_from, move_from_piece_type,
                    move_is_drop, move_is_promotion, move_to, move_to_usi,
                    move_drop_hand_piece)

# ---------------------------------------------------------------- 定数

FIXED_OPENING = (
    "7g7f 3c3d 2g2f 4c4d 3i4h 8b4b 5i6h 5a6b 6h7h 6b7b 5g5f 3a3b 4i5h 7b8b "
    "2f2e 2b3c 3g3f 7a7b 7i6h 4a5b 6h5g 3b4c 9g9f 9c9d 5g4f 6c6d 3f3e 3d3e "
    "4f3e 4d4e 8h3c+ 2a3c 2e2d 2c2d 3e2d"
).split()
BOOK_PLIES = 24          # 1〜24手目は定跡扱い（評価値・候補手とも合成）
JOSEKI_END = len(FIXED_OPENING)   # 25〜35手目も固定手順。本譜を最善として扱い、指し手評価は付けない

INF = 10 ** 7
MATE = 30000
MATE_BOUND = MATE - 500
CP_CLAMP = 3000

# 駒種: 1歩 2香 3桂 4銀 5角 6飛 7金 8玉 9と 10杏 11圭 12全 13馬 14龍
VAL = [0, 100, 300, 350, 550, 850, 1000, 600, 0, 600, 600, 600, 600, 1150, 1300]
# 持ち駒: 歩 香 桂 銀 金 角 飛
HAND_VAL = [115, 330, 380, 600, 660, 950, 1100]
GOLD_LIKE = (7, 9, 10, 11, 12)


def cheb(a, b):
    return max(abs(a // 9 - b // 9), abs(a % 9 - b % 9))


DIST = [[cheb(a, b) for b in range(81)] for a in range(81)]


def _att_bonus(pt, d, sq_rank_from_owner_far):
    """敵玉からの距離 d にいる自駒 pt の攻め駒ボーナス。"""
    if pt in GOLD_LIKE:
        t = {1: 110, 2: 70, 3: 30}.get(d, 0)
    elif pt == 4:
        t = {1: 90, 2: 60, 3: 25}.get(d, 0)
    elif pt == 3:
        t = {1: 30, 2: 45, 3: 30}.get(d, 0)
    elif pt == 2:
        t = {1: 20, 2: 20, 3: 10}.get(d, 0)
    elif pt == 1:
        t = {1: 50, 2: 30, 3: 10}.get(d, 0)
    elif pt == 13:
        t = {1: 130, 2: 100, 3: 60, 4: 30}.get(d, 0)
    elif pt == 14:
        t = {1: 150, 2: 120, 3: 80, 4: 40}.get(d, 0)
    elif pt in (5, 6):
        t = {1: 40, 2: 50, 3: 30}.get(d, 0)
    else:
        t = 0
    if pt not in (1, 8) and d >= 4:
        t += max(0, 8 - d) * (8 if (pt in GOLD_LIKE or pt in (4, 13, 14)) else 3)   # 敵玉へ近づく勾配
    return t


def _def_bonus(pt, d):
    """自玉からの距離 d にいる自駒 pt の守り駒ボーナス。"""
    if pt in GOLD_LIKE:
        return {1: 48, 2: 44, 3: 18}.get(d, 0)
    if pt == 4:
        return {1: 40, 2: 36, 3: 14}.get(d, 0)
    if pt == 13:
        return {1: 80, 2: 70, 3: 30}.get(d, 0)
    return 0


def _build_tables():
    # T1[kb][piece*81+sq]: 駒割り＋先手玉 kb に対する先手の守り駒（＋）
    # T2[kw][piece*81+sq]: 後手玉 kw に対する後手の守り駒（−）
    # AB[kw][piece*81+sq]: 後手玉 kw に対する先手駒の攻め駒ユニット（先手駒のみ非0）
    # AW[kb][piece*81+sq]: 先手玉 kb に対する後手駒の攻め駒ユニット（後手駒のみ非0）
    t1, t2, ab, aw = [], [], [], []
    for k in range(81):
        a = [0] * (31 * 81)
        b = [0] * (31 * 81)
        c = [0] * (31 * 81)
        e = [0] * (31 * 81)
        for pt in range(1, 15):
            for sq in range(81):
                d = DIST[k][sq]
                rank = sq % 9
                pb = pt
                adv_b = 0
                if pt == 1:
                    adv_b = (6 - rank) * 3 if rank < 6 else 0
                if pt in (6, 14) and rank <= 1:
                    adv_b += 60
                a[pb * 81 + sq] = VAL[pt] + _def_bonus(pt, d) + adv_b
                c[pb * 81 + sq] = _att_bonus(pt, d, rank)
                pw = pt + 16
                adv_w = 0
                if pt == 1:
                    adv_w = (rank - 2) * 3 if rank > 2 else 0
                if pt in (6, 14) and rank >= 7:
                    adv_w += 60
                a[pw * 81 + sq] = -VAL[pt] - adv_w
                b[pw * 81 + sq] = -_def_bonus(pt, d)
                e[pw * 81 + sq] = _att_bonus(pt, d, rank)
        t1.append(a)
        t2.append(b)
        ab.append(c)
        aw.append(e)
    return t1, t2, ab, aw


T1, T2, AB, AW = _build_tables()


def _king_pos_table():
    kb = [0] * 81
    kw = [0] * 81
    # [自陣側から数えた段][端から数えた筋(0=1・9筋 … 4=5筋)]。二段目の2・8筋（美濃・舟囲いの位置）を基準に
    tbl = [
        [-25, -45, -70, -80, -100],
        [-35, 0, -12, -45, -85],
        [-70, -60, -70, -90, -110],
        [-140, -140, -140, -150, -160],
    ]
    for sq in range(81):
        f, r = sq // 9, sq % 9
        fe = min(f, 8 - f)
        ob = 8 - r          # 先手の自陣側からの段
        ow = r
        kb[sq] = tbl[ob][fe] if ob < 4 else -190
        kw[sq] = tbl[ow][fe] if ow < 4 else -190
    return kb, kw


KPOS_B, KPOS_W = _king_pos_table()


def evaluate(b):
    """手番側から見た静的評価値。"""
    pcs = b.pieces
    kb = b.king_square(BLACK)
    kw = b.king_square(WHITE)
    t1 = T1[kb]
    t2 = T2[kw]
    tab = AB[kw]
    taw = AW[kb]
    s = KPOS_B[kb] - KPOS_W[kw]
    ub = 0      # 先手の攻め駒ユニット（後手玉に対して）
    uw = 0
    i = 0
    for p in pcs:
        if p:
            j = p * 81 + i
            s += t1[j] + t2[j]
            ub += tab[j]
            uw += taw[j]
        i += 1
    hb, hw = b.pieces_in_hand
    hv = HAND_VAL
    s += (hb[0] - hw[0]) * hv[0] + (hb[1] - hw[1]) * hv[1] + (hb[2] - hw[2]) * hv[2] \
        + (hb[3] - hw[3]) * hv[3] + (hb[4] - hw[4]) * hv[4] + (hb[5] - hw[5]) * hv[5] \
        + (hb[6] - hw[6]) * hv[6]
    # 玉の危険度: 攻め駒が集まるほど非線形に効く。持ち駒（歩以外）が多いほど強まる
    if ub > 640:
        ub = 640
    if uw > 640:
        uw = 640
    nb = hb[1] + hb[2] + hb[3] + hb[4] + hb[5] + hb[6]
    nw = hw[1] + hw[2] + hw[3] + hw[4] + hw[5] + hw[6]
    if nb > 4:
        nb = 4
    if nw > 4:
        nw = 4
    s += ub + ub * ub * (8 + nb) // 3600 - uw - uw * uw * (8 + nw) // 3600
    return s + 30 if b.turn == BLACK else -s + 30


# ---------------------------------------------------------------- 探索

EXACT, LOWER, UPPER = 0, 1, 2
QMAX = 5


def silly_nonpromo(m, black):
    """飛・角・歩が成れるのに成らない手（実戦ではまず指さない）。"""
    if move_is_drop(m) or move_is_promotion(m):
        return False
    if move_from_piece_type(m) not in (1, 5, 6):
        return False
    fr = move_from(m) % 9
    to = move_to(m) % 9
    if black:
        return fr <= 2 or to <= 2
    return fr >= 6 or to >= 6


class Searcher:
    def __init__(self):
        self.tt = {}
        self.nodes = 0
        self.history = {}
        self.killers = [[0, 0] for _ in range(96)]
        self.pv = [[] for _ in range(96)]
        self.deadline = float("inf")
        self.stop = False

    # -- 指し手の並べ替え
    def order(self, b, moves, ttm, ply):
        black = b.turn == BLACK
        ek = b.king_square(WHITE if black else BLACK)
        k1, k2 = self.killers[ply]
        hist = self.history
        dist = DIST[ek]
        keyed = []
        for m in moves:
            if silly_nonpromo(m, black):
                continue
            if m == ttm:
                sc = 10 ** 8
            else:
                cap = move_cap(m)
                if cap:
                    sc = 10 ** 6 + VAL[cap] * 16 - VAL[move_from_piece_type(m)]
                    if move_is_promotion(m):
                        sc += 5000
                elif move_is_drop(m):
                    d = dist[move_to(m)]
                    sc = hist.get(m, 0) + (4000 if d <= 2 else 0)
                else:
                    sc = hist.get(m, 0)
                    if move_is_promotion(m):
                        sc += 500000
                    elif m == k1:
                        sc += 90000
                    elif m == k2:
                        sc += 80000
                    d = dist[move_to(m)]
                    if d <= 2:
                        sc += 2000
            keyed.append((sc, m))
        keyed.sort(reverse=True)
        return [m for _, m in keyed]

    def qsearch(self, b, alpha, beta, ply, qd):
        self.nodes += 1
        self.pv[ply] = []
        if b.is_check():
            moves = list(b.legal_moves)
            if not moves:
                return -MATE + ply
            if qd >= QMAX + 2:
                return evaluate(b)
            best = -INF
            moves = self.order(b, moves, 0, ply)
        else:
            stand = evaluate(b)
            if stand >= beta or qd >= QMAX:
                return stand
            if stand > alpha:
                alpha = stand
            best = stand
            caps = []
            black = b.turn == BLACK
            for m in b.legal_moves:
                cap = move_cap(m)
                if silly_nonpromo(m, black):
                    continue
                if cap:
                    gain = VAL[cap]
                    if move_is_promotion(m):
                        gain += 300
                    if stand + gain + 250 > alpha:
                        caps.append((gain * 16 - VAL[move_from_piece_type(m)], m))
                elif move_is_promotion(m) and stand + 600 > alpha:
                    caps.append((300, m))
            if not caps:
                return best
            caps.sort(reverse=True)
            moves = [m for _, m in caps]
        for m in moves:
            b.push(m)
            s = -self.qsearch(b, -beta, -alpha, ply + 1, qd + 1)
            b.pop()
            if s > best:
                best = s
                if s > alpha:
                    alpha = s
                    if alpha >= beta:
                        break
        return best

    def negamax(self, b, depth, alpha, beta, ply, allow_null=True):
        self.nodes += 1
        if (self.nodes & 2047) == 0 and time.time() > self.deadline:
            self.stop = True
        if self.stop:
            return 0
        self.pv[ply] = []
        pv_node = beta - alpha > 1

        rep = b.is_draw(ply)
        if rep == cshogi.REPETITION_DRAW:
            return 0
        if rep == cshogi.REPETITION_WIN:
            return MATE - ply
        if rep == cshogi.REPETITION_LOSE:
            return -MATE + ply

        in_check = b.is_check()
        if depth <= 0:
            if not in_check:
                return self.qsearch(b, alpha, beta, ply, 0)
            depth = 1
        if ply >= 90:
            return evaluate(b)

        if not in_check:
            mm = b.mate_move_in_1ply()
            if mm:
                self.pv[ply] = [mm]
                return MATE - ply - 1

        key = b.zobrist_hash()
        e = self.tt.get(key)
        ttm = 0
        if e is not None:
            ed, ef, es, ttm = e
            if ed >= depth and not pv_node:
                if es > MATE_BOUND:
                    es -= ply
                elif es < -MATE_BOUND:
                    es += ply
                if ef == EXACT or (ef == LOWER and es >= beta) or (ef == UPPER and es <= alpha):
                    return es

        static = None
        if not in_check and not pv_node:
            static = evaluate(b)
            # null move
            if allow_null and depth >= 3 and static >= beta:
                b.push_pass()
                s = -self.negamax(b, depth - 3, -beta, -beta + 1, ply + 1, False)
                b.pop_pass()
                if self.stop:
                    return 0
                if s >= beta and s < MATE_BOUND:
                    return beta

        moves = list(b.legal_moves)
        if not moves:
            return -MATE + ply
        moves = self.order(b, moves, ttm, ply)

        futile = (depth == 1 and static is not None and static + 350 <= alpha)
        best = -INF
        bestm = 0
        orig_alpha = alpha
        searched = 0
        for m in moves:
            cap = move_cap(m)
            promo = move_is_promotion(m)
            b.push(m)
            gives_check = b.is_check()
            quiet = not cap and not promo and not gives_check
            if futile and quiet and searched > 0:
                b.pop()
                continue
            newd = depth - 1
            if searched == 0:
                s = -self.negamax(b, newd, -beta, -alpha, ply + 1)
            else:
                red = 0
                if depth >= 3 and searched >= 4 and quiet and not in_check:
                    red = 1 if searched < 14 else 2
                s = -self.negamax(b, newd - red, -alpha - 1, -alpha, ply + 1)
                if s > alpha and (red or s < beta):
                    s = -self.negamax(b, newd, -beta, -alpha, ply + 1)
            b.pop()
            if self.stop:
                return 0
            searched += 1
            if s > best:
                best = s
                bestm = m
                if s > alpha:
                    alpha = s
                    self.pv[ply] = [m] + self.pv[ply + 1]
                    if alpha >= beta:
                        if not cap:
                            ks = self.killers[ply]
                            if ks[0] != m:
                                ks[1] = ks[0]
                                ks[0] = m
                            self.history[m] = self.history.get(m, 0) + depth * depth
                        break
        flag = EXACT
        if best <= orig_alpha:
            flag = UPPER
        elif best >= beta:
            flag = LOWER
        st = best
        if st > MATE_BOUND:
            st += ply
        elif st < -MATE_BOUND:
            st -= ply
        self.tt[key] = (depth, flag, st, bestm)
        return best

    def search_root(self, b, max_depth, multipv=1, time_limit=None, exclude=()):
        """反復深化のルート探索。[(score, move, pv), ...] を良い順に最大 multipv 個返す。

        score は手番側から見た値。time_limit 超過時は最後に完了した深さの結果を返す。
        """
        self.stop = False
        self.deadline = time.time() + time_limit if time_limit else float("inf")
        moves = [m for m in b.legal_moves if m not in exclude]
        moves = self.order(b, moves, 0, 0)
        if not moves:
            return [], 0
        prev = {m: -i for i, m in enumerate(moves)}
        result = []
        done_depth = 0
        for d in range(1, max_depth + 1):
            moves.sort(key=lambda m: prev[m], reverse=True)
            cur = []       # (score, move, pv) 厳密値のみ
            bounds = {}
            for m in moves:
                if len(cur) >= multipv:
                    cur.sort(key=lambda x: x[0], reverse=True)
                    alpha = cur[multipv - 1][0]
                else:
                    alpha = -INF
                b.push(m)
                if alpha == -INF:
                    s = -self.negamax(b, d - 1, -INF, INF, 1)
                    exact = True
                else:
                    s = -self.negamax(b, d - 1, -alpha - 1, -alpha, 1)
                    exact = False
                    if s > alpha and not self.stop:
                        s = -self.negamax(b, d - 1, -INF, -alpha, 1)
                        exact = True
                line = [m] + list(self.pv[1])
                b.pop()
                if self.stop:
                    break
                bounds[m] = s
                if exact:
                    cur.append((s, m, line))
            if self.stop:
                break
            cur.sort(key=lambda x: x[0], reverse=True)
            result = cur[:multipv]
            prev = {m: bounds.get(m, -INF) for m in moves}
            for rank, (s, m, _) in enumerate(result):
                prev[m] = INF - rank
            done_depth = d
            if result and abs(result[0][0]) > MATE_BOUND and d >= 3:
                # 詰みを読み切ったら十分
                if multipv == 1 or len(result) >= min(multipv, len(moves)):
                    break
        return result, done_depth


# ---------------------------------------------------------------- 詰み（証明つき）

def mate1_move(b):
    """手番側に1手詰があればその手を返す（全合法手を調べる厳密版）。"""
    black = b.turn == BLACK
    alt = 0
    for m in b.legal_moves:
        b.push(m)
        mated = b.is_check() and len(list(b.legal_moves)) == 0
        b.pop()
        if mated:
            if not silly_nonpromo(m, black):
                return m
            alt = m
    return alt


def _reply_rank(b, r, check_to):
    if move_to(r) == check_to and not move_is_drop(r):
        return 0                       # 王手駒を取る
    if not move_is_drop(r) and move_from_piece_type(r) == 8:
        return 1                       # 玉が逃げる
    return 2                           # 合駒など


def mate3_line(b):
    """手番側に3手詰（1手詰を除く）があれば [m1, r, m3] を返す。全応手で詰むことを確認する。"""
    black = b.turn == BLACK
    ms = sorted(b.legal_moves, key=lambda x: silly_nonpromo(x, black))
    for m in ms:
        b.push(m)
        line = None
        if b.is_check():
            replies = list(b.legal_moves)
            if replies:
                ok = True
                pairs = []
                for r in replies:
                    b.push(r)
                    mm = mate1_move(b)
                    b.pop()
                    if not mm:
                        ok = False
                        break
                    pairs.append((r, mm))
                if ok:
                    pairs.sort(key=lambda p: _reply_rank(b, p[0], move_to(m)))
                    line = [m, pairs[0][0], pairs[0][1]]
        b.pop()
        if line:
            return line
    return None


def proven_tsume(b):
    m = mate1_move(b)
    if m:
        return [m]
    return mate3_line(b)


def dfpn_mate(b, nodes=200000, depth=21):
    """df-pn で詰みを探す。見つかれば手順（手のリスト）を返す。"""
    if b.is_check():
        pass
    d = cshogi.DfPn(depth=depth, nodes=nodes)
    try:
        found = d.search(b)
    except Exception:
        return None
    if not found:
        return None
    pv = list(d.get_pv(b))
    # 検証: 手順を進めて最後が詰みになっていること
    n = 0
    ok = True
    for m in pv:
        if not b.is_legal(m):
            ok = False
            break
        b.push(m)
        n += 1
    if ok:
        ok = b.is_check() and len(list(b.legal_moves)) == 0 and n % 2 == 1
    for _ in range(n):
        b.pop()
    return pv if ok else None


# ---------------------------------------------------------------- 表記

def ki2(b, m):
    return KI2.move_to_ki2(m, b).replace("　", "").replace(" ", "")


def move_dict(b, m):
    usi = move_to_usi(m)
    drop = bool(move_is_drop(m))
    return {
        "usi": usi,
        "ja": ki2(b, m),
        "from": None if drop else usi[0:2],
        "to": usi[2:4],
        "drop": drop,
    }


def line_ja(b, line):
    """読み筋を KI2 表記の配列に（盤を進めながら「同」を判定）。"""
    out = []
    n = 0
    for m in line:
        if not b.is_legal(m):
            break
        out.append(ki2(b, m))
        b.push(m)
        n += 1
    for _ in range(n):
        b.pop()
    return out


def board_from_usi(usis):
    b = cshogi.Board()
    for u in usis:
        m = b.move_from_usi(u)
        assert b.is_legal(m), u
        b.push(m)
    return b


# ---------------------------------------------------------------- 自己対局

def pick_plausible_blunder(b, sr, best_s, best_m, want_lo, want_hi, target):
    """浅い読み(深さ2)では自然に見えるが、深く読むと大きく損をする手を選ぶ。

    手番側視点で、深い評価が [want_lo, want_hi] に入る手のうち target に最も近いものを返す。
    """
    res, _ = sr.search_root(b, 2, 8, 3.0)
    best = None
    for s2, m, _line in res:
        if m == best_m:
            continue
        b.push(m)
        if not list(b.legal_moves):
            b.pop()
            continue
        mated = proven_tsume(b) is not None
        r, _ = (None, 0) if mated else sr.search_root(b, 4, 1, 4.0)
        b.pop()
        if mated or not r:
            continue
        deep = -r[0][0]
        if abs(deep) > MATE_BOUND:
            continue
        if want_lo <= deep <= want_hi and best_s - deep >= 500:
            d = abs(deep - target)
            if best is None or d < best[0]:
                best = (d, m, deep)
    return best


def selfplay_game(seed, depth=4, tlimit=8.0, max_plies=128, verbose=False):
    rng = random.Random(seed)
    b = cshogi.Board()
    usis = []
    for u in FIXED_OPENING:
        b.push(b.move_from_usi(u))
        usis.append(u)
    seen = {b.zobrist_hash()}
    evals = {}        # ply(局面番号) -> 先手視点の探索値
    missed_mate = 0
    blunders = []     # 意図的に混ぜた「読み抜け」の手数
    sente_bl = None
    gote_bl = None
    sente_from = 44 + rng.randint(0, 8)
    sr = Searcher()
    result = None
    while True:
        ply = len(usis)
        moves = list(b.legal_moves)
        if not moves:
            result = "mate"
            break
        if ply >= max_plies:
            result = "long"
            break
        sign = 1 if b.turn == BLACK else -1
        chosen = None
        # 1) 詰み
        ts = proven_tsume(b)
        mate_line = ts
        if not mate_line and not b.is_check():
            mate_line = dfpn_mate(b, nodes=60000, depth=15)
        elif not mate_line:
            mate_line = dfpn_mate(b, nodes=60000, depth=15)
        if mate_line:
            n = len(mate_line)
            evals[ply] = sign * (MATE - n)
            play_prob = 1.0 if n == 1 else (0.72 if n == 3 else 0.85)
            if missed_mate >= 1:
                play_prob = 1.0
            if rng.random() < play_prob:
                chosen = mate_line[0]
            else:
                missed_mate += 1
                excl = (mate_line[0],)
                res, _ = sr.search_root(b, depth, 1, tlimit, exclude=excl)
                if res and res[0][0] > -MATE_BOUND:
                    chosen = res[0][1]
                else:
                    chosen = mate_line[0]
                    missed_mate -= 1
        if chosen is None:
            if len(sr.tt) > 400000:
                sr.tt.clear()
            res, dd = sr.search_root(b, depth, 3, tlimit)
            if not res:
                res = [(0, moves[0], [moves[0]])]
            # 千日手回避: 既出局面に戻る手は避ける
            ok = []
            for s, m, line in res:
                b.push(m)
                h = b.zobrist_hash()
                b.pop()
                if h not in seen:
                    ok.append((s, m, line))
            if not ok:
                alt = []
                for m in moves:
                    b.push(m)
                    h = b.zobrist_hash()
                    b.pop()
                    if h not in seen:
                        alt.append(m)
                if alt:
                    r2, _ = sr.search_root(b, max(1, depth - 1), 1, tlimit,
                                           exclude=tuple(m for m in moves if m not in alt))
                    ok = r2 if r2 else [(res[0][0], alt[0], [alt[0]])]
                else:
                    ok = res
            best_s = ok[0][0]
            evals[ply] = sign * best_s
            pick = ok[0]
            r = rng.random()
            eng = None
            if abs(best_s) < 1800:
                if sign == 1 and sente_bl is None and sente_from <= ply <= 66 and best_s >= 200:
                    # 先手（自分）の読み抜け: 有利から不利へ
                    eng = pick_plausible_blunder(b, sr, best_s, ok[0][1], -1100, -250, -550)
                    if eng:
                        sente_bl = ply + 1
                elif (sign == -1 and sente_bl is not None and gote_bl is None
                      and ply + 1 >= sente_bl + 7 and best_s >= 300):
                    # 後手の読み抜け: 再逆転
                    eng = pick_plausible_blunder(b, sr, best_s, ok[0][1], -1300, -300, -650)
                    if eng:
                        gote_bl = ply + 1
            if eng:
                h_ok = True
                b.push(eng[1])
                if b.zobrist_hash() in seen:
                    h_ok = False
                b.pop()
                if h_ok:
                    pick = (eng[2], eng[1], [eng[1]])
                    blunders.append(ply + 1)
            elif len(ok) > 1 and best_s < MATE_BOUND:
                if r < 0.07 and ply >= 40:
                    cands = [c for c in ok[1:] if best_s - c[0] <= 700 and c[0] > -MATE_BOUND]
                    if cands:
                        pick = rng.choice(cands)
                elif r < 0.30:
                    cands = [c for c in ok if best_s - c[0] <= 90]
                    pick = rng.choice(cands)
            chosen = pick[1]
        if verbose:
            print(ply + 1, ki2(b, chosen), evals.get(ply), flush=True)
        usis.append(move_to_usi(chosen))
        b.push(chosen)
        seen.add(b.zobrist_hash())
    winner = None
    if result == "mate":
        winner = "gote" if b.turn == BLACK else "sente"
    return {"seed": seed, "usis": usis, "result": result, "winner": winner,
            "plies": len(usis), "evals": {str(k): v for k, v in evals.items()},
            "missed_mate": missed_mate, "blunders": blunders}


def _sp_worker(seed):
    t = time.time()
    g = selfplay_game(seed)
    g["time"] = round(time.time() - t, 1)
    return g


def swing_score(g):
    """自己対局時の評価値から「先手有利→後手に傾く→先手勝ち」の度合いを点数化。"""
    if g["result"] != "mate" or g["winner"] != "sente":
        return -1
    n = g["plies"]
    if not (66 <= n <= 115):
        return -1
    ev = [(int(k), max(-3000, min(3000, v))) for k, v in g["evals"].items()]
    ev.sort()
    vals = [v for k, v in ev if k >= 36]
    if not vals:
        return -1
    score = 10.0
    if 70 <= n <= 110:
        score += 10
    # 先手が良くなった後に後手へ傾き、その後に先手が勝つ
    best_hi = -9999
    drop = 0
    for v in vals[:-8]:
        best_hi = max(best_hi, v)
        if best_hi >= 300:
            drop = max(drop, best_hi - v)
    lo = min(vals[:-6]) if len(vals) > 6 else 0
    score += min(drop, 2500) / 100.0
    if lo <= -400:
        score += 8
    if lo <= -900:
        score += 4
    if g.get("missed_mate"):
        score += 3
    score += 12 * len(g.get("blunders", []))
    return score


def cmd_selfplay(out, s0, s1):
    seeds = list(range(s0, s1))
    games = []
    t = time.time()
    with Pool(4) as pool:
        for g in pool.imap_unordered(_sp_worker, seeds):
            g["score"] = swing_score(g)
            games.append(g)
            print(f"seed {g['seed']:3d} plies {g['plies']:3d} {g['result']:5s} win={g['winner']} "
                  f"missed={g['missed_mate']} bl={g.get('blunders')} score={g['score']:.1f} time={g['time']}s "
                  f"(elapsed {time.time() - t:.0f}s)", flush=True)
    games.sort(key=lambda g: g["score"], reverse=True)
    if os.path.exists(out):
        old = json.load(open(out))
        have = {g["seed"] for g in games}
        games += [g for g in old if g["seed"] not in have]
        games.sort(key=lambda g: g["score"], reverse=True)
    json.dump(games, open(out, "w"))
    print("saved", out, len(games))


def cmd_show(path, top=6):
    games = json.load(open(path))
    for idx, g in enumerate(games[:top]):
        print(f"=== idx {idx} seed {g['seed']} plies {g['plies']} {g['result']} win={g['winner']} "
              f"missed={g['missed_mate']} score={g['score']:.1f} blunders={g.get('blunders')}")
        b = cshogi.Board()
        parts = []
        for i, u in enumerate(g["usis"]):
            m = b.move_from_usi(u)
            s = ki2(b, m)
            ev = g["evals"].get(str(i))
            if i >= 35:
                parts.append(f"{i + 1}{s}({ev})")
            b.push(m)
        print(" ".join(parts))


# ---------------------------------------------------------------- 全局解析

def _an_worker(args):
    usis, idx, depth, tlimit = args
    b = board_from_usi(usis[:idx])
    sr = Searcher()
    t = time.time()
    res, dd = sr.search_root(b, depth, 3, tlimit)
    out = []
    for s, m, line in res:
        # 読み筋が短いときは浅い探索で継ぎ足す
        line = list(line)
        n = 0
        for mv in line:
            b.push(mv)
            n += 1
        while len(line) < 4 and abs(s) < MATE_BOUND:
            if not list(b.legal_moves):
                break
            r2, _ = sr.search_root(b, 2, 1, 2.0)
            if not r2:
                break
            mv = r2[0][1]
            line.append(mv)
            b.push(mv)
            n += 1
        for _ in range(n):
            b.pop()
        out.append((s, move_to_usi(m), [move_to_usi(x) for x in line[:6]]))
    # 各候補手と本譜の手について「指した直後に相手から詰みがあるか」を df-pn で確認
    played = usis[idx] if idx < len(usis) else None
    checked = []
    have = {u for _, u, _ in out}
    todo = [(s, u, line) for s, u, line in out]
    if played and played not in have:
        todo.append((None, played, [played]))
    for s, u, line in todo:
        m = b.move_from_usi(u)
        b.push(m)
        pv = None
        if list(b.legal_moves):
            pv = dfpn_mate(b, nodes=150000, depth=25)
        b.pop()
        if pv:
            s = -(MATE - (len(pv) + 1))
            line = [u] + [move_to_usi(x) for x in pv[:5]]
        if s is not None:
            checked.append((s, u, line))
    checked.sort(key=lambda c: c[0], reverse=True)
    out = checked
    # 詰み（証明つき）
    ts = proven_tsume(b)
    ts_usi = [move_to_usi(x) for x in ts] if ts else None
    dm = None
    if not ts:
        pv = dfpn_mate(b, nodes=400000, depth=25)
        if pv:
            dm = [move_to_usi(x) for x in pv]
    return idx, out, ts_usi, dm, dd, round(time.time() - t, 1), sr.nodes


def win_rate(cp):
    return 1.0 / (1.0 + math.exp(-cp / 600.0))


def raw_to_cp_mate(raw):
    """手番側視点の探索値 → (cp, mate手数 or None)。いずれも手番側視点。"""
    if raw > MATE_BOUND:
        return CP_CLAMP, MATE - raw
    if raw < -MATE_BOUND:
        return -CP_CLAMP, -(MATE + raw)
    return max(-CP_CLAMP, min(CP_CLAMP, int(round(raw)))), None


def cmd_analyze(games_path, gidx, out_path, depth=5, tlimit=40.0):
    games = json.load(open(games_path))
    g = games[gidx]
    usis = g["usis"]
    N = len(usis)
    print(f"analyze seed {g['seed']} plies {N}", flush=True)
    tasks = [(usis, i, depth, tlimit) for i in range(BOOK_PLIES, N)]
    # 重い中終盤を分散させるため終盤から
    tasks.reverse()
    raw = {}
    t0 = time.time()
    with Pool(4) as pool:
        for idx, out, ts, dm, dd, tt, nodes in pool.imap_unordered(_an_worker, tasks):
            raw[idx] = {"cands": out, "tsume": ts, "dfpn": dm, "depth": dd}
            print(f"  pos {idx:3d} depth {dd} {tt:5.1f}s nodes {nodes:7d} "
                  f"best {out[0][0] if out else None} tsume={bool(ts)} dfpn={len(dm) if dm else 0} "
                  f"(elapsed {time.time() - t0:.0f}s)", flush=True)
    json.dump({"game": g, "raw": {str(k): v for k, v in raw.items()}},
              open(out_path + ".raw.json", "w"))
    build_json(g, raw, out_path)


def cmd_rebuild(out_path):
    d = json.load(open(out_path + ".raw.json"))
    raw = {int(k): v for k, v in d["raw"].items()}
    build_json(d["game"], raw, out_path)


def natural_alt(b, m):
    """序盤の2・3番手候補として自然な駒組みの手か。"""
    if move_is_drop(m) or move_cap(m) or move_is_promotion(m):
        return False
    pt = move_from_piece_type(m)
    fr, to = move_from(m), move_to(m)
    ff, fr_r = fr // 9, fr % 9
    tf, tr = to // 9, to % 9
    black = b.turn == BLACK
    fwd = (fr_r - tr) if black else (tr - fr_r)      # 前進量
    own_rank = (8 - tr) if black else tr             # 自陣側から数えた段(0=一段目)
    if pt == 1:
        return own_rank <= 3 and tf in (0, 8, 2, 3, 4, 5, 6)
    if pt in (4, 7):
        return fwd >= 0 and own_rank <= 2 and abs(tf - ff) <= 1
    if pt == 8:
        return own_rank <= 1 and fwd >= 0
    return False


def build_json(g, raw, out_path):
    usis = g["usis"]
    N = len(usis)
    rng = random.Random(20261108)

    # 局面ごとの盤・手
    b = cshogi.Board()
    sfens = [b.sfen()]
    mvs = []
    move_info = [None]
    for u in usis:
        m = b.move_from_usi(u)
        mvs.append(m)
        move_info.append(move_dict(b, m))
        b.push(m)
        sfens.append(b.sfen())
    assert len(list(b.legal_moves)) == 0 and b.is_check(), "終局図が詰みではない"
    winner = "gote" if b.turn == BLACK else "sente"

    # ---- 後ろから整合を取る（指した手の値＝次局面の値）
    # fin[i] = {"raw": 手番側視点の値, "cands": [(raw, usi, [usi...])]}
    fin = {}
    fin[N] = {"raw": -MATE, "cands": []}
    for i in range(N - 1, BOOK_PLIES - 1, -1):
        r = raw[i]
        cands = [(s, u, list(line)) for s, u, line in r["cands"]]
        # 証明つきの詰みがあれば最善手として採用
        mate_line = r["tsume"] or r["dfpn"]
        if mate_line:
            n = len(mate_line)
            cands = [c for c in cands if c[1] != mate_line[0]]
            cands.insert(0, (MATE - n, mate_line[0], mate_line[:7]))
        played = usis[i]
        nxt = fin[i + 1]
        v = -nxt["raw"]
        if v > MATE_BOUND:
            v -= 1
        elif v < -MATE_BOUND:
            v += 1
        nxt_pv = nxt["cands"][0][2] if nxt["cands"] else []
        pline = ([played] + nxt_pv)[:6]
        found = False
        for k, c in enumerate(cands):
            if c[1] == played:
                cands[k] = (v, played, pline)
                found = True
        if not found:
            if len(cands) < 3 or v > min(c[0] for c in cands):
                cands.append((v, played, pline))
        cands.sort(key=lambda c: c[0], reverse=True)
        cands = cands[:3]
        fin[i] = {"raw": cands[0][0], "cands": cands}

    # ---- 定跡部分（0..BOOK_PLIES-1）
    target = fin[JOSEKI_END]["raw"] * (1 if JOSEKI_END % 2 == 0 else -1)   # 先手視点
    target = max(-70, min(70, target))
    book_cp = []
    cur = 38
    for i in range(JOSEKI_END):
        t = i / max(1, JOSEKI_END - 1)
        goal = 38 * (1 - t) + target * t
        cur = int(round(0.6 * cur + 0.4 * goal + rng.randint(-9, 9)))
        cur = max(-78, min(78, cur))
        book_cp.append(cur)

    positions = []
    b = cshogi.Board()
    for i in range(N + 1):
        black = b.turn == BLACK
        sign = 1 if black else -1
        pos = {"ply": i, "sfen": sfens[i], "move": move_info[i]}
        cands_out = []
        tsume = None
        if i < BOOK_PLIES:
            cp = book_cp[i]
            mate = None
            # 1番手 = 本譜、読み筋 = 本譜の続き
            main_line = mvs[i:i + 5]
            cands_out.append((cp, None, mvs[i], main_line))
            # 2・3番手 = 同じ側がこの先で指す手（手順前後）→ 足りなければ自然な駒組みの手
            alts = []
            for j in range(i + 2, min(N, i + 12), 2):
                m2 = b.move_from_usi(usis[j])
                if b.is_legal(m2) and m2 != mvs[i] and m2 not in alts and natural_alt(b, m2):
                    alts.append(m2)
                if len(alts) >= 2:
                    break
            if len(alts) < 2:
                pool = [m for m in b.legal_moves if m != mvs[i] and m not in alts and natural_alt(b, m)]
                rng.shuffle(pool)
                alts += pool[:2 - len(alts)]
            dec = 0
            for m2 in alts[:2]:
                dec += rng.randint(8, 28)
                # 読み筋: この手のあと本譜の手を順に（合法な限り）
                line = [m2]
                b.push(m2)
                n = 1
                j = i + 1
                skip_used = False
                own_queue = [usis[k] for k in range(i, min(N, BOOK_PLIES + 6), 2)]
                opp_queue = [usis[k] for k in range(i + 1, min(N, BOOK_PLIES + 6), 2)]
                m2_usi = move_to_usi(m2)
                turn_own = False
                oi = 0
                pi = 0
                while len(line) < 4:
                    if turn_own:
                        while oi < len(own_queue) and (own_queue[oi] == m2_usi
                                                       or not b.is_legal(b.move_from_usi(own_queue[oi]))):
                            oi += 1
                        if oi >= len(own_queue):
                            break
                        mv = b.move_from_usi(own_queue[oi])
                        oi += 1
                    else:
                        if pi >= len(opp_queue) or not b.is_legal(b.move_from_usi(opp_queue[pi])):
                            break
                        mv = b.move_from_usi(opp_queue[pi])
                        pi += 1
                    line.append(mv)
                    b.push(mv)
                    n += 1
                    turn_own = not turn_own
                for _ in range(n):
                    b.pop()
                cands_out.append((cp - sign * dec, None, m2, line))
        elif i < JOSEKI_END:
            # 固定手順の後半（仕掛け〜銀交換）: 本譜を最善とし、2・3番手は探索の候補を本譜より下に置く
            cp = book_cp[i]
            mate = None
            cands_out.append((cp, None, mvs[i], mvs[i:i + 5]))
            best_mover = sign * cp
            k = 0
            alts = [c for c in raw[i]["cands"] if c[1] != usis[i] and abs(c[0]) < MATE_BOUND]
            non_king = [c for c in alts if move_from_piece_type(b.move_from_usi(c[1])) != 8
                        or move_is_drop(b.move_from_usi(c[1]))]
            if non_king:
                alts = non_king          # 仕掛けの局面で玉を動かす候補は不自然なので外す
            for rawv, u, line in alts:
                k += 1
                val = min(int(rawv), best_mover - 18 * k - rng.randint(0, 14))
                val = max(val, best_mover - 600)
                cands_out.append((sign * val, None, b.move_from_usi(u),
                                  [b.move_from_usi(line[0])] + line[1:]))
                if k >= 2:
                    break
            cands_out[1:] = sorted(cands_out[1:], key=lambda c: sign * c[0], reverse=True)
        elif i < N:
            f = fin[i]
            for rawv, u, line in f["cands"]:
                c_cp, c_mate = raw_to_cp_mate(rawv)
                cands_out.append((sign * c_cp, None if c_mate is None else sign * c_mate,
                                  b.move_from_usi(u), [b.move_from_usi(line[0])] + line[1:]))
            cp = cands_out[0][0]
            mate = cands_out[0][1]
            ts = raw[i]["tsume"]
            if ts:
                ms = []
                n = 0
                for u in ts:
                    m = b.move_from_usi(u)
                    ms.append(move_dict(b, m) | {})
                    b.push(m)
                    n += 1
                for _ in range(n):
                    b.pop()
                tsume = {"len": len(ts), "line": [{"usi": d["usi"], "ja": d["ja"]} for d in ms]}
        else:
            cp = CP_CLAMP if winner == "sente" else -CP_CLAMP
            mate = None

        pos["cp"] = cp
        pos["mate"] = mate
        pos["tsume"] = tsume
        cl = []
        for c_cp, c_mate, m, line in cands_out:
            d = move_dict(b, m)
            # line は先頭が move(int)、以降は int か usi
            seq = []
            n = 0
            for x in line:
                mv = x if isinstance(x, int) else b.move_from_usi(x)
                if not b.is_legal(mv):
                    break
                seq.append(ki2(b, mv))
                b.push(mv)
                n += 1
            for _ in range(n):
                b.pop()
            d["cp"] = c_cp
            d["mate"] = c_mate
            d["pv"] = seq
            cl.append(d)
        pos["cands"] = cl
        pos["mark"] = None
        pos["loss"] = 0
        if i == N:
            pos["end"] = "詰み"
        positions.append(pos)
        if i < N:
            b.push(mvs[i])

    # ---- 指し手の評価（悪手・疑問手・好手）
    good = []
    chk = cshogi.Board()
    in_check_at = []
    for i in range(N + 1):
        in_check_at.append(chk.is_check())
        if i < N:
            chk.push(mvs[i])
    for i in range(1, N + 1):
        if i <= JOSEKI_END:
            continue
        prev = positions[i - 1]
        cur_p = positions[i]
        mover_sign = 1 if (i - 1) % 2 == 0 else -1     # i-1 局面の手番（偶数=先手）
        before = mover_sign * prev["cp"]
        after = mover_sign * cur_p["cp"]
        loss = max(0, before - after)
        best = prev["cands"][0] if prev["cands"] else None
        is_best = best is not None and best["usi"] == cur_p["move"]["usi"]
        if is_best:
            loss = 0
        cur_p["loss"] = int(loss)
        drop = win_rate(before) - win_rate(after)
        # 詰みを逃した場合も勝率換算で評価される（±3000 クランプ）
        if not is_best and drop >= 0.20:
            cur_p["mark"] = "悪手"
        elif not is_best and drop >= 0.10:
            cur_p["mark"] = "疑問手"
        elif is_best and len(prev["cands"]) >= 2:
            second = mover_sign * prev["cands"][1]["cp"]
            recapture = i >= 2 and positions[i - 1]["move"]["to"] == cur_p["move"]["to"]
            # 好手: 最善手と一致し、2番手より 250cp 以上良い「駒を取らない手」。
            # 取り返し・王手回避・大差で負けている側の手は除く
            if (before - second >= 250 and -1000 <= before < 2000 and prev["mate"] is None
                    and not recapture and not in_check_at[i - 1] and not move_cap(mvs[i - 1])):
                good.append((before - second, i))
    # 好手は多くても3つ。差の大きい順に、先手・後手の双方から選ぶ
    good.sort(reverse=True)
    print("好手候補:", [(i, positions[i]["move"]["ja"], gap) for gap, i in good])
    picked = []
    for side in (1, 0):                       # 奇数手=先手 を先に1つ
        for gap, i in good:
            if i % 2 == side and i not in picked:
                picked.append(i)
                break
    for gap, i in good:
        if len(picked) >= 3:
            break
        if i not in picked:
            picked.append(i)
    for i in picked:
        positions[i]["mark"] = "好手"

    # 証明つきの詰み（1手詰・3手詰）を逃した手に印を付ける
    for i in range(1, N + 1):
        ts = positions[i - 1]["tsume"]
        if ts and positions[i]["move"]["usi"] != ts["line"][0]["usi"]:
            positions[i]["missedTsume"] = ts["len"]

    # 同じ値が続く区間に小さな揺らぎを入れる（実エンジンの出力に近い見た目にするため。
    # 指し手評価は揺らぎを入れる前の値で確定済み）
    for i in range(JOSEKI_END, N):
        pz = positions[i]
        if pz["mate"] is not None or abs(pz["cp"]) > 2800:
            continue
        j = rng.randint(-11, 11)
        pz["cp"] += j
        for c in pz["cands"]:
            if c["mate"] is None and abs(c["cp"]) < CP_CLAMP:
                c["cp"] = max(-CP_CLAMP + 1, min(CP_CLAMP - 1, c["cp"] + j))

    meta = {
        "sente": "tsubame", "gote": "kawasemi", "self": "sente",
        "date": "2026-11-08", "plies": N, "winner": winner, "endReason": "詰み",
        "tags": {
            "sente": {"strategy": ["居飛車", "対四間飛車急戦"], "castle": ["舟囲い"]},
            "gote": {"strategy": ["振り飛車", "四間飛車"], "castle": ["美濃囲い"]},
        },
        "generator": ("UIモック用のサンプルデータ。cshogi上の自作簡易探索（駒割り中心の評価、深さ5前後）"
                      "による自己対局と解析で作成したもので、実際の将棋エンジン（やねうら王＋水匠）の"
                      "出力ではない。1〜35手目は固定手順（1〜24手目の評価値・候補手は合成値、25〜35手目は本譜を最善として"
                      "探索の候補を添えたもの）で、指し手評価は36手目以降に付けている。"),
        "seed": g["seed"],
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "positions": positions}, f, ensure_ascii=False, indent=1)
    print("wrote", out_path)
    print_summary(out_path)


def print_summary(path):
    d = json.load(open(path, encoding="utf-8"))
    for p in d["positions"]:
        if p["ply"] == 0:
            continue
        c1 = p["cands"][0] if p["cands"] else None
        best = f"最善 {c1['ja']}" if c1 else ""
        ts = f" 詰{p['tsume']['len']}" if p["tsume"] else ""
        mt = f" mate={p['mate']}" if p["mate"] is not None else ""
        ms = " 詰み逃し" if p.get("missedTsume") else ""
        print(f"{p['ply']:3d} {p['move']['ja']:<8s} cp={p['cp']:+5d}{mt}{ts}{ms} "
              f"{p['mark'] or '':<4s} loss={p['loss']:<5d} | 次の{best}")
    marks = [(p["ply"], p["move"]["ja"], p["mark"], p["loss"]) for p in d["positions"] if p["mark"]]
    print("marks:", marks)
    print("tsume at:", [(p["ply"], p["tsume"]["len"], [x["ja"] for x in p["tsume"]["line"]])
                        for p in d["positions"] if p["tsume"]])


# ---------------------------------------------------------------- 検証

def cmd_verify(path):
    d = json.load(open(path, encoding="utf-8"))
    P = d["positions"]
    N = d["meta"]["plies"]
    assert len(P) == N + 1, "positions の長さ"
    b = cshogi.Board()
    errs = []
    for i, p in enumerate(P):
        if p["ply"] != i:
            errs.append(f"{i}: ply")
        if b.sfen() != p["sfen"]:
            errs.append(f"{i}: sfen 不一致")
        sign = 1 if b.turn == BLACK else -1
        if i < N and not p["cands"]:
            errs.append(f"{i}: cands 空")
        if p["cands"]:
            if p["cands"][0]["cp"] != p["cp"]:
                errs.append(f"{i}: cp と cands[0].cp が不一致")
            if p["cands"][0]["mate"] != p["mate"]:
                errs.append(f"{i}: mate と cands[0].mate が不一致")
            vals = [sign * c["cp"] for c in p["cands"]]
            if vals != sorted(vals, reverse=True):
                errs.append(f"{i}: cands の順序 {vals}")
        if abs(p["cp"]) > CP_CLAMP:
            errs.append(f"{i}: cp クランプ")
        if i <= JOSEKI_END - 1 and abs(p["cp"]) > 80:
            errs.append(f"{i}: 定跡部分の cp が ±80 を超える")
        if i < JOSEKI_END and i < N:
            if p["cands"][0]["usi"] != P[i + 1]["move"]["usi"]:
                errs.append(f"{i}: 定跡部分の cands[0] が本譜と違う")
        if i <= JOSEKI_END and (p["mark"] or p["loss"]):
            errs.append(f"{i}: 定跡部分に mark/loss")
        for ci, c in enumerate(p["cands"]):
            m = b.move_from_usi(c["usi"])
            if not b.is_legal(m):
                errs.append(f"{i}: cand{ci} 非合法 {c['usi']}")
                continue
            if ki2(b, m) != c["ja"] or c["pv"][0] != c["ja"]:
                errs.append(f"{i}: cand{ci} 表記不一致")
            exp_from = None if c["drop"] else c["usi"][:2]
            if c["from"] != exp_from or c["to"] != c["usi"][2:4] or c["drop"] != ("*" in c["usi"]):
                errs.append(f"{i}: cand{ci} from/to/drop")
            if not (1 <= len(c["pv"]) <= 7):
                errs.append(f"{i}: cand{ci} pv 長さ {len(c['pv'])}")
            if len(c["pv"]) < 3 and c["mate"] is None:
                errs.append(f"{i}: cand{ci} pv が短い {c['pv']}")
        # pv の合法性は KI2 から逆引きして確認
        for ci, c in enumerate(p["cands"]):
            n = 0
            for s in c["pv"]:
                hit = [m for m in b.legal_moves if ki2(b, m) == s]
                if len(hit) != 1:
                    errs.append(f"{i}: cand{ci} pv '{s}' が合法手に一意対応しない({len(hit)})")
                    break
                b.push(hit[0])
                n += 1
            for _ in range(n):
                b.pop()
        if p["tsume"]:
            line = p["tsume"]["line"]
            if p["tsume"]["len"] != len(line) or len(line) not in (1, 3):
                errs.append(f"{i}: tsume 長さ")
            # 厳密検証
            m1 = b.move_from_usi(line[0]["usi"])
            if len(line) == 1:
                b.push(m1)
                if not (b.is_check() and len(list(b.legal_moves)) == 0):
                    errs.append(f"{i}: tsume 1手詰が詰みでない")
                b.pop()
            else:
                b.push(m1)
                if not b.is_check():
                    errs.append(f"{i}: tsume 初手が王手でない")
                replies = list(b.legal_moves)
                if not replies:
                    errs.append(f"{i}: tsume 3手詰のはずが1手詰")
                for r in replies:
                    b.push(r)
                    if not mate1_move(b):
                        errs.append(f"{i}: tsume 応手 {move_to_usi(r)} で詰まない")
                    b.pop()
                r = b.move_from_usi(line[1]["usi"])
                if not b.is_legal(r):
                    errs.append(f"{i}: tsume 2手目 非合法")
                else:
                    b.push(r)
                    m3 = b.move_from_usi(line[2]["usi"])
                    if not b.is_legal(m3):
                        errs.append(f"{i}: tsume 3手目 非合法")
                    else:
                        b.push(m3)
                        if not (b.is_check() and len(list(b.legal_moves)) == 0):
                            errs.append(f"{i}: tsume 3手目で詰んでいない")
                        b.pop()
                    b.pop()
                b.pop()
            if p["mate"] is None or abs(p["mate"]) != len(line):
                errs.append(f"{i}: tsume があるのに mate={p['mate']}")
        if i < N:
            mv = P[i + 1]["move"]
            m = b.move_from_usi(mv["usi"])
            if not b.is_legal(m):
                errs.append(f"{i + 1}: 本譜の手が非合法 {mv['usi']}")
                break
            if ki2(b, m) != mv["ja"]:
                errs.append(f"{i + 1}: 本譜の表記不一致 {mv['ja']} vs {ki2(b, m)}")
            b.push(m)
    if not (b.is_check() and len(list(b.legal_moves)) == 0):
        errs.append("終局図が詰みでない")
    print("verify:", "OK" if not errs else f"{len(errs)} errors")
    for e in errs[:60]:
        print("  ", e)
    return not errs


def cmd_bench():
    b = board_from_usi(FIXED_OPENING)
    print(b.to_bod())
    t = time.time()
    n = 0
    for _ in range(20000):
        evaluate(b)
    print("eval x20000: %.3fs" % (time.time() - t), "value", evaluate(b))
    for depth in (4, 5, 6, 7):
        sr = Searcher()
        t = time.time()
        res, dd = sr.search_root(b, depth, 3, 120)
        dt = time.time() - t
        print(f"depth {depth} multipv3: {dt:.2f}s nodes {sr.nodes} nps {sr.nodes / max(dt, 1e-9):.0f}")
        for s, m, line in res:
            print("   ", s, " ".join(line_ja(b, line)))
    # 打ち歩詰めが合法手に含まれないことの確認
    b2 = cshogi.Board("8k/9/5B2G/9/9/9/9/9/K8 b P 1")
    us = [move_to_usi(m) for m in b2.legal_moves]
    print("P*1b in legal (打ち歩詰め; False が正):", "P*1b" in us)
    b3 = cshogi.Board("7k1/9/7G1/9/9/9/9/9/K8 b G 1")
    print("mate1:", move_to_usi(mate1_move(b3)) if mate1_move(b3) else None,
          "dfpn:", [move_to_usi(x) for x in (dfpn_mate(b3) or [])])


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "bench"
    if cmd == "bench":
        cmd_bench()
    elif cmd == "selfplay":
        s0 = int(sys.argv[3]) if len(sys.argv) > 3 else 1
        s1 = int(sys.argv[4]) if len(sys.argv) > 4 else 13
        cmd_selfplay(sys.argv[2], s0, s1)
    elif cmd == "show":
        cmd_show(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 6)
    elif cmd == "analyze":
        depth = int(sys.argv[5]) if len(sys.argv) > 5 else 5
        tl = float(sys.argv[6]) if len(sys.argv) > 6 else 40.0
        cmd_analyze(sys.argv[2], int(sys.argv[3]), sys.argv[4], depth, tl)
    elif cmd == "rebuild":
        cmd_rebuild(sys.argv[2])
    elif cmd == "verify":
        ok = cmd_verify(sys.argv[2])
        sys.exit(0 if ok else 1)
    elif cmd == "summary":
        print_summary(sys.argv[2])
    elif cmd == "one":
        g = selfplay_game(int(sys.argv[2]), verbose=True)
        print(g["result"], g["winner"], g["plies"])
    else:
        print(__doc__)
