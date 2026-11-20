import json
import sys
from pathlib import Path

import cshogi
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coach_facts import build_facts, evaluation, line_fact, move_fact


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
    assert facts['視点'] == '相手が先手、あなたが後手'
    assert facts['実戦手'][0][1] == '△3四歩(33)'
    d = data(['7g7f', '3c3d', '8h2b+'])
    d['results'][3]['candidates'] = [{'rank': 1, 'score': None, 'pv': ['3a2b', '2g2f']}]
    d['question'] = '3手目はどうでしたか？'
    facts = build_facts(d)
    assert facts['要所'][0]['実戦手']['取った駒'] == '角'
    ref = next(r for r in facts['参照'] if r['id'] == '3:candidate:1')
    assert ref['読み筋'][0]['表記'] == '△同　銀(31)'
    assert ref['読み筋の得失']['失う駒'] == {'あなた': {'馬': 1}}


@pytest.mark.parametrize('perspective,state,side', [
    ('sente', 'あなたから見て不利', '相手'),
    ('gote', 'あなたから見て有利', 'あなた'),
    ('observer', '後手が有利', '後手'),
])
def test_perspective_mark_and_no_raw_notation(perspective, state, side):
    facts = build_facts(data(['7g7f'], perspective))
    assert facts['参照'][-1]['形勢'] == state
    assert facts['参照'][-1]['優勢な側'] == side
    assert facts['実戦手'][0] == [1, '▲7六歩(77)', '悪手', state.removeprefix('あなたから見て')]
    key = facts['要所'][0]
    assert key['手数'] == 1 and key['指した後'] == state
    assert '先手の持駒：なし' in key['指す前の局面図']
    assert facts['終局']['勝敗'] == '不明'
    sent = json.dumps(facts)
    for raw in ('7g7f', 'startpos', 'value', '-600', 'score', 'sfen'):
        assert raw not in sent


def test_bounds_unknown_and_mate_declaration_are_distinct():
    d = data(['7g7f'])
    d['results'][0]['score']['bound'] = 'lowerbound'
    assert build_facts(d)['実戦手'][0][2] == '判定なし'
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


# 短い合法な往復を繰り返し、任意の手に損失や質問を割り当てる。
CYCLE = ['5i4i', '5a4a', '4i5i', '4a5a']
KINGS = '4k4/9/9/9/9/9/9/9/4K4 b - 1'


def test_picks_both_sides_by_loss_and_includes_asked_ply():
    d = data(CYCLE * 4, initial=KINGS)
    v = 2000
    for n, r in enumerate(d['results']):
        if n:
            v += (1 if n % 2 == 0 else -1) * (230 + n * 10)
        r['score']['value'] = v
    d['question'] = '１ 手目と2手目、それから99手目について'
    assert [k['手数'] for k in build_facts(d)['要所']] == [1, 2, 15, 13, 11, 9, 7, 16, 14]
    d.update(perspective='gote', question='')
    assert [k['手数'] for k in build_facts(d)['要所']] == [16, 14, 12, 10, 8, 15, 13]
    d['perspective'] = 'observer'
    assert [k['手数'] for k in build_facts(d)['要所']] == [16, 15, 14, 13, 12, 11]


def test_turning_point_and_question_do_not_duplicate_keypoint():
    d = data(['7g7f'])
    d['question'] = '1手目と１手目について'
    d['results'][0]['score']['value'] = 200
    keys = build_facts(d)['要所']
    assert len(keys) == 1 and keys[0]['形勢逆転'] is True


def test_keypoint_recommendation_and_missed_proven_mate():
    d = data(['9i8i'], initial='8k/6G2/7R1/9/9/9/9/9/K8 b - 1')
    d['results'][0].update(score={'kind': 'mate', 'value': 1, 'winner': 'sente'}, mate={'pv': ['2c1c']},
                           candidates=[{'rank': 1, 'score': None, 'pv': ['2c1c']}, {'rank': 2, 'score': None, 'pv': ['9i8i']}])
    out = build_facts(d)
    k = out['要所'][0]
    assert k['詰みの見逃し'] and k['指す前の詰みの参照'] == '0:mate'
    assert k['推奨手の参照'] == '0:candidate:1'
    refs = {r['id']: r for r in out['参照']}
    assert '0:candidate:2' not in refs
    assert refs['0:mate']['詰まされる側'] == '相手'
    assert refs['0:candidate:1']['読み筋'][0]['表記'] == '▲1三飛不成(23)'
    d['results'][1]['score'] = d['results'][0]['score']
    assert '詰みの見逃し' not in build_facts(d)['要所'][0]


def test_branch_counts_both_sides_checks_promotions_and_only_shown_moves():
    pv = ['7g7f', '3c3d', '2g2f', '8c8d', '8h2b+', '3a2b', 'B*4e']
    line, summary = line_fact(cshogi.Board(), pv, None, 'gote')
    assert len(line) == 5
    assert summary == {'取る駒': {'相手': {'角': 1}}, '失う駒': {'あなた': {'角': 1}}, '成りの回数': {'相手': 1}}
    board = cshogi.Board('8k/6G2/7R1/9/9/9/9/9/K8 b - 1')
    assert line_fact(board, ['2c1c'], None, 'observer')[1] == {'王手の回数': {'先手': 1}}


def test_long_game_keeps_compact_main_line_and_drops_unused_candidates():
    # 日本語は1字、ASCIIは2文字で1トークンと概算。正確な値はAPIのusageを参照。
    d = data(CYCLE * 128, initial=KINGS)
    for r in d['results'][:-1]:
        i = r['ply']
        r['score']['value'] = 30 if i % 2 == 0 else -550
        r['candidates'] = [{'rank': rank, 'score': None, 'pv': [CYCLE[i % 4]]} for rank in range(1, 4)]
    out = build_facts(d)
    assert len(out['実戦手']) == 512
    assert len(out['要所']) == 7
    assert not any(r['id'].endswith((':candidate:2', ':candidate:3')) for r in out['参照'])
    serialized = json.dumps(out, ensure_ascii=False, separators=(',', ':'))
    approximate_tokens = sum(0.5 if c.isascii() else 1 for c in serialized)
    assert approximate_tokens < 15_000
    assert serialized.count('注意') == 1
