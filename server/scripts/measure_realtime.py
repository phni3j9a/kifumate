#!/usr/bin/env python3
"""stagingのリアルタイム解析・継続探索・休止と再開を計測。端末登録はmeasure.pyを使う。"""
import argparse
import json
from pathlib import Path
import time

from measure import call


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--token-file', type=Path, default=Path('.local/realtime-device.json'))
    parser.add_argument('--hold-seconds', type=int, default=35, help='holdで探索継続を確認する秒数（通常の休止時間より長く、holdの休止時間未満）')
    args = parser.parse_args()
    if args.url.rstrip('/') != 'https://kifumate-analysis-staging.yuki-nakano-1020.workers.dev':
        parser.error('この計測はkifumateのstagingだけで実行してください')
    token = json.loads(args.token_file.read_text())['token']
    sample = json.loads((Path(__file__).resolve().parents[2] / 'mock/data/sample-game.json').read_text())
    moves = [p['move']['usi'] for p in sample['positions'][1:]]
    base = args.url.rstrip('/') + '/v1/realtime'
    session = None
    def request(url=base, method='GET', data=None):
        return call(url, method, data, token)
    def results(sequence, began, idle_ms):
        deadline = began + idle_ms / 1000
        while time.monotonic() < deadline:
            reply = request()
            assert reply['sessionId'] == session and reply['sequence'] == sequence
            assert reply['searching'] is True, f"探索が継続していません: {reply['status']} / {reply['error']}"
            if reply['status'] == 'ready':
                result = reply['result']
                encoded = json.dumps(result, ensure_ascii=False)
                assert not any(name.lower() in encoded.lower() for name in ('yaneura', 'suisho', '水匠', 'やねうら'))
                assert result['score'] is not None and len(result['candidates']) == 1
                assert result['depth'] == result['candidates'][0]['depth'] > 0
                yield round(time.monotonic() - began, 3), reply
            elif reply['status'] not in ('preparing', 'analyzing'):
                raise RuntimeError(f"解析未完了: {reply['status']} / {reply['error']}")
            time.sleep(0.25)
        raise RuntimeError('休止期限までに期待する結果を取得できませんでした')
    weekly = call(args.url + '/v1/quota', token=token)
    try:
        before = request()
        assert before['paid'] and before['status'] == 'off', '新規の有料端末を使用してください'
        began = time.monotonic()
        accepted = request(method='POST', data={'initial': 'startpos', 'moves': moves[:1]})
        session = accepted['sessionId']
        idle_ms = accepted['idleMs']
        assert args.hold_seconds * 1000 > idle_ms, '--hold-secondsは通常の休止時間より長く指定してください'
        initial = results(0, began, idle_ms)
        seconds, reply = next(initial)
        first = reply['result']
        assert first['ply'] == 1
        print(json.dumps({'場面': '初回', '応答秒': seconds, '深さ': first['depth']}, ensure_ascii=False), flush=True)
        previous, improvements, max_depth = first, 0, first['depth']
        for seconds, reply in initial:
            result = reply['result']
            if result == previous:
                continue
            assert result['ply'] == first['ply']
            previous = result
            improvements += 1
            max_depth = max(max_depth, result['depth'])
            print(json.dumps({'場面': '同じ局面の更新', '経過秒': seconds, '深さ': result['depth']}, ensure_ascii=False), flush=True)
            if improvements >= 2 and max_depth > first['depth']:
                break
        for sequence in range(1, 6):
            began = time.monotonic()
            request(base + '/' + session, 'PUT', {'initial': 'startpos', 'moves': moves[:sequence + 1], 'sequence': sequence})
            seconds, result = next(results(sequence, began, idle_ms))
            assert result['result']['ply'] == sequence + 1
            print(json.dumps({'場面': '連続', 'sequence': sequence, '応答秒': seconds}), flush=True)
        # 前の結果を待たずに局面を変更し、最後の局面だけを表示できることを確認。
        for sequence in (6, 7):
            request(base + '/' + session, 'PUT', {'initial': 'startpos', 'moves': moves[:sequence + 1], 'sequence': sequence})
        _, result = next(results(7, time.monotonic(), idle_ms))
        assert result['result']['ply'] == 8
        print(json.dumps({'場面': '素早い局面切り替え', 'sequence': result['sequence']}), flush=True)
        time.sleep(result['idleMs'] / 1000 + 2)
        paused = request()
        assert paused['status'] == 'paused' and paused['searching'] is False
        paused_used = paused['quota']['usedMs']
        assert paused_used - before['quota']['usedMs'] >= idle_ms
        time.sleep(1)
        assert request()['quota']['usedMs'] == paused_used
        print(json.dumps({'場面': '休止', '設定ms': idle_ms, '今回の使用ms': paused_used - before['quota']['usedMs']}, ensure_ascii=False), flush=True)
        began = time.monotonic()
        held = request(base + '/' + session, 'PUT', {'initial': 'startpos', 'moves': moves[:9], 'sequence': 8, 'hold': True})
        hold_idle_ms = held['idleMs']
        assert args.hold_seconds * 1000 < hold_idle_ms, '--hold-secondsはholdの休止時間未満で指定してください'
        seconds, ready = next(results(8, began, hold_idle_ms))
        assert ready['result']['ply'] == 9
        print(json.dumps({'場面': 'holdで再開', '応答秒': seconds, '深さ': ready['result']['depth'], '設定ms': hold_idle_ms}, ensure_ascii=False), flush=True)
        time.sleep(max(0, began + args.hold_seconds - time.monotonic()))
        seconds, continuing = next(results(8, began, hold_idle_ms))
        assert continuing['result']['ply'] == 9 and continuing['result'] != ready['result']
        print(json.dumps({'場面': 'holdで継続', '経過秒': seconds, '深さ': continuing['result']['depth']}, ensure_ascii=False), flush=True)
        stopped = request(base + '/' + session, 'DELETE')
        assert stopped['status'] == 'off' and stopped['searching'] is False
        session = None
        used = stopped['quota']['usedMs']
        assert used - paused_used >= args.hold_seconds * 1000 - 1000
        time.sleep(1)
        assert request()['quota']['usedMs'] == used
        assert call(args.url + '/v1/quota', token=token)['completed'] == weekly['completed']
        print(json.dumps({'場面': '停止', 'hold使用ms': used - paused_used, '今回の合計使用ms': used - before['quota']['usedMs']}, ensure_ascii=False), flush=True)
    finally:
        if session:
            request(base + '/' + session, 'DELETE')


if __name__ == '__main__':
    main()
