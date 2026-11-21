"""保存済みの compare_tiers 結果を組み合わせ、「S/P の全局結果＋N の深読み局面」を再探索なしで試算する。"""
import glob
import json
import statistics
import sys
from pathlib import Path

import cshogi
import cshogi.KIF

ROOT = Path(__file__).resolve().parents[1]
LOGS = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / '.local' / 'tier-compare' / 'games'


def load(tier):
    return {g['game']: g for g in map(json.loads, open(LOGS / f'{tier}.jsonl')) if 'positions' in g}


def read_games():
    games = {}
    for i, path in enumerate(sorted(glob.glob(str(ROOT / 'scripts' / 'games' / 'game*.kif'))), 1):
        kif = cshogi.KIF.Parser.parse_str(Path(path).read_text(encoding='utf-8'))
        board, moves, signs = cshogi.Board(kif.sfen), [], []
        for move in kif.moves:
            signs.append(1 if board.turn == cshogi.BLACK else -1)
            moves.append(cshogi.move_to_usi(move))
            board.push(move)
        games[i] = moves, signs
    return games


def remark(rows, moves, signs, mate_miss):
    """compare_tiers.mark と同じ規則（勝率は先手視点の保存値から着手側へ変換）。詰み逃しは保存値を引き継ぐ。"""
    by = {r['ply']: dict(r) for r in rows}
    for ply in range(31, len(moves) + 1):
        a, b = by[ply - 1], by[ply]
        if mate_miss(ply):
            b['mark'] = '詰み逃し'
        elif a['rate'] is None or b['rate'] is None:
            b['mark'] = None
        else:
            side = (lambda r: r['rate']) if signs[ply - 1] > 0 else (lambda r: 100 - r['rate'])
            drop = side(a) - side(b)
            b['mark'] = None if a['best'] == moves[ply - 1] else '悪手' if drop >= 20 else '疑問手' if drop >= 10 else None
    return by


def metrics(tables, ref):
    counts = {'悪手': [0, 0, 0], '悪手＋疑問手': [0, 0, 0]}
    hits = total = 0
    diffs = []
    for game, r_game in ref.items():
        by = tables[game]
        for r in r_game['positions']:
            p = by[r['ply']]
            if r['best'] is not None:
                hits += p['best'] == r['best']
                total += 1
            if p['rate'] is not None and r['rate'] is not None:
                diffs.append(abs(p['rate'] - r['rate']))
            for label, labels in (('悪手', {'悪手'}), ('悪手＋疑問手', {'悪手', '疑問手'})):
                c = counts[label]
                c[0] += p['mark'] in labels and r['mark'] in labels
                c[1] += p['mark'] in labels
                c[2] += r['mark'] in labels
    pct = lambda a, b: f'{100 * a / b:.1f}%'
    marks = ' | '.join(f'{k} 適合率{pct(tp, n)} 再現率{pct(tp, m)}' for k, (tp, n, m) in counts.items())
    return f'{marks} | 最善手一致{pct(hits, total)} | 勝率の平均絶対差{statistics.mean(diffs):.2f}'


def main():
    games = read_games()
    S, P, N, R = (load(t) for t in 'SPNR')
    marks = lambda T, g: {r['ply']: r['mark'] for r in T[g]['positions']}
    # 自己検査：保存済みの各設定の印を、この再計算で完全に再現できること。
    for T in (S, P, N):
        for g in T:
            saved = marks(T, g)
            again = remark(T[g]['positions'], *games[g], lambda ply: saved[ply] == '詰み逃し')
            assert all(again[p]['mark'] == m for p, m in saved.items() if p > 30), g

    def overlay(base):
        tables = {}
        for g in R:
            deep, deep_rows = set(N[g]['deep']), {r['ply']: r for r in N[g]['positions']}
            rows = [deep_rows[r['ply']] if r['ply'] in deep else r for r in base[g]['positions']]
            base_marks, n_marks = marks(base, g), marks(N, g)
            miss = lambda ply: (n_marks if ply - 1 in deep else base_marks)[ply] == '詰み逃し'
            tables[g] = remark(rows, *games[g], miss)
        return tables

    plain = lambda T: {g: {r['ply']: r for r in T[g]['positions']} for g in R}
    for name, tables in (('S', plain(S)), ('P', plain(P)), ('N', plain(N)),
                         ('S＋深読み', overlay(S)), ('P＋深読み', overlay(P))):
        print(name, metrics(tables, R))


if __name__ == '__main__':
    main()
