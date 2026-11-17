import json
import sys
from pathlib import Path

import cshogi
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coach_facts import build_facts, evaluation, move_fact


def data(moves=(), perspective='sente', initial='startpos'):
    return {'initial': initial, 'moves': list(moves), 'perspective': perspective,
            'results': [{'ply': i, 'score': {'kind': 'cp', 'value': v}, 'candidates': [], 'mate': None}
                        for i, v in enumerate([0] + [-600] * len(moves))]}


def test_kif_same_capture_promotion_and_drop():
    board, previous = cshogi.Board(), None
    line = []
    for usi in ['7g7f', '3c3d', '2g2f', '8c8d', '8h2b+', '3a2b', 'B*4e']:
        f, previous = move_fact(board, usi, previous, 'observer')
        line.append(f)
    assert line[0]['表記'] == '▲7六歩(77)'
    assert line[4] == {'表記': '▲2二角成(88)', '指した側': '先手', '動いた駒': '角', '取った駒': '角'}
    assert line[5] == {'表記': '△同　銀(31)', '指した側': '後手', '動いた駒': '銀', '取った駒': '馬'}
    assert line[6]['表記'] == '▲4五角打'


def test_explicit_nonpromotion_and_promoted_piece():
    board = cshogi.Board('4k4/9/4P4/9/9/9/9/9/4K4 b - 1')
    assert move_fact(board, '5c5b', None, 'sente')[0]['表記'] == '▲5二歩不成(53)'
    board = cshogi.Board('4k4/9/4+p4/9/9/9/9/9/4K4 w - 1')
    assert move_fact(board, '5c5d', None, 'gote')[0]['動いた駒'] == 'と'


def test_handicap_white_turn_and_branch_same_square():
    facts = build_facts(data(['3c3d'], 'gote', 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL w - 1'))
    assert facts['実戦手'][0]['指した側'] == 'あなた'
    assert facts['実戦手'][0]['表記'] == '△3四歩(33)'
    d = data(['7g7f', '3c3d', '8h2b+'])
    d['results'][3]['candidates'] = [{'rank': 1, 'score': None, 'pv': ['3a2b', '2g2f']}]
    refs = build_facts(d)['参照']
    assert refs[-1]['読み筋'][0]['表記'] == '△同　銀(31)'


@pytest.mark.parametrize('perspective,state,side,direction', [
    ('sente', 'あなたから見て不利', '相手', 'あなたから見て悪化'),
    ('gote', 'あなたから見て有利', 'あなた', 'あなたから見て改善'),
    ('observer', '後手が有利', '後手', '先手から見て悪化'),
])
def test_perspective_mark_and_no_raw_notation(perspective, state, side, direction):
    facts = build_facts(data(['7g7f'], perspective))
    assert facts['参照'][-1]['形勢'] == state
    assert facts['参照'][-1]['優勢な側'] == side
    assert facts['実戦手'][0]['評価変化'] == direction
    assert facts['実戦手'][0]['印'] == '悪手'
    assert facts['終局']['勝敗'] == '不明'
    sent = json.dumps(facts)
    for raw in ('7g7f', 'startpos', 'value', '-600', 'score', 'sfen'):
        assert raw not in sent


def test_bounds_unknown_and_mate_declaration_are_distinct():
    d = data(['7g7f'])
    d['results'][0]['score']['bound'] = 'lowerbound'
    assert build_facts(d)['実戦手'][0]['印'] == '判定なし'
    assert evaluation(None, 'sente')['形勢'] == '不明'
    assert evaluation({'kind': 'cp', 'value': 100}, 'sente')['形勢'] == 'あなたから見て互角'
    for perspective, winner in [('sente', 'あなた'), ('gote', '相手'), ('observer', '先手')]:
        score = {'kind': 'declaration', 'winner': 'sente', 'value': None}
        assert evaluation(score, perspective)['宣言できる側'] == winner
        score['kind'] = 'mate'
        assert evaluation(score, perspective)['優勢な側'] == winner
        assert '宣言できる側' not in evaluation(score, perspective)
    d = data()
    d['results'][0]['score'] = {'kind': 'mate', 'winner': 'sente', 'value': 3}
    facts = build_facts(d)
    assert facts['参照'][0]['確認済みの詰み'] is False
    assert facts['参照'][0]['詰まされる側'] == '相手'
    assert facts['終局']['勝敗'] == '不明'


def test_checkmate_proves_terminal_and_winner():
    d = data(initial='8k/6G2/7R1/9/9/9/9/9/K8 b - 1', moves=['2c1c'])
    facts = build_facts(d)
    assert facts['終局'] == {'終局理由': '詰み', '勝った側': 'あなた', '負けた側': '相手'}
    assert facts['参照'][-1]['確認済みの詰み'] is True


def test_illegal_moves_are_not_described():
    with pytest.raises(ValueError):
        build_facts(data(['7g7e']))


@pytest.mark.parametrize('symbol,name', [('l', '成香'), ('n', '成桂'), ('s', '成銀')])
def test_promoted_minor_pieces_use_full_kif_names(symbol, name):
    board = cshogi.Board(f'4k4/9/4+{symbol}4/9/9/9/9/9/4K4 w - 1')
    fact, _ = move_fact(board, '5c5d', None, 'observer')
    assert fact['表記'] == f'△5四{name}(53)'
    assert fact['動いた駒'] == name
