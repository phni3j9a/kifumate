import json

import cshogi as sh
import pytest

from test_coach_facts import data
from coach_tools import call
import coach_knowledge

SOURCE = {'book': 'fixture', 'pages': '1'}
STRATEGY = {'id': 'fixture', 'title': '架空の方針', 'text': '薄明の局面では両方の歩を確かめる。',
            'tags': ['試験戦法'], 'sources': [SOURCE], 'status': 'AI抽出・未監修'}
NOTE = {'text': 'ここでは中央も見る。　架空の注記。', 'sources': [SOURCE]}
LINE = ['7g7f', '3c3d', '2g2f', '8c8d']


def move(notation, direction='前進', *, turned=None):
    out = {'表記': notation, '移動': direction}
    if turned is not None:
        out['先後反転'] = turned
    return out


def key(moves=()):
    b = sh.Board()
    for m in moves:
        b.push_usi(m)
    return b.sfen().rsplit(' ', 1)[0]


def joseki(*moves, **fields):
    return {'moves': list(moves), 'strategy': 'fixture', **fields}


def tesuji(sfen, *answer):
    return {**STRATEGY, 'id': 'fixture.tactic', 'title': '架空の手筋', 'text': '光輪の歩を使う練習。', 'tags': ['試験手筋'],
            'sfen': sfen, 'answer': list(answer), 'strategy': 'fixture'}


@pytest.fixture
def db_file(tmp_path, monkeypatch):
    path = tmp_path / 'knowledge.json'
    monkeypatch.setattr(coach_knowledge, 'DB_PATH', path)
    return path


def write(path, positions, tactics=(), strategies=(STRATEGY,)):
    path.write_text(json.dumps({'version': 1, 'strategies': list(strategies), 'tesuji': list(tactics), 'joseki': positions},
                               ensure_ascii=False), encoding='utf-8')


def test_missing_database_keeps_builtin_knowledge(db_file, capfd):
    assert call(data(), 'book', {}) == {'状態': '一致なし'}
    assert call({}, 'knowledge', {'query': '入玉宣言'})['知識'][0]['出典'] == coach_knowledge.RULE_SOURCE
    assert call({}, 'knowledge', {'query': '試験戦法'}) == {'知識': []}
    assert capfd.readouterr() == ('', '')


def test_book_and_knowledge(db_file, monkeypatch):
    monkeypatch.setattr(coach_knowledge, 'MIN_FULL_PLIES', 0)
    pos = key(LINE[:2])
    write(db_file, {key(): joseki(LINE[0]), key(LINE[:1]): joseki(LINE[1]),
                    pos.replace('/9/', '/45/', 1): joseki(LINE[2], '6i7h', note=NOTE)}, [tesuji(pos, LINE[2], LINE[3])])
    outcome = call(data(LINE[:2] + ['5g5f']), 'book', {})
    assert outcome == {
        '状態': '一致あり', '最後の一致': {'手数': 2, '参照': '2:position', '先後反転': False},
        '最初に外れた手': {'手数': 3, '参照': '2:position', '指した側': 'あなた', '実戦手': '▲5六歩(57)',
                       '本の手': [move('▲2六歩(27)', turned=False), move('▲7八金(69)', turned=False)]},
        '方針': [{'題': STRATEGY['title'], '説明': STRATEGY['text'], '先後反転': False}],
        '近くの注記': [{'手数': 2, '参照': '2:position', '説明': NOTE['text'], '先後反転': False}],
        '手筋': [{'手数': 2, '参照': '2:position', '題': '架空の手筋', '説明': '光輪の歩を使う練習。',
                '正解': move('▲2六歩(27)'), '先後反転': False, '実戦で正解': False}],
    }
    followed = call(data(LINE), 'book', {})
    # 本の手を指しても、その到達局面が表になく後から戻らなければ表を離れた着手。
    assert followed['最初に外れた手']['実戦手'] == '▲2六歩(27)'
    assert followed['手筋'][0]['実戦で正解'] is True
    ended = call(data(LINE[:2]), 'book', {})
    assert ended['最初に外れた手'] is None and ended['手筋'][0]['実戦で正解'] is None
    for query, title in [('架空の方針', '架空の方針'), ('試験戦法', '架空の方針'), ('薄明', '架空の方針'),
                         ('架空の手筋', '架空の手筋'), ('試験手筋', '架空の手筋'), ('光輪', '架空の手筋')]:
        [hit] = call({}, 'knowledge', {'query': query})['知識']
        assert hit['項目'] == title and set(hit) == {'項目', '説明'}
    assert call({}, 'knowledge', {'query': '入玉宣言'})['知識'][0]['項目'] == '入玉宣言'


def test_position_transposition_and_no_match(db_file, monkeypatch):
    monkeypatch.setattr(coach_knowledge, 'MIN_FULL_PLIES', 0)
    alternate = [LINE[2], LINE[3], LINE[0], LINE[1]]
    assert key(LINE) == key(alternate)
    write(db_file, {**{key(LINE[:i]): joseki(m) for i, m in enumerate(LINE)}, key(LINE): joseki('2f2e')})
    rejoined = call(data(alternate), 'book', {})
    assert rejoined['最後の一致'] == {'手数': 4, '参照': '4:position', '先後反転': False}
    assert rejoined['最初に外れた手'] is None  # 初手で表を外れても、4手目で再合流。
    departed = call(data(alternate + ['5g5f']), 'book', {})
    assert departed['最初に外れた手'] == {'手数': 5, '参照': '4:position', '指した側': 'あなた', '実戦手': '▲5六歩(57)',
                                     '本の手': [move('▲2五歩(26)', turned=False)]}
    without_match = 'k8/9/9/9/9/9/9/9/8K b - 1'
    assert call(data(initial=without_match), 'book', {}) == {'状態': '一致なし'}


def test_rotated_board_turn_hands_and_moves(db_file, monkeypatch):
    monkeypatch.setattr(coach_knowledge, 'MIN_FULL_PLIES', 0)
    pos = 'k8/9/9/4+p4/9/9/9/9/8K b 2pgR'
    write(db_file, {pos: joseki('R*4e', '1i2i')}, [tesuji(pos, 'R*4e')])
    rotated = 'k8/9/9/9/9/4+P4/9/9/8K w G2Pr 91'
    out = call(data(['9a9b'], initial=rotated, perspective='observer'), 'book', {})
    assert out['最後の一致'] == {'手数': 0, '参照': '0:position', '先後反転': True}
    assert out['最初に外れた手'] == {'手数': 1, '参照': '0:position', '指した側': '後手', '実戦手': '△9二玉(91)',
                                '本の手': [move('△6五飛打', '打つ', turned=True), move('△8一玉(91)', '横移動', turned=True)]}
    assert out['手筋'][0]['正解'] == move('△6五飛打', '打つ')
    assert call(data(['9a9b'], initial=rotated, perspective='sente'), 'book', {})['最初に外れた手']['指した側'] == '相手'


def test_rotated_prose_keeps_width_and_matches_answer(db_file):
    pos = 'k8/9/6b2/9/9/9/6N2/9/8K b -'
    title = '３三角に狙いをつける2五桂'
    text = ('先手は９筋の右辺から、後手は2筋の左側から。右辺と右端、右側と玉の右にも注目。'
            '右銀・右桂・右金・左香・左飛・右角・右玉・右四間・左美濃はそのまま。')
    note = {**NOTE, 'text': '▲1一と☗９九、△1一と☖９九。左辺と右側。12筋は対象外。'}
    db_file.write_text(json.dumps({'version': 1, 'strategies': [{**STRATEGY, 'title': title, 'text': text}],
                                   'joseki': {pos: joseki('3g2e', note=note)},
                                   'tesuji': [{**tesuji(pos, '3g2e'), 'title': title, 'text': text}]}), encoding='utf-8')
    initial = 'k8/9/2n6/9/9/9/2B6/9/8K w - 1'
    out = call(data(initial=initial), 'book', {})
    [tactic] = out['手筋']
    [strategy] = out['方針']
    [nearby] = out['近くの注記']
    for item in (tactic, strategy):
        assert item['題'] == '７七角に狙いをつける8五桂'
        assert item['説明'] == ('後手は１筋の左辺から、先手は8筋の右側から。左辺と左端、左側と玉の左にも注目。'
                              '右銀・右桂・右金・左香・左飛・右角・右玉・右四間・左美濃はそのまま。')
        assert item['先後反転'] is True
    assert tactic['正解'] == move('△8五桂(73)') and tactic['正解']['表記'][1:4] in tactic['題']
    assert nearby['説明'] == '△9九と☖１一、▲9九と☗１一。右辺と左側。12筋は対象外。' and nearby['先後反転'] is True
    [direct] = call(data(initial=pos + ' 1'), 'book', {})['手筋']
    assert direct['題'] == title and direct['説明'] == text and direct['先後反転'] is False


@pytest.mark.parametrize('invalid', [b'{private broken json', b'\xff', {'version': True},
                                      {'8k/8R/9/9/9/9/9/9/8K b -': joseki('1i2i')},
                                      {'k8/9/9/9/9/9/9/9/8K b 99R': joseki('1i2i')},
                                      {key(): joseki('4a4b')}])
def test_invalid_database_is_ignored_and_diagnosed_once(db_file, capfd, invalid):
    if isinstance(invalid, bytes):
        db_file.write_bytes(invalid)
    elif 'version' in invalid:
        db_file.write_text(json.dumps(invalid))
    else:
        write(db_file, invalid)
    for _ in range(2):
        assert call(data(), 'book', {}) == {'状態': '一致なし'}
        assert call({}, 'knowledge', {'query': '美濃'})['知識'][0]['項目'] == '美濃囲い'
        assert '盤面' in call(data(), 'position', {'position': {'ply': 0}})
    assert capfd.readouterr() == ('', 'coach_knowledge: invalid knowledge database; ignored\n')


def test_book_bounds_long_descriptions_and_alternatives(db_file, monkeypatch):
    monkeypatch.setattr(coach_knowledge, 'MIN_FULL_PLIES', 0)
    start = key()
    candidates = [sh.move_to_usi(m) for m in sh.Board().legal_moves if sh.move_to_usi(m) != '5g5f']
    long_text = '架' * 10000
    task = {**tesuji(start, candidates[0]), 'title': long_text, 'text': long_text}
    tactics = [{**task, 'id': f'fixture.{i}'} for i in range(8)]
    write(db_file, {start: joseki(*candidates, note={**NOTE, 'text': long_text})}, tactics)
    out = call(data(['5g5f']), 'book', {})
    assert len(out['手筋']) == 3 and len(out['手筋'][0]['説明']) == 400 and len(out['手筋'][0]['題']) == 80
    assert len(out['近くの注記'][0]['説明']) == 240
    assert len(out['最初に外れた手']['本の手']) == 8
    assert len(json.dumps(out, ensure_ascii=False).encode()) < 24_000


OPENING = ['7g7f', '3c3d', '2g2f', '8c8d', '3i4h', '7a6b', '6i7h', '4a3b', '5i6h', '5a5b']


def opening_table():
    return {key(OPENING[:i]): joseki(m, note=NOTE) for i, m in enumerate([*OPENING, '2f2e'])}


def tagged(game, strategy, castle='架空囲い'):
    return {**game, 'tags': {'対局側': {'先手': {'戦法': [{'名前': strategy}], '囲い': [{'名前': castle}]}}}}


def test_formation_shared_opening_threshold_and_scoped_choices(db_file):
    other = {**STRATEGY, 'id': 'other', 'tags': ['別戦法'], 'title': '別の方針'}
    table = opening_table()
    table[key(OPENING)]['strategy'] = 'other'  # 序盤の共有行はすべて別の章のまま。
    write(db_file, table, strategies=[{**STRATEGY, 'tags': ['試験戦法', '架空囲い']}, other])
    moves = [*OPENING, '9g9f']
    moves[1] = '1c1d'  # 相手の端歩と角道は一致しない。
    game = tagged(data(moves), '別戦法')
    result = call(game, 'book', {})
    fork = result['駒組みの分岐点']
    assert result['最初に外れた手'] is None
    assert (fork['手数'], fork['参照'], fork['実戦手'], fork['一致した自分の手数']) == (11, '10:position', '▲9六歩(97)', 5)
    assert fork['定跡の手'] == [move('▲2五歩(26)', turned=False)]
    assert [p['題'] for p in fork['方針']] == ['別の方針']
    [k] = call(game, 'keypoints', {})['要所']
    assert k['駒組みの分岐点'] and k['定跡の手'] == fork['定跡の手']
    assert '推奨手の参照' not in k and k['指す前の参照'] == fork['参照']
    assert '駒組みの分岐点' not in call(tagged(game, '対象外'), 'book', {})
    assert '駒組みの分岐点' not in call(data(moves[:8] + ['9g9f']), 'book', {})
    assert '駒組みの分岐点' not in call({**game, 'perspective': 'observer'}, 'book', {})
    assert call(data(OPENING + ['9g9f']), 'book', {})['最初に外れた手']['手数'] == 11
    assert call(data(OPENING[:9] + ['9c9d']), 'book', {})['最初に外れた手'] is None
    isolated = tagged(data(initial='k8/9/9/9/9/9/9/9/8K b - 1'), '別戦法')
    result = call(isolated, 'book', {})
    assert result['状態'] == '方針のみ' and result['方針'][0]['題'] == '別の方針'


def test_formation_rotated_with_other_turn_and_actual_legality(db_file):
    table = opening_table()
    table[key(OPENING)]['moves'].append('8h2b+')  # 実戦では角道が相手の歩で止まる。
    table[key(OPENING)]['note'] = {**NOTE, 'text': '先手の2筋'}
    write(db_file, table)
    moves = [*OPENING, '9g9f']
    moves[1] = '1c1d'
    rotated = data([m.translate(coach_knowledge.ROTATE_MOVE) for m in moves], 'gote',
                   coach_knowledge.rotated_key(key()) + ' 1')
    fork = call(rotated, 'book', {})['駒組みの分岐点']
    assert fork['定跡の手'] == [move('△8五歩(84)', turned=True)]
    assert {'説明': '後手の8筋', '先後反転': True} in fork['注記']


def test_opponent_turn_uses_child_even_when_capture_changes_layout(db_file, monkeypatch):
    prefix = LINE[:3]
    write(db_file, {key(prefix): joseki('2b8h+'), key(prefix + ['2b8h+']): joseki('2f2e')})
    monkeypatch.setattr(coach_knowledge, 'MIN_FORMATION_MOVES', 1)
    fork = call(data(prefix + ['1c1d', '5g5f']), 'book', {})['駒組みの分岐点']
    assert fork['手数'] == 5 and fork['定跡の手'] == [move('▲2五歩(26)', turned=False)]
    assert '駒組みの分岐点' not in call(data(prefix + ['1c1d']), 'book', {})
