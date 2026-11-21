# SPDX-License-Identifier: GPL-3.0-only
"""Issue #56 のローカル計測ツール。HTTP には公開しない。

本番イメージへこのファイルを /app/compare_tiers.py に、既定の棋譜ディレクトリ
server/scripts/games/ を /scripts/games に、それぞれ読み取り専用でマウント。
python -B /app/compare_tiers.py S のように S/P/N/R を直列で実行し、
Docker の --cpus を順に 1/2/2/4 に合わせる。標準出力を S.jsonl 等へ保存し、
summary <S.jsonl> <P.jsonl> <N.jsonl> <R.jsonl> で集計する。棋譜の順序は全設定で統一。
入力は KIF（UTF-8 / Shift_JIS、平手・駒落ち）または mock/data のサンプル JSON。
評価差・最善手は30手目以降、印は31手目以降。Nの探索量には両段階を含む。
ログは server/.local/tier-compare/ など公開しない場所へ保存する。
"""
import argparse
import json
import math
from pathlib import Path
import re
import statistics
import sys
import time

import cshogi
from cshogi.KIF import Parser

from benchmark import search_stats
from bridge import Engine, MODES, cpu_details, prepare, selected_engine

GAMES = Path(__file__).resolve().parents[1] / 'scripts' / 'games'
OPENING = 30
SHALLOW, DEEP = (500, 2, 3), (5000, 2, 3)
SETTINGS = {'S': MODES['std'], 'P': MODES['precise'], 'N': SHALLOW, 'R': (5000, 4, 1)}
STANDARD_3_USD_PER_SECOND = 2 * 0.000020 + 8 * 0.0000025 + 16 * 0.00000007


class TimedEngine(Engine):
    def until(self, prefix, seconds, cancel=None):
        started = time.monotonic()
        lines = super().until(prefix, seconds, cancel)
        if prefix == 'bestmove':
            self.stats = {'seconds': time.monotonic() - started, **search_stats(lines)}
        return lines


def read_game(path):
    if path.suffix.lower() == '.json':
        positions = json.loads(path.read_text(encoding='utf-8'))['positions']
        return positions[0]['sfen'], [p['move']['usi'] for p in positions[1:]]
    data = path.read_bytes()
    try:
        text = data.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = data.decode('cp932')
    if '\x00' in text:
        raise ValueError('KIFにNULを含む')
    lines = text.splitlines()
    # shortcut: 盤面図のカスタム開始局面は未対応。必要になったらアプリのKIFパーサーで変換する。
    if any(line.lstrip().startswith('|') for line in lines):
        raise ValueError('盤面図付きKIFは未対応')
    handicap = next((m[1].strip() for line in lines
                     if (m := re.fullmatch(r'手合割[：:](.+)', line))), '平手')
    if not Parser.HANDYCAP_SFENS.get(handicap):
        raise ValueError('未対応の手合割')
    rows = []
    for line in lines:
        if re.match(r'\s*(?:変化[：:]|まで\s*\d+\s*手)', line):
            break
        row = re.fullmatch(r'\s*([0-9]+)\s+(.*)', line)
        if not row:
            continue
        if int(row[1]) != len(rows) + 1:
            raise ValueError('手数が不連続')
        notation = row[2].strip().lstrip('▲△▼▽').strip()
        notation = re.sub(r'^同\s*', '同　', notation).replace('不成', '')
        notation = re.sub(r'^[1-9](?=[一二三四五六七八九])',
                          lambda m: '０１２３４５６７８９'[int(m[0])], notation)
        if re.match(r'(?:入玉勝ち|中断|投了|持将棋|千日手|詰み|切れ負け|反則勝ち|反則負け)(?:\s|$)', notation):
            break
        rows.append(f'{row[1]} {notation}')
    game = Parser.parse_str('\n'.join([f'手合割：{handicap}', *rows]))
    if len(game.moves) != len(rows):
        raise ValueError('未対応の着手')
    return game.sfen, [cshogi.move_to_usi(move) for move in game.moves]


def win_rate(score, sign=1):
    if score is None:
        return None
    value = score['value'] if score['kind'] == 'cp' else (-3000 if score['winner'] == 'gote' else 3000)
    return 100 / (1 + math.exp(-sign * value / 600))


def loss(before, after, sign):
    a, b = win_rate(before['score'], sign), win_rate(after['score'], sign)
    return None if a is None or b is None else a - b


def best(result):
    candidates = result['candidates']
    if not candidates:
        return None
    return 'win' if candidates[0].get('declarationWin') else candidates[0].get('move')


def mark(ply, move, sign, before, after):
    # pointsFor の悪手・疑問手と、それらを上書きする詰み逃しだけを再現する。
    if ply <= OPENING:
        return None
    drop = loss(before, after, sign)
    if drop is None:
        return None
    if before['mate'] and before['mate']['pv'][0] != move:
        return '詰み逃し'
    if best(before) == move:
        return None
    return '悪手' if drop >= 20 else '疑問手' if drop >= 10 else None


def deep_positions(results, signs):
    budget = len(results) * (SETTINGS['P'][0] - SHALLOW[0]) // DEEP[0]
    drops = [(i, loss(results[i - 1], results[i], sign)) for i, sign in enumerate(signs, 1)]
    chosen = set()
    # 詰みも±3000で順位付け。同点は若い手数を先にし、前後の重複局面は一度だけ読む。
    for i, _ in sorted(((i, d) for i, d in drops if d is not None), key=lambda x: -x[1]):
        pair = {i - 1, i}
        if len(chosen | pair) <= budget:
            chosen |= pair
        if len(chosen) == budget:
            break
    return sorted(chosen)


def measure(tier, initial, moves, signs):
    mode = {'S': 'std', 'P': 'precise'}.get(tier, tier)
    MODES[mode] = SETTINGS[tier]
    stats, results = [], {}
    engine = TimedEngine()
    try:
        def search(plies, stage):
            for ply in plies:
                data = {'initial': initial, 'moves': moves, 'mode': mode, 'ply': ply}
                results[ply] = engine.analyze(data)
                stats.append({'ply': ply, 'stage': stage, **engine.stats})

        search(range(OPENING if tier == 'R' else 0, len(moves) + 1), 1)
        deep = deep_positions(results, signs) if tier == 'N' else []
        if deep:
            # 同じ N モードのまま時間だけ変え、局面間・段階間でハッシュを再利用する。
            MODES[mode] = DEEP
            search(deep, 2)
    finally:
        engine.close()
    rows = []
    for ply, result in sorted(results.items()):
        label = mark(ply, moves[ply - 1], signs[ply - 1], results[ply - 1], result) if ply > OPENING else None
        rows.append({'ply': ply, 'best': best(result), 'rate': win_rate(result['score']), 'mark': label})
    return {'tier': tier, 'moves': len(moves), 'positions': rows, 'searches': stats, 'deep': deep}


def fraction(numerator, denominator):
    return {'count': numerator, 'total': denominator, 'fraction': numerator / denominator if denominator else None}


def metrics(games, refs):
    if not games or len(games) != len(refs):
        raise ValueError('設定間で棋譜数が一致しない')
    bad, adverse = {'悪手'}, {'悪手', '疑問手'}
    counts = {label: [0, 0, 0] for label in ('悪手', '悪手＋疑問手')}
    best_hits = best_total = selected = 0
    diffs = []
    costs, times, searches = [], [], []
    for game, ref in zip(games, refs, strict=True):
        if (game['game'], game['moves']) != (ref['game'], ref['moves']):
            raise ValueError('設定間で棋譜番号または手数が一致しない')
        by_ply = {p['ply']: p for p in game['positions']}
        deep = set(game['deep'])
        for r in ref['positions']:
            ply = r['ply']
            p = by_ply[ply]
            if r['best'] is not None:
                best_hits += p['best'] == r['best']
                best_total += 1
            if p['rate'] is not None and r['rate'] is not None:
                diffs.append(abs(p['rate'] - r['rate']))
            for label, labels in (('悪手', bad), ('悪手＋疑問手', adverse)):
                match, predicted, correct = counts[label]
                counts[label] = [match + (p['mark'] in labels and r['mark'] in labels),
                                 predicted + (p['mark'] in labels), correct + (r['mark'] in labels)]
            selected += r['mark'] == '悪手' and {ply - 1, ply} <= deep
        elapsed = sum(s['seconds'] for s in game['searches'])
        times.append(elapsed)
        costs.append((elapsed + 11 + 30) * STANDARD_3_USD_PER_SECOND)
        searches.extend(game['searches'])
    return {
        'marks': {label: {'precision': fraction(tp, predicted), 'recall': fraction(tp, correct)}
                  for label, (tp, predicted, correct) in counts.items()},
        'bestMove': fraction(best_hits, best_total),
        'winRateMAE': statistics.mean(diffs) if diffs else None,
        'winRateDiffGE10': fraction(sum(d >= 10 for d in diffs), len(diffs)),
        'medianNodes': statistics.median(s['nodes'] for s in searches) if searches else None,
        'medianDepth': statistics.median(s['depth'] for s in searches) if searches else None,
        'searchCount': [len(g['searches']) for g in games],
        'searchSeconds': times,
        'meanSearchSeconds': statistics.mean(times),
        **({'deepSearchCount': [len(g['deep']) for g in games],
            'badMoveCoverage': fraction(selected, counts['悪手'][2]),
            'containersUSD': costs, 'meanContainersUSD': statistics.mean(costs)} if games[0]['tier'] == 'N' else {}),
    }


def self_test():
    def result(cp, mate=None, best_move='best'):
        return {'score': cp if isinstance(cp, dict) else {'kind': 'cp', 'value': cp},
                'candidates': [{'move': best_move}], 'mate': mate}

    zero, low, very_low = result(0), result(-300), result(-600)
    mate = result({'kind': 'mate', 'value': None, 'winner': 'gote'})
    assert win_rate(mate['score']) == win_rate(result(-3000)['score'])
    assert mark(30, 'other', 1, zero, very_low) is None
    assert mark(31, 'best', 1, zero, very_low) is None
    assert mark(31, 'other', 1, zero, result(-240)) is None
    assert mark(31, 'other', 1, zero, low) == '疑問手'
    assert mark(31, 'other', 1, zero, very_low) == '悪手'
    assert mark(31, 'other', -1, zero, very_low) is None
    assert mark(31, 'other', -1, very_low, zero) == '悪手'
    assert mark(31, 'other', 1, zero, mate) == '悪手'
    assert mark(31, 'other', 1, result(0, {'pv': ['best']}), mate) == '詰み逃し'
    positions = [zero, very_low, zero, mate, low] + [zero] * 35
    signs = [1, -1, 1, -1] + [1] * 35
    assert deep_positions(positions[:9], signs[:8]) == []
    assert deep_positions(positions[:20], signs[:19]) == [2, 3]
    assert deep_positions(positions[:30], signs[:29]) == [2, 3, 4]
    assert deep_positions(positions, signs) == [1, 2, 3, 4]
    print('自己検査成功')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('tier', choices=[*SETTINGS, 'summary'], nargs='?')
    parser.add_argument('files', nargs='*', type=Path)
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        self_test()
    elif args.tier == 'summary' and len(args.files) == 4:
        by_tier = {}
        for tier, file in zip(SETTINGS, args.files, strict=True):
            games = [json.loads(line) for line in file.read_text().splitlines()]
            if not games or any(game['tier'] != tier for game in games):
                parser.error(f'{tier}のログが必要です')
            by_tier[tier] = games
        print(json.dumps({tier: metrics(games, by_tier['R']) for tier, games in by_tier.items()},
                         ensure_ascii=False, indent=2))
    elif args.tier in SETTINGS:
        files = args.files or sorted(GAMES.glob('game*.kif'))
        if not files:
            parser.error('既定の棋譜ディレクトリをマウントするか、棋譜を指定してください')
        print(f'{args.tier}: CPU={cpu_details()["models"]} engine={selected_engine()} 設定={SETTINGS[args.tier]}',
              file=sys.stderr, flush=True)
        for number, path in enumerate(files, 1):
            try:
                initial, moves = read_game(path)
                if not moves:
                    raise ValueError('着手なし')
                board, *_ = prepare({'initial': initial, 'moves': moves, 'mode': 'std', 'ply': 0})
            except Exception:
                # 名前・パス・KIFの原文をエラーログへ漏らさない。
                parser.error(f'棋譜{number}を読み込めません（文字コード、開始局面、着手を確認）')
            first = 1 if board.turn == cshogi.BLACK else -1
            signs = [first * (-1) ** i for i in range(len(moves))]
            print(f'棋譜{number}（{len(moves)}手）: 探索開始', file=sys.stderr, flush=True)
            game = measure(args.tier, initial, moves, signs)
            print(json.dumps({'game': number, **game}, ensure_ascii=False), flush=True)
    else:
        parser.error('設定（S/P/N/R）、summaryと4設定のログ、または --self-test を指定してください')


if __name__ == '__main__':
    main()
