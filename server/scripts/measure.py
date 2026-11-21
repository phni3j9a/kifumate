#!/usr/bin/env python3
"""サンプルの指し手だけでスモーク／全局計測。トークンはgitignore下に置く。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time
import uuid
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
    parser.add_argument('--expect-deep', action='store_true', help='精密の深読み・完了全件再送・署名を検証')
    parser.add_argument('--coach-once', action='store_true', help='精密結果でAIコーチを1回だけ実行')
    parser.add_argument('--register', action='store_true', help='トークンを保存し、許可リスト用ハッシュだけ表示して終了')
    args = parser.parse_args()
    if (args.expect_deep or args.coach_once) and (args.direct or 'precise' not in args.modes):
        parser.error('深読みとコーチの検証はWorkerのpreciseで実行してください')
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
        server_seconds = None
        deep_started = None
        deep_total = deep_done = 0
        proof = None
        final_batch = None
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
                deep = progress.get('deep', {})
                deep_total, deep_done = deep.get('total', 0), deep.get('done', 0)
                if deep_total and deep_started is None:
                    deep_started = time.monotonic()
                if progress['status'] == 'completed':
                    final_batch = len(progress['results'])
                    if args.expect_deep and mode == 'precise':
                        assert cursor == progress['total'] == final_batch and deep_done == deep_total > 0
                    by_ply = {r['ply']: r for r in results + progress['results']}
                    results = [by_ply[i] for i in sorted(by_ply)]
                    proof = progress.get('coachProof')
                    server_seconds = (progress['finishedAt'] - progress['createdAt']) / 1000
                    break
                results.extend(progress['results'])
                cursor = progress['next']
                if progress['status'] in ('failed', 'cancelled') or time.monotonic() >= deadline:
                    raise RuntimeError(f"解析未完了: {progress['status']}, {progress['error']}")
                time.sleep(2)
        assert [r['ply'] for r in results] == list(range(len(moves) + 1))
        assert all(r['score'] is not None for r in results)
        assert all(len(r['candidates']) <= (1 if mode == 'std' else 3) for r in results)
        assert any(len(r['candidates']) == (1 if mode == 'std' else 3) for r in results)
        deep_plies = [r['ply'] for r in results if 'deep' in r]
        if args.expect_deep and mode == 'precise':
            assert deep_done == len(deep_plies) <= len(results) // 10
            assert proof and proof['jobId'] == job_id and len(proof['mac']) == 64
            assert all(r['deep']['ply'] == r['ply'] and len(r['deep']['candidates']) <= 3 for r in results if 'deep' in r)
            assert progress['quota']['completed']['precise'] == job['quota']['completed']['precise'] + 1
        ended = time.monotonic()
        encoded = json.dumps(results, separators=(',', ':'))
        assert not any(name.lower() in encoded.lower() for name in ('yaneura', 'suisho', '水匠', 'やねうら'))
        print(json.dumps({'mode': mode, 'plies': len(moves), 'positions': len(results),
                          'seconds': round(ended - started, 3), 'serverSeconds': server_seconds,
                          'firstStageSeconds': round(deep_started - started, 3) if deep_started else None,
                          'secondStageSeconds': round(ended - deep_started, 3) if deep_started else None,
                          'deep': {'total': deep_total, 'done': deep_done, 'plies': deep_plies},
                          'finalBatch': final_batch, 'coachProof': bool(proof),
                          'resultBytes': len(encoded.encode()),
                          'matePositions': [r['ply'] for r in results if r['mate']],
                          'duplicate': duplicate, 'jobId': job_id}, ensure_ascii=False), flush=True)
        if args.coach_once and mode == 'precise':
            from measure_coach import call as coach_call, collect
            assert proof and deep_plies
            target = next(i for i in deep_plies if i - 1 in deep_plies)
            consultation = {'requestId': str(uuid.uuid4()), 'analysis': {**payload, 'results': results},
                            'proof': proof, 'perspective': 'observer', 'profile': {'practice': [], 'goal': ''},
                            'style': {'focus': '悪手・改善点', 'detail': 'かんたん'}, 'history': [],
                            'question': f'{target}手目の前後について、保存済み解析の候補1位と形勢を参照付きで簡潔に教えてください。'}
            status, response = coach_call(args.url + '/v1/coach', token, 'POST', consultation, asynchronous=True)
            assert status == 202, (status, response.get('error'))
            answer = collect(args.url, token, consultation['requestId'])
            refs = [r['id'] for section in answer.get('sections', []) for r in section['references']]
            size = len(json.dumps(consultation, ensure_ascii=False, separators=(',', ':')).encode())
            print(json.dumps({'coach': answer['status'], 'seconds': round(time.monotonic() - ended, 3),
                              'error': answer.get('error'), 'requestBytes': size, 'refs': refs}), flush=True)
            assert answer['status'] == 'completed' and any(':deep:' in r for r in refs)



if __name__ == '__main__':
    main()
