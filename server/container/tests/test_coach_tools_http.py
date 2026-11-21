import json
import subprocess
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

import bridge
from test_coach_facts import CYCLE, KINGS, data


def call(name, **args):
    return {'name': name, 'arguments': json.dumps(args, ensure_ascii=False)}


@pytest.fixture
def api(monkeypatch):
    def forbidden():
        pytest.fail('道具にエンジンは不要')
    monkeypatch.setattr(bridge, 'Engine', forbidden)
    monkeypatch.setattr(bridge, 'engine', None)
    server = bridge.ThreadingHTTPServer(('127.0.0.1', 0), bridge.Handler)
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()

    def post(game=None, calls=None):
        body = json.dumps({'game': game, 'calls': calls}).encode()
        req = Request(f'http://127.0.0.1:{server.server_port}/coach-tools', body, {'Content-Type': 'application/json'})
        try:
            with urlopen(req, timeout=6) as reply:
                return reply.status, json.load(reply)
        except HTTPError as reply:
            with reply:
                return reply.code, json.load(reply)

    yield post
    server.shutdown(); server.server_close(); serving.join()


def test_ordered_batch_and_isolated_failures(api):
    calls = [call('position', position={'ply': 1}), call('not_a_tool'), {'name': 'position', 'arguments': '{'},
             call('legal_moves', position={'ply': 1}, check=1), call('position', position={'ply': True}),
             call('play_line', position={'ply': 1}, moves=['▲7六歩']), call('check_draft', draft='{}'),
             call('knowledge', query='入玉宣言'), call('knowledge', query='あ' * 6000),
             call('check_claims', claims=[{}] * 9), call('position', position={'ply': 0, 'moves': ['▲7六歩'] * 17})]
    status, output = api(data(['7g7f']), calls)
    assert status == 200
    values = output['results']
    assert len(values) == len(calls) and values[0]['本譜の参照'] == '1:position'
    assert all('エラー' in v for v in values[1:7] + values[8:])
    assert values[7]['知識'][0]['項目'] == '入玉宣言'
    assert bridge.engine is None


def test_saved_analysis_and_claims_follow_keypoint_stage(api):
    game = data(CYCLE * 8, initial=KINGS, perspective='observer')
    game['question'] = '32手目'
    rows = game['results']
    rows[30]['deep'] = {**rows[30]}
    rows[31]['score'] = {'kind': 'cp', 'value': 600}
    rows[31]['candidates'] = [{'rank': 1, 'move': '4a3a', 'pv': ['4a3a'], 'score': None}]
    rows[31]['deep'] = {**rows[31], 'score': {'kind': 'cp', 'value': -600},
                        'candidates': [{'rank': 1, 'move': '4a4b', 'pv': ['4a4b'], 'score': None}]}
    pos = {'ply': 31}
    status, body = api(game, [call('keypoints'), call('saved_analysis', position=pos, stage='base'),
                              call('saved_analysis', position=pos, stage='deep'), call('saved_analysis', position=pos),
                              call('saved_analysis', position={'ply': 32}, stage='deep'),
                              call('saved_analysis', position=pos, stage='invalid'), call('check_claims', claims=[
        {'type': 'evaluation', 'position': pos, 'stage': stage, 'expected': side}
        for stage, side in [('base', '先手'), ('deep', '後手')]])])
    assert status == 200
    keys, base, deep, default, missing, invalid, checks = body['results']
    key = keys['要所'][0]
    assert key['手数'] == 32
    assert base['id'] == key['指す前の参照'] == '31:position'
    assert deep == default and deep['id'] == '31:deep:position'
    first, second = (stage['候補と詰み証明'][0] for stage in (base, deep))
    assert first['id'] == key['推奨手の参照'] == '31:candidate:1'
    assert second['id'] == '31:deep:candidate:1'
    assert [c['仮の読み筋（実戦とは別）'][0]['表記'] for c in (first, second)] == ['△3一玉(41)', '△4二玉(41)']
    assert 'エラー' in missing and 'エラー' in invalid
    assert checks['照合'] == [{'一致': True, '正しい値': side} for side in ('先手', '後手')]


@pytest.mark.parametrize('game', [data(initial='k8/9/9/9/9/9/9/9/8K b 99R 1'), data(['7g7f', '7g7f']),
                                 data(['7g7f'] * 513), {**data(), 'results': []}, {**data(), 'sente': '氏名'}])
def test_rejects_invalid_game_even_for_knowledge(api, game):
    assert api(game, [call('knowledge', query='歩')])[0] == 422


def test_batch_and_body_limits(api):
    calls = [call('keypoints')] * 30
    assert api(data(), calls) == (200, {'results': [{'要所': []}] * 30})
    assert api(data(), calls * 2)[0] == 422
    assert api(data(), [])[0] == 422


def test_mate_has_hard_child_timeout_and_batch_continues(api, monkeypatch):
    monkeypatch.setattr(bridge, 'MAX_MATE_SECONDS', 0.02)
    run = subprocess.run

    def slow(args, **kwargs):
        assert kwargs['timeout'] <= 0.02
        return run([args[0], '-c', 'import time; time.sleep(5)'], **kwargs)

    monkeypatch.setattr(bridge.subprocess, 'run', slow)
    before = time.monotonic()
    status, output = api(data(), [call('mate', position={'ply': 0}), call('keypoints')])
    assert time.monotonic() - before < 2
    assert status == 200 and output['results'][0]['状態'] == '未確認'
    assert output['results'][1] == {'要所': []}


def test_real_mate_and_claim_follow_same_limits(api, monkeypatch):
    # プロセス起動の時間制限は別テストで検査。ここではCPU競合で実探索の検査を落とさない。
    monkeypatch.setattr(bridge, 'MAX_MATE_SECONDS', 3)
    monkeypatch.setattr(bridge, 'MAX_TOOL_BATCH_SECONDS', 6)
    game = data(initial='k8/9/1G7/9/9/9/9/9/8K b R 1')
    pos = {'ply': 0}
    status, body = api(game, [call('mate', position=pos), call('check_claims', claims=[
        {'type': 'mate', 'position': pos, 'expected': '詰みを証明'}])])
    assert status == 200
    mate, checked = body['results']
    assert mate['状態'] == '詰みを証明' and mate['手順'] and mate['探索ノード'] <= 10_000
    assert checked['照合'][0]['一致']


def test_result_size_and_expired_batch_are_per_call_errors(api, monkeypatch):
    original = bridge.coach_tool
    monkeypatch.setattr(bridge, 'coach_tool', lambda *a, **kw: {'文': 'あ' * 9000} if a[1] == 'position' else original(*a, **kw))
    status, out = api(data(), [call('position', position={'ply': 0}), call('keypoints')])
    assert status == 200 and '結果が大きすぎます' in out['results'][0]['エラー']
    assert out['results'][1] == {'要所': []}
    monkeypatch.setattr(bridge, 'MAX_TOOL_BATCH_SECONDS', 0)
    status, out = api(data(), [call('position', position={'ply': 0})])
    assert status == 200 and '時間上限' in out['results'][0]['エラー']


def test_busy_tools_reject_before_reading_body(monkeypatch):
    from io import BytesIO

    handler = bridge.Handler.__new__(bridge.Handler)
    handler.path = '/coach-tools'
    handler.headers = {'Content-Length': '8'}
    handler.rfile = BytesIO(b'not-json')
    replies = []
    handler.respond = lambda *args: replies.append(args)
    slots = threading.BoundedSemaphore(1)
    slots.acquire()
    monkeypatch.setattr(bridge, 'tool_slots', slots)
    handler.do_POST()
    assert replies == [(503, {'error': 'tools_busy'})]
    assert handler.rfile.tell() == 0
    handler.headers = {'Content-Length': '2097153'}
    handler.do_POST()
    assert replies[-1] == (413, {'error': 'input_too_large'})
    slots.release()
    # 本文の読み取りそのものは別のソケットテストで検査。
    handler.read_tool_body = lambda length: json.loads(handler.rfile.read(length))
    handler.headers = {'Content-Length': '8'}
    handler.do_POST()
    assert replies[-1][0] == 422 and slots.acquire(blocking=False)


def test_partial_body_has_read_deadline_and_releases_slot(monkeypatch):
    import socket
    from http.client import HTTPResponse

    slots = threading.BoundedSemaphore(1)
    monkeypatch.setattr(bridge, 'tool_slots', slots)
    monkeypatch.setattr(bridge, 'TOOL_READ_SECONDS', 0.1, raising=False)
    server = bridge.ThreadingHTTPServer(('127.0.0.1', 0), bridge.Handler)
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    try:
        with socket.create_connection(server.server_address, timeout=0.75) as conn:
            conn.sendall(b'POST /coach-tools HTTP/1.0\r\nContent-Length: 100\r\n\r\n{')
            with HTTPResponse(conn) as reply:
                reply.begin()
                assert reply.status == 408 and json.load(reply) == {'error': 'input_timeout'}
        assert slots.acquire(blocking=False)
        slots.release()
    finally:
        server.shutdown(); server.server_close(); serving.join()


def test_coach_facts_translates_signed_alternate_mate_replies(monkeypatch):
    game = data(initial='ln+R5l/9/kp2p3p/p1+Spbs3/5p2b/P1P1P4/1P1PSP2P/2G1G4/LNKG4+r b GS2P2nl3p 93')
    game['results'][0]['mate'] = {'plies': 3, 'pv': ['S*8d', '8c8d', 'G*8c'], 'branches': [
        {'reply': '8c8d', 'mate': 'G*8c'}, {'reply': '9c9b', 'mate': 'G*8b'}]}
    expected = [['△9二玉(93)', '▲8二金打']]
    server = bridge.ThreadingHTTPServer(('127.0.0.1', 0), bridge.Handler)
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    try:
        def search(_):
            pytest.fail('保存済み証明のKIF化に再探索は不要')
        monkeypatch.setattr(bridge, 'mate_proof', search)
        req = Request(f'http://127.0.0.1:{server.server_port}/coach-facts', json.dumps(game).encode(), {'Content-Type': 'application/json'})
        with urlopen(req, timeout=3) as reply:
            facts = json.load(reply)
        assert [[m['表記'] for m in line] for line in facts['詰みの別応手']['0:mate']] == expected
        assert len([r for r in facts['参照'] if ':mate' in r['id']]) == 1
    finally:
        server.shutdown(); server.server_close(); serving.join()


def test_long_coach_facts_keeps_alternate_reply_conversion_bounded(monkeypatch):
    import coach_facts as formatting

    cycle = ['7i8h', '9c9b', '8h7i', '9b9c']
    game = data(cycle * 128, initial='ln+R5l/9/kp2p3p/p1+Spbs3/5p2b/P1P1P4/1P1PSP2P/2G1G4/LNKG4+r b GS2P2nl3p 93')
    proof = {'plies': 3, 'pv': ['S*8d', '8c8d', 'G*8c'], 'branches': [
        {'reply': '8c8d', 'mate': 'G*8c'}, {'reply': '9c9b', 'mate': 'G*8b'}]}
    for row in game['results'][::4]:
        row['mate'] = proof
    started = time.monotonic()
    out = bridge.coach_facts(game, include_mate_replies=True)
    assert len(out['実戦手']) == 512 and len(out['詰みの別応手']) == 129
    assert time.monotonic() - started < 2  # 追加探索なしの変換に広めの猶予。
    monkeypatch.setattr(formatting, 'MATE_REPLY_LIMIT', 4)
    out = bridge.coach_facts(game, include_mate_replies=True)
    assert len(out['実戦手']) == 512 and set(out['詰みの別応手']) == {'0:mate', '4:mate'}
