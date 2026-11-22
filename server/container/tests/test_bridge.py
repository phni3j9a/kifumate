import json
from pathlib import Path
import sys
import threading
from unittest.mock import Mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import cshogi
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import bridge


def payload(**kwargs):
    return {'initial': 'startpos', 'moves': [], 'mode': 'std', 'ply': 0, **kwargs}


def test_info_and_normalization():
    board = cshogi.Board()
    info = bridge.parse_info('info depth 8 multipv 2 score cp 100 lowerbound pv 7g7f 3c3d bogus', board)
    assert info['rank'] == 2 and info['pv'] == ['7g7f', '3c3d']
    assert info['score'] == {'kind': 'cp', 'value': 100, 'bound': 'lowerbound'}
    board.push_usi('7g7f')
    info = bridge.parse_info('info depth 8 score cp 100 lowerbound pv 3c3d', board)
    assert info['score'] == {'kind': 'cp', 'value': -100, 'bound': 'upperbound'}
    assert bridge.score_for_sente('mate', '3', cshogi.WHITE) == {'kind': 'mate', 'value': -3, 'winner': 'gote'}
    assert bridge.score_for_sente('mate', '-3', cshogi.WHITE)['winner'] == 'sente'
    assert bridge.score_for_sente('mate', '+', cshogi.WHITE)['winner'] == 'gote'
    assert bridge.score_for_sente('mate', '0', cshogi.BLACK)['winner'] == 'gote'
    assert bridge.parse_info('info string engine score cp 5 pv 7g7f', board) is None
    assert bridge.parse_info('info score cp no pv 3c3d', board) is None
    assert bridge.parse_info('info score cp 5 pv 7g7f', board) is None


@pytest.mark.parametrize('kwargs', [
    {'moves': ['7g7e']}, {'moves': ['7g7f', '7g7f']}, {'moves': ['7g7f\nquit']},
    {'initial': '9/9/9/9/9/9/9/9/9 b - 1'},
    {'initial': 'k8/9/9/9/9/9/9/9/8K b 99R 1'},
    {'initial': 'k9/9/9/9/9/9/9/9/8K b - 1'},
    {'initial': 'k8/9/9/9/9/9/9/9/+K8 b - 1'},
    {'ply': True}, {'moves': ['7g7f'] * 513}, {'sente': '個人情報'},
])
def test_reject_invalid(kwargs):
    with pytest.raises(bridge.InvalidInput):
        bridge.prepare(payload(**kwargs))


def test_all_moves_validated_before_analysis():
    with pytest.raises(bridge.InvalidInput):
        bridge.prepare(payload(moves=['7g7f', '3c3d', '7g7f'], ply=0))
    board, *_ = bridge.prepare(payload(moves=['7g7f', '3c3d'], ply=1))
    assert board.turn == cshogi.WHITE


def test_fake_engine_usi_protocol(monkeypatch):
    engine = bridge.Engine([sys.executable, str(ROOT / 'tests/fake_engine.py')])
    commands = []
    send = engine.send
    def record(command):
        commands.append(command)
        send(command)
    monkeypatch.setattr(engine, 'send', record)
    try:
        result = engine.analyze(payload())
        assert result['score'] == {'kind': 'cp', 'value': 123}
        assert result['candidates'][0]['pv'] == ['7g7f', '3c3d']
        assert result['mate'] is None
        assert 'INTERNAL_NAME' not in json.dumps(result)
        assert commands == ['setoption name Threads value 1', 'setoption name MultiPV value 1',
                            'isready', 'usinewgame', 'position startpos', 'go movetime 250']
        assert 'terminal' not in result
        commands.clear()
        for ms in (500, 60_000):
            assert engine.analyze(payload(), movetime_ms=ms)['terminal'] is False
        assert commands == ['position startpos', 'go movetime 500', 'position startpos', 'go movetime 60000']
        commands.clear()
        assert 'terminal' not in engine.analyze(payload(mode='precise'))
        assert commands == ['setoption name Threads value 2', 'setoption name MultiPV value 3',
                            'isready', 'usinewgame', 'position startpos', 'go movetime 1000']
    finally:
        engine.close()


def test_proven_one_and_three_ply_mate():
    sample = json.loads((ROOT.parents[1] / 'mock/data/sample-game.json').read_text())
    found = set()
    for position in sample['positions']:
        if not position.get('tsume'):
            continue
        board = cshogi.Board(position['sfen'])
        proof = bridge.mate_proof(board)
        assert proof is not None
        found.add(proof['plies'])
        # 全応手を返しており、それぞれ実際に詰むことを独立に確認する。
        board.push_usi(proof['pv'][0])
        assert board.is_check()
        assert {cshogi.move_to_usi(m) for m in board.legal_moves} == {b['reply'] for b in proof['branches']}
        if proof['plies'] == 1:
            assert board.is_check() and not list(board.legal_moves)
        for branch in proof['branches']:
            copy = cshogi.Board(board.sfen())
            copy.push_usi(branch['reply'])
            copy.push_usi(branch['mate'])
            assert copy.is_check() and not list(copy.legal_moves)
    assert found == {1, 3}
    assert bridge.mate_proof(cshogi.Board()) is None


def test_http_rejects_private_fields_and_masks_engine_errors(monkeypatch):
    server = bridge.ThreadingHTTPServer(('127.0.0.1', 0), bridge.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f'http://127.0.0.1:{server.server_port}/analyze'
    try:
        with pytest.raises(HTTPError) as error:
            urlopen(Request(url, json.dumps(payload(sente='名前')).encode(), {'Content-Type': 'application/json'}))
        assert error.value.code == 422
        monkeypatch.setenv('ENGINE_PATH', '/not/an/engine')
        with pytest.raises(HTTPError) as error:
            urlopen(Request(url, json.dumps(payload()).encode(), {'Content-Type': 'application/json'}))
        assert error.value.code == 503
        assert json.loads(error.value.read()) == {'error': 'analysis_unavailable'}
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_cpu_dispatch_requires_all_features_on_every_vcpu(monkeypatch):
    flags = ' '.join(bridge.AVX2_FLAGS)
    full = f'processor : 0\nmodel name : Test CPU\nflags : {flags}\n'
    assert bridge.selected_engine(full) == '/app/engine-avx2'
    assert bridge.cpu_details(full)['models'] == ['Test CPU']
    for required in bridge.AVX2_FLAGS:
        missing = full.replace(required, '', 1)
        assert bridge.selected_engine(missing) == '/app/engine-compatible'
    assert bridge.selected_engine(full + '\nprocessor : 1\nflags : sse2\n') == '/app/engine-compatible'
    assert bridge.selected_engine(full + '\nprocessor : 1\n') == '/app/engine-compatible'
    assert bridge.selected_engine('') == '/app/engine-compatible'
    monkeypatch.setattr(bridge.Path, 'read_text', lambda *_: (_ for _ in ()).throw(OSError()))
    assert bridge.selected_engine() == '/app/engine-compatible'


def test_engine_start_log_only_reports_dispatch_fields(monkeypatch, capsys):
    monkeypatch.setattr(bridge.os, 'sched_getaffinity', lambda _: {0})
    info = 'processor : 0\nmodel name : Test CPU\nflags : ' + ' '.join(bridge.AVX2_FLAGS) + '\n'
    path = bridge.selected_engine(info, log=True)
    assert json.loads(capsys.readouterr().out) == {
        'event': 'engine_start', 'engine': path, 'models': ['Test CPU'],
        'processors': 1, 'nproc': 1, 'avx2Usable': True,
    }


def test_benchmark_counts_cumulative_nodes_once_and_ignores_strings():
    from benchmark import search_stats
    assert search_stats([
        'info depth 5 multipv 1 nodes 100',
        'info depth 5 multipv 2 nodes 100',
        'info string nodes 999999 depth 99',
        'info depth 7 multipv 1 nodes 200',
        'info depth 8 multipv 2 nodes 250',
        'info depth bad nodes bad',
    ]) == {'nodes': 250, 'depth': 7}


@pytest.mark.parametrize('sfen,winner', [
    ('+P+P+P+PK+P+P+P+P/+P+P7/9/9/9/9/9/9/4k4 b 2R2B8P 1', 'sente'),
    ('4K4/9/9/9/9/9/9/7+p+p/+p+p+p+pk+p+p+p+p w 2r2b8p 1', 'gote'),
])
def test_declaration_win_is_not_a_move_or_proven_mate(sfen, winner):
    board = cshogi.Board(sfen)
    assert board.is_nyugyoku() and not board.is_game_over()
    engine = bridge.Engine([sys.executable, str(ROOT / 'tests/fake_engine.py'), '--win'])
    try:
        result = engine.analyze(payload(initial=sfen))
        assert result['score'] == {'kind': 'declaration', 'value': None, 'winner': winner}
        assert result['candidates'][0]['declarationWin'] is True
        assert 'move' not in result['candidates'][0]
        assert result['candidates'][0]['pv'] == []
        assert result['mate'] is None
        assert engine.analyze(payload(initial=sfen), movetime_ms=250) == {**result, 'terminal': True}
    finally:
        engine.close()


def test_realtime_checkmate_is_terminal():
    sample = json.loads((ROOT.parents[1] / 'mock/data/sample-game.json').read_text())
    board = cshogi.Board(next(p['sfen'] for p in sample['positions'] if (p.get('tsume') or {}).get('len') == 1))
    board.push(board.mate_move_in_1ply())
    assert board.is_check() and board.is_game_over()
    engine = bridge.Engine([sys.executable, str(ROOT / 'tests/fake_engine.py'), '--resign'])
    try:
        result = engine.analyze(payload(initial=board.sfen()), movetime_ms=250)
        assert result['terminal'] is True and result['candidates'] == []
        assert result['score'] == {'kind': 'mate', 'value': 0, 'winner': 'gote' if board.turn == cshogi.BLACK else 'sente'}
    finally:
        engine.close()


def test_realtime_fourfold_repetition_is_terminal(monkeypatch):
    cycle = ['5i5h', '5a5b', '5h5i', '5b5a']
    engine = bridge.Engine([sys.executable, str(ROOT / 'tests/fake_engine.py')])
    try:
        assert engine.analyze(payload(moves=cycle * 2, ply=8), movetime_ms=250)['terminal'] is False
        def unexpected_search(command):
            raise AssertionError(f'千日手成立後のUSIコマンド: {command}')
        monkeypatch.setattr(engine, 'send', unexpected_search)
        result = engine.analyze(payload(moves=cycle * 3 + ['7g7f'], ply=12), movetime_ms=250)
        assert result == {'ply': 12, 'score': None, 'candidates': [], 'mate': None, 'terminal': True}
    finally:
        engine.close()


def test_realtime_searches_after_breaking_repetition():
    moves = ['5i5h', '5a5b', '5h5i', '5b5a'] * 3 + ['7g7f', '3c3d']
    engine = Mock(spec=bridge.Engine, mode='std')
    engine.until.return_value = ['info depth 4 score cp 123 pv 2g2f', 'bestmove 2g2f']

    result = bridge.Engine.analyze(engine, payload(moves=moves, ply=len(moves)), movetime_ms=250)

    engine.send.assert_any_call('go movetime 250')
    assert result['terminal'] is False
    assert result['score'] == {'kind': 'cp', 'value': 123}
    assert result['candidates'][0]['pv'] == ['2g2f']


def test_realtime_stop_drains_bestmove_and_reuses_process():
    import time
    engine = bridge.Engine([sys.executable, str(ROOT / 'tests/fake_engine.py'), '--slow'])
    cancel = threading.Event()
    failures = []
    def search():
        try:
            engine.analyze(payload(), cancel)
        except Exception as error:
            failures.append(error)
    thread = threading.Thread(target=search)
    try:
        thread.start()
        # readyok と探索の開始を待つ。遅い偽エンジンは stop まで bestmove を返さない。
        deadline = time.monotonic() + 2
        while engine.mode is None and time.monotonic() < deadline:
            time.sleep(0.005)
        time.sleep(0.02)
        began = time.monotonic()
        cancel.set()
        thread.join(timeout=1)
        assert not thread.is_alive() and time.monotonic() - began < 0.5
        assert len(failures) == 1 and isinstance(failures[0], bridge.Superseded)
        assert engine.process.poll() is None
        engine.send('isready')
        assert engine.until('readyok', 1) == ['readyok']
    finally:
        engine.close()
        thread.join(timeout=1)


def test_realtime_http_replaces_search_before_lock(monkeypatch):
    import time
    # 新しい要求はエンジンの直列ロックを待つ前に旧要求を止める。
    entered, cancelled = threading.Event(), threading.Event()
    class FakeEngine:
        def analyze(self, data, cancel, movetime_ms):
            if data['ply'] == 0:
                entered.set()
                assert cancel.wait(2)
                cancelled.set()
                raise bridge.Superseded()
            if movetime_ms is None:
                return {'ply': data['ply'], 'score': {'kind': 'cp', 'value': 10}, 'candidates': [], 'mate': None}
            return {'ply': data['ply'], 'terminal': False, 'movetime': movetime_ms}
        def close(self):
            pass
    monkeypatch.setattr(bridge, 'engine', FakeEngine())
    monkeypatch.setattr(bridge, 'realtime_latest', None)
    monkeypatch.setattr(bridge, 'realtime_cancel', None)
    server = bridge.ThreadingHTTPServer(('127.0.0.1', 0), bridge.Handler)
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    url = f'http://127.0.0.1:{server.server_port}/realtime'
    session = 'a' * 36
    def send(sequence, moves, round_number=0, movetime_ms=250, session_id=session):
        data = payload(moves=moves, ply=len(moves), sessionId=session_id, sequence=sequence)
        path = url
        if round_number is not None:
            path += '/deepen'
            data.update(round=round_number, movetimeMs=movetime_ms)
        try:
            with urlopen(Request(path, json.dumps(data).encode(), {'Content-Type': 'application/json'}), timeout=3) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)
    old = []
    first = threading.Thread(target=lambda: old.append(send(0, [])))
    try:
        first.start(); assert entered.wait(1)
        before = time.monotonic()
        assert send(2, ['7g7f']) == (200, {'ply': 1, 'terminal': False, 'movetime': 250})
        assert time.monotonic() - before < 0.5 and cancelled.is_set()
        first.join(timeout=1)
        assert old == [(409, {'error': 'superseded'})]
        assert send(2, ['7g7f'], round_number=2, movetime_ms=60_000)[1]['movetime'] == 60_000
        latest = bridge.realtime_cancel
        assert send(1, ['7g7f'], round_number=100)[0] == 409
        assert send(2, ['7g7f'], round_number=1)[0] == 409
        assert send(2, ['7g7f'], round_number=2)[0] == 409
        assert send(99, ['7g7f'], session_id='b' * 36)[0] == 409
        for ms in (0, 249, 60_001, True, '500', 250.5):
            assert send(3, ['7g7f'], movetime_ms=ms)[0] == 422
        for number in (-1, True, '3', 3.5):
            assert send(3, ['7g7f'], round_number=number)[0] == 422
        assert bridge.realtime_cancel is latest and not latest.is_set()
        assert send(3, ['7g7f'])[0] == 200
        assert latest.is_set()
        assert send(4, ['7g7f'], round_number=None) == (200, {
            'ply': 1, 'score': {'kind': 'cp', 'value': 10}, 'candidates': [], 'mate': None})
        assert send(4, ['7g7f'], round_number=None)[0] == 409
    finally:
        server.shutdown(); server.server_close(); serving.join(); first.join(timeout=1)


def test_coach_facts_http_does_not_start_engine(monkeypatch):
    def forbidden_start():
        raise AssertionError('表記の生成にエンジン起動は不要')
    monkeypatch.setattr(bridge, 'Engine', forbidden_start)
    monkeypatch.setattr(bridge, 'engine', None)
    server = bridge.ThreadingHTTPServer(('127.0.0.1', 0), bridge.Handler)
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    try:
        data = {'initial': 'startpos', 'moves': ['7g7f'], 'perspective': 'gote', 'results': [
            {'ply': i, 'score': None, 'candidates': [], 'mate': None} for i in range(2)]}
        with urlopen(Request(f'http://127.0.0.1:{server.server_port}/coach-facts', json.dumps(data).encode(), {'Content-Type': 'application/json'}), timeout=3) as response:
            facts = json.load(response)
        assert facts['視点'] == '相手が先手、あなたが後手'
        assert facts['実戦手'][0][1] == '▲7六歩(77)'
        assert bridge.engine is None
    finally:
        server.shutdown(); server.server_close(); serving.join()


def test_deep_http_uses_fixed_precise_settings(monkeypatch):
    engine = bridge.Engine([sys.executable, str(ROOT / 'tests/fake_engine.py')])
    monkeypatch.setattr(bridge, 'engine', engine)
    monkeypatch.setattr(engine, 'send', Mock(wraps=engine.send))
    server = bridge.ThreadingHTTPServer(('127.0.0.1', 0), bridge.Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()

    def send(data, path='/analyze/deep'):
        req = Request(f'http://127.0.0.1:{server.server_port}{path}', json.dumps(data).encode())
        with urlopen(req, timeout=3) as response:
            return json.load(response)

    try:
        for bad in (payload(), payload(mode='precise', movetimeMs=5000), payload(mode='precise', ply=True),
                    payload(mode='precise', moves=['7g7e'])):
            with pytest.raises(HTTPError) as error:
                send(bad)
            assert error.value.code == 422
        engine.send.assert_not_called()
        data = payload(mode='precise', moves=['7g7f'])  # 途中局面でも棋譜全体を検査する。
        assert send(data) == send(data, '/analyze')
        assert [c.args[0] for c in engine.send.call_args_list] == [
            'setoption name Threads value 2', 'setoption name MultiPV value 3', 'isready', 'usinewgame',
            'position startpos', 'go movetime 5000', 'position startpos', 'go movetime 1000',
        ]
    finally:
        server.shutdown()
        worker.join(timeout=1)
        server.server_close()
        engine.close()
