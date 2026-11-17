import json
from pathlib import Path
import sys
import threading
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


def test_fake_engine_usi_protocol():
    engine = bridge.Engine([sys.executable, str(ROOT / 'tests/fake_engine.py')])
    try:
        result = engine.analyze(payload())
        assert result['score'] == {'kind': 'cp', 'value': 123}
        assert result['candidates'][0]['pv'] == ['7g7f', '3c3d']
        assert result['mate'] is None
        assert 'INTERNAL_NAME' not in json.dumps(result)
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
    finally:
        engine.close()
