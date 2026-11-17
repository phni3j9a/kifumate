#!/usr/bin/env python3
"""サンプルの指し手だけでスモーク／全局計測。トークンはgitignore下に置く。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time
from urllib.request import Request, urlopen


def call(url, method='GET', data=None, token=None):
    headers = {'Content-Type': 'application/json', 'User-Agent': 'kifumate-measurement/1.0'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = Request(url, data=None if data is None else json.dumps(data).encode(), headers=headers, method=method)
    with urlopen(request, timeout=60) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--direct', action='store_true', help='ローカル中継を直接計測')
    parser.add_argument('--plies', type=int, default=85)
    parser.add_argument('--modes', nargs='+', choices=['std', 'precise'], default=['std', 'precise'])
    parser.add_argument('--token-file', type=Path, default=Path('.local/staging-device.json'))
    parser.add_argument('--register', action='store_true', help='トークンを保存し、許可リスト用ハッシュだけ表示して終了')
    args = parser.parse_args()
    sample = json.loads((Path(__file__).resolve().parents[2] / 'mock/data/sample-game.json').read_text())
    if not 0 <= args.plies <= len(sample['positions']) - 1:
        parser.error('plies はサンプルの手数以内で指定してください')
    moves = [p['move']['usi'] for p in sample['positions'][1:]][:args.plies]
    token = None
    if not args.direct:
        if args.token_file.exists():
            token = json.loads(args.token_file.read_text())['token']
        else:
            token = call(args.url + '/v1/devices', 'POST')['token']
            args.token_file.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(args.token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as f:
                json.dump({'token': token}, f)
        if args.register:
            print(hashlib.sha256(token.encode()).hexdigest())
            return
    for mode in args.modes:
        started = time.monotonic()
        payload = {'initial': 'startpos', 'moves': moves, 'mode': mode}
        results = []
        if args.direct:
            for ply in range(len(moves) + 1):
                results.append(call(args.url + '/analyze', 'POST', {**payload, 'ply': ply}))
            duplicate = False
            job_id = None
        else:
            job = call(args.url + '/v1/jobs', 'POST', payload, token)
            job_id, duplicate = job['id'], job['duplicate']
            if duplicate:
                raise RuntimeError('重複ジョブです。計測には新規端末または異なる手数を使ってください')
            cursor = 0
            deadline = time.monotonic() + 1800
            while True:
                progress = call(args.url + f'/v1/jobs/{job_id}?from={cursor}', token=token)
                results.extend(progress['results'])
                cursor = progress['next']
                if progress['status'] == 'completed':
                    break
                if progress['status'] in ('failed', 'cancelled') or time.monotonic() >= deadline:
                    raise RuntimeError(f"解析未完了: {progress['status']}, {progress['error']}")
                time.sleep(2)
        assert [r['ply'] for r in results] == list(range(len(moves) + 1))
        assert all(r['score'] is not None for r in results)
        assert all(len(r['candidates']) <= (1 if mode == 'std' else 3) for r in results)
        assert any(len(r['candidates']) == (1 if mode == 'std' else 3) for r in results)
        encoded = json.dumps(results)
        assert not any(name.lower() in encoded.lower() for name in ('yaneura', 'suisho', '水匠', 'やねうら'))
        print(json.dumps({'mode': mode, 'plies': len(moves), 'positions': len(results),
                          'seconds': round(time.monotonic() - started, 3), 'resultBytes': len(encoded.encode()),
                          'matePositions': [r['ply'] for r in results if r['mate']],
                          'duplicate': duplicate, 'jobId': job_id}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
