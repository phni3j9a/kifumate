import json

import cshogi as sh
import pytest

from test_coach_facts import data
from coach_tools import ToolError, attacks, call, mate, resolve, square


def test_long_range_and_promoted_attacks():
    b = sh.Board('8k/2R1+B4/3p5/4+L4/4+R4/3L5/3p5/9/K8 b - 1')
    a = lambda p: attacks(b, square(p))
    assert square('7九') in a('7二')
    assert {square(s) for s in ('4二', '6三', '5三')} <= a('5二')
    assert square('9六') not in a('5二')  # 6三で止まる
    assert square('6五') not in a('5四')  # 成香は斜め後ろに利かない
    assert square('5五') in a('5四')  # 味方の駒でも「利き」に含める
    assert {square(s) for s in ('4六', '4五', '5九')} <= a('5五')
    assert {square('6五'), square('6三')} <= a('6六')
    assert square('6七') not in a('6六')


def test_kif_direction_and_ambiguity():
    b = sh.Board('k8/9/9/9/4G4/3G1G3/9/9/8K b G 1')
    as_usi = lambda s: sh.move_to_usi(resolve(b, s))
    assert as_usi('▲５六金右寄') == '4f5f'
    assert as_usi('▲５六金左寄') == '6f5f'
    assert as_usi('▲５六金引') == '5e5f'
    assert as_usi('▲５六金打') == 'G*5f'
    with pytest.raises(ToolError) as exc:
        as_usi('▲5六金')
    assert len(exc.value.result['候補']) == 4
    with pytest.raises(ToolError, match='不正'):
        as_usi('△5六金(46)')
    assert sh.move_to_usi(resolve(sh.Board(), '▲５八金右')) == '4i5h'
    assert sh.move_to_usi(resolve(sh.Board('k8/9/9/9/9/9/9/9/4K4 b G 1'), '▲6四金')) == 'G*6d'


def test_kif_same_promotion_and_straight():
    b = sh.Board()
    prev = None
    for kif in ['▲7六歩', '△3四歩', '▲2六歩', '△8四歩']:
        prev = resolve(b, kif, prev)
        b.push(prev)
    assert sh.move_to_usi(resolve(b, '▲2二角不成', prev)) == '8h2b'
    prev = resolve(b, '▲2二角成', prev)
    b.push(prev)
    assert sh.move_to_usi(resolve(b, '△同　銀', prev)) == '3a2b'
    assert sh.move_to_usi(resolve(sh.Board('k8/9/9/9/9/4S4/9/9/8K b - 1'), '▲5五銀直')) == '5f5e'


def test_dfpn_mating_line_and_limit():
    b = sh.Board('k8/9/1G7/9/9/9/9/9/8K b R 1')
    out = mate(b, None, 'observer')
    assert out['状態'] == '詰みを証明' and out['詰まされる側'] == '後手' and out['手順']
    prev = None
    for kif in out['手順']:
        prev = resolve(b, kif, prev)
        b.push(prev)
        assert b.is_check() or b.turn == sh.BLACK
    assert mate(b, prev, 'observer')['状態'] == '既に詰み'
    assert mate(sh.Board(), None, 'observer')['状態'] == '未確認'


def test_real_errors_v3_and_claims():
    # v3で間違えた局面のみ（開始局面、77手目の直後）を固定する。
    promoted = data(initial='ln3+R3/1ks+L2+S2/1pp1p3p/p2p5/2b1Pp3/P8/1PNP1PN1P/2K2G3/L2G4+p b RSN2Pb2gsl2p 75')
    king = data(initial='l+R3+R3/6+S2/kpp1p3p/p2p5/2b1Pp3/P8/1PNP1PN1P/2K2G3/L2G4+p b 2S2N2Pb2gs2l2p 81')
    exchange = data(initial='ln4r+Pl/1k1+S5/1ps1p3p/p1ppbs3/5p2b/P1P1P4/1P1PSP2P/2G1G4/LNK4+RL w 2GP2n2p 78', perspective='gote')
    def check(game, **claim):
        return call(game, 'check_claims', {'claims': [{'position': {'ply': 0}, **claim}]})['照合'][0]
    assert check(promoted, type='attack', **{'from': '6二', 'to': '7三'}, expected=True) == {'一致': False, '正しい値': False}
    assert check(king, type='piece', square='9三', expected={'側': 'あなた', '駒': '玉'}) == {'一致': False, '正しい値': {'側': '相手', '駒': '玉'}}
    assert check(exchange, type='captures', moves=['△2一飛', '▲同龍', '△同角'], expected={'あなた': {'と': 1, '角': 1}, '相手': {'飛': 1}}) == {
        '一致': False, '正しい値': {'あなた': {'と': 1, '龍': 1}, '相手': {'飛': 1}}}


def test_knowledge_query_and_json_tools():
    value = call({}, 'knowledge', {'query': '入玉宣言'})['知識'][0]
    assert all(s in value['説明'] for s in ('28点', '27点', '10枚', '王手'))
    assert call({}, 'knowledge', {'query': '存在しない語'}) == {'知識': []}
    for name, args in [('position', {}), ('square', {'square': '4四'}), ('piece_attacks', {'square': '6九'}),
                       ('threats', {}), ('king_safety', {}), ('legal_moves', {'check': True}),
                       ('play_line', {'moves': ['△3四歩']}), ('compare_moves', {'move': '△3四歩', 'alternative': '△8四歩'}),
                       ('material', {'moves': ['△3四歩']}), ('saved_analysis', {'position': {'ply': 1}})]:
        game = data(['7g7f'])
        result = call(game, name, {'position': {'ply': 0, 'moves': ['▲7六歩']}, **args})
        assert 'エラー' not in result, (name, result)
        json.dumps(result, ensure_ascii=False)
    assert call(data(), 'position', {'position': {'ply': -1}}).get('エラー')
