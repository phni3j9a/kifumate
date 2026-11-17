# SPDX-License-Identifier: GPL-3.0-only
"""HTTP非公開の運用ツール。同一局面・新規プロセス/空ハッシュで2バイナリを比較する。"""
import argparse
import json
import statistics
import time

import cshogi

from bridge import Engine, MODES, cpu_details, selected_engine, validate_sfen


def search_stats(lines):
    nodes, depth = 0, 0
    for line in lines:
        tokens = line.split()
        if not tokens or tokens[0] != 'info' or 'string' in tokens:
            continue
        try:
            if 'nodes' in tokens:
                nodes = max(nodes, int(tokens[tokens.index('nodes') + 1]))
            rank = int(tokens[tokens.index('multipv') + 1]) if 'multipv' in tokens else 1
            if rank == 1 and 'depth' in tokens:
                depth = max(depth, int(tokens[tokens.index('depth') + 1]))
        except (IndexError, ValueError):
            continue
    return {'nodes': nodes, 'depth': depth}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cpu-only', action='store_true')
    parser.add_argument('--sfen')
    parser.add_argument('--modes', nargs='+', choices=MODES, default=list(MODES))
    parser.add_argument('--repeats', type=int, default=3)
    args = parser.parse_args()
    details = cpu_details()
    print(json.dumps({'cpu': details, 'selected': selected_engine()}), flush=True)
    if args.cpu_only:
        return
    if not args.sfen or not 1 <= args.repeats <= 10:
        parser.error('有効な --sfen と1〜10回の --repeats が必要です')
    validate_sfen(args.sfen)
    board = cshogi.Board(args.sfen)
    if not board.is_ok() or board.is_game_over():
        parser.error('探索可能な局面を指定してください')
    profiles = ['compatible', 'avx2'] if details['avx2Usable'] else ['compatible']
    measurements = {}
    # 順序による偏りを減らすため、反復ごとにバイナリの順序を入れ替える。
    for mode in args.modes:
        ms, threads, multipv = MODES[mode]
        for repeat in range(args.repeats):
            for profile in (profiles if repeat % 2 == 0 else list(reversed(profiles))):
                engine = Engine(['/app/engine-' + profile])
                try:
                    engine.send(f'setoption name Threads value {threads}')
                    engine.send(f'setoption name MultiPV value {multipv}')
                    engine.send('isready')
                    engine.until('readyok', 30)
                    engine.send('usinewgame')
                    engine.send('position sfen ' + args.sfen)
                    started = time.monotonic()
                    engine.send(f'go movetime {ms}')
                    stats = search_stats(engine.until('bestmove', ms / 1000 + 10))
                    stats['seconds'] = round(time.monotonic() - started, 6)
                    assert stats['nodes'] > 0 and stats['depth'] > 0
                    measurements.setdefault((mode, profile), []).append(stats)
                    print(json.dumps({'mode': mode, 'profile': profile, 'repeat': repeat + 1, **stats}), flush=True)
                finally:
                    engine.close()
    for (mode, profile), runs in measurements.items():
        print(json.dumps({'summary': True, 'mode': mode, 'profile': profile,
                          'medianNodes': statistics.median(x['nodes'] for x in runs),
                          'medianDepth': statistics.median(x['depth'] for x in runs),
                          'medianSeconds': statistics.median(x['seconds'] for x in runs)}), flush=True)


if __name__ == '__main__':
    main()
