import json
import subprocess
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

import bridge
from test_coach_facts import data


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

    def post(game=None, calls=None, *, raw=None):
        body = raw if raw is not None else json.dumps({'game': game, 'calls': calls}).encode()
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


@pytest.mark.parametrize('game', [data(initial='k8/9/9/9/9/9/9/9/8K b 99R 1'), data(['7g7f', '7g7f']),
                                 data(['7g7f'] * 513), {**data(), 'results': []}, {**data(), 'sente': '氏名'}])
def test_rejects_invalid_game_even_for_knowledge(api, game):
    assert api(game, [call('knowledge', query='歩')])[0] == 422


def test_batch_and_body_limits(api):
    calls = [call('keypoints')] * 30
    assert api(data(), calls) == (200, {'results': [{'要所': []}] * 30})
    assert api(data(), calls * 2)[0] == 422
    assert api(data(), [])[0] == 422
    assert api(raw=b' ' * 2_097_153)[0] == 413


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


def test_real_mate_and_claim_follow_same_limits(api):
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
