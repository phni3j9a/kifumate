#!/usr/bin/env python3
"""stagingの分岐解析・連続操作・休止と再開を計測。端末登録はmeasure.pyを使う。"""
import argparse
import json
from pathlib import Path
import time

from measure import call


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--token-file', type=Path, default=Path('.local/realtime-device.json'))
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
    def wait(sequence, began):
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            result = request()
            assert result['sessionId'] == session and result['sequence'] == sequence
            if result['status'] == 'ready':
                encoded = json.dumps(result)
                assert not any(name.lower() in encoded.lower() for name in ('yaneura', 'suisho', '水匠', 'やねうら'))
                assert result['result']['score'] is not None
                assert len(result['result']['candidates']) <= 1
                return round(time.monotonic() - began, 3), result
            if result['status'] not in ('preparing', 'analyzing'):
                raise RuntimeError('解析未完了: ' + json.dumps(result))
            time.sleep(0.25)
        raise RuntimeError('結果の待機時間を超えました')
    weekly = call(args.url + '/v1/quota', token=token)
    try:
        before = request()
        assert before['paid'] and before['status'] == 'off', '新規の有料端末を使用してください'
        began = time.monotonic()
        accepted = request(method='POST', data={'initial': 'startpos', 'moves': moves[:1]})
        session = accepted['sessionId']
        seconds, result = wait(0, began)
        print(json.dumps({'場面': '初回', '応答秒': seconds, 'sessionId': session}), flush=True)
        for sequence in range(1, 6):
            began = time.monotonic()
            request(base + '/' + session, 'PUT', {'initial': 'startpos', 'moves': moves[:sequence + 1], 'sequence': sequence})
            seconds, result = wait(sequence, began)
            assert result['result']['ply'] == sequence + 1
            print(json.dumps({'場面': '連続', 'sequence': sequence, '応答秒': seconds}), flush=True)
        # 前の結果を待たずに局面を変更し、最後の局面だけを表示できることを確認。
        for sequence in (6, 7):
            request(base + '/' + session, 'PUT', {'initial': 'startpos', 'moves': moves[:sequence + 1], 'sequence': sequence})
        _, result = wait(7, time.monotonic())
        assert result['result']['ply'] == 8
        print(json.dumps({'場面': '素早い局面切り替え', 'sequence': result['sequence']}), flush=True)
        time.sleep(result['idleMs'] / 1000 + 2)
        paused = request()
        assert paused['status'] == 'paused'
        used = paused['quota']['usedMs']
        time.sleep(1)
        assert request()['quota']['usedMs'] == used
        print(json.dumps({'場面': '休止', '使用ms': used, '状態': paused['status']}), flush=True)
        began = time.monotonic()
        request(base + '/' + session, 'PUT', {'initial': 'startpos', 'moves': moves[:9], 'sequence': 8})
        seconds, _ = wait(8, began)
        print(json.dumps({'場面': '再開', '応答秒': seconds}), flush=True)
        stopped = request(base + '/' + session, 'DELETE')
        assert stopped['status'] == 'off'
        used = stopped['quota']['usedMs']
        time.sleep(1)
        assert request()['quota']['usedMs'] == used
        assert call(args.url + '/v1/quota', token=token)['completed'] == weekly['completed']
        print(json.dumps({'場面': '停止', '使用ms': used, '状態': stopped['status']}), flush=True)
    finally:
        if session:
            request(base + '/' + session, 'DELETE')


if __name__ == '__main__':
    main()
