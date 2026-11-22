import json
from pathlib import Path

from cshogi import KIF
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
        '方針': [{'題': STRATEGY['title'], '説明': STRATEGY['text'], '先後反転': None}],
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


def test_rotated_prose_keeps_width_and_matches_answer(db_file, monkeypatch):
    monkeypatch.setattr(coach_knowledge, 'MIN_FULL_PLIES', 0)
    pos = 'k8/9/6b2/9/9/9/6N2/9/8K b -'
    title = '３三角に狙いをつける2五桂'
    text = ('先手は９筋の右辺から、後手は2筋の左側から。右辺と右端、右側と玉の右にも注目。'
            '右銀・右桂・右金・左香・左飛・右角・右玉・右四間・左美濃はそのまま。')
    note = {**NOTE, 'text': '▲1一と☗９九、△1一と☖９九。左辺と右側。12筋は対象外。'}
    db_file.write_text(json.dumps({'version': 1, 'strategies': [{**STRATEGY, 'title': title, 'text': text}],
                                   'joseki': {pos: joseki('3g2e', note=note)},
                                   'tesuji': [{**tesuji(pos, '3g2e'), 'title': title, 'text': text}]}), encoding='utf-8')
    initial = 'k8/9/2n6/9/9/9/2B6/9/8K w - 1'
    game = data(initial=initial)
    assert call(game, 'book', {})['方針'] == []
    game['tags'] = {'対局側': {'後手': {'戦法': [{'名前': '試験戦法'}]}}}
    out = call(game, 'book', {})
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

    # 表の相手は角交換したが、実戦の相手は端歩。そこで同じ本の手を選んでも
    # 到達陣形は一致しない。実戦手そのものを逸脱として報告しない。
    assert '駒組みの分岐点' not in call(data(prefix + ['1c1d', '2f2e']), 'book', {})


def test_last_book_move_reaches_terminal_layout_without_keypoint(db_file):
    write(db_file, opening_table())
    line = [*OPENING, '2f2e']
    assert '駒組みの分岐点' not in call(data(line), 'book', {})
    game = data(line + ['9c9d', '9g9f'])
    fork = call(game, 'book', {})['駒組みの分岐点']
    assert (fork['手数'], fork['一致した自分の手数'], fork['定跡の手']) == (13, 6, [])
    assert call(game, 'keypoints', {})['要所'] == []
    # 別の理由で同じ手数が要所になっても「駒組みの分岐点」とは呼ばない。
    [asked] = call({**game, 'question': '13手目'}, 'keypoints', {})['要所']
    assert '駒組みの分岐点' not in asked


@pytest.mark.parametrize('later_count,expected', [(2, 11), (5, 23)])
def test_last_qualifying_match_survives_short_rejoin(db_file, later_count, expected):
    table = opening_table()
    # 11手目で外れ、13手目から別の掲載局面へ再合流する。
    moves = OPENING + ['9g9f', '9c9d', '1g1f', '1c1d', '3g3f', '3d3e', '4g4f', '4c4d',
                       '5g5f', '5c5d', '6g6f', '6c6d', '9f9e']
    for ply in range(13, 13 + 2 * later_count, 2):
        table[key(moves[:ply + 1])] = joseki('2f2e')
    write(db_file, table)
    fork = call(data(moves), 'book', {})['駒組みの分岐点']
    assert fork['手数'] == expected and fork['一致した自分の手数'] == 5


def test_opponent_capture_ends_match_before_recapture(db_file):
    write(db_file, opening_table())
    out = call(data(OPENING[:9] + ['2b8h+', '7h8h']), 'book', {})
    assert '駒組みの分岐点' not in out


def test_tag_only_strategy_turn_comes_from_owner_of_first_tag(db_file):
    row = {**STRATEGY, 'tags': ['主戦法', '共有戦法'], 'text': '先手の２筋に注目。'}
    write(db_file, {}, strategies=[row])
    game = tagged(data(), '共有戦法')
    sides = game['tags']['対局側']
    assert call(game, 'book', {}) == {'状態': '一致なし'}
    sides['後手'] = {'戦法': [{'名前': '主戦法'}]}
    [plan] = call(game, 'book', {})['方針']
    assert plan['先後反転'] is True and plan['説明'] == '後手の８筋に注目。'
    sides['先手'] = sides['後手']
    assert call(game, 'book', {}) == {'状態': '一致なし'}


def test_tesuji_accept_correct_alternative_both_orientations(db_file):
    pos = 'k8/9/9/4+p4/9/9/9/9/8K b 2pgR'
    write(db_file, {}, [{**tesuji(pos, 'R*4e'), 'accept': ['1i2i']}])
    for turned, key_, actual, notation in [(False, pos, '1i2i', '▲2九玉(19)'),
                                           (True, coach_knowledge.rotated_key(pos), '9a8a', '△8一玉(91)')]:
        [hit] = call(data([actual], initial=key_ + ' 1'), 'book', {})['手筋']
        assert hit['実戦で正解'] is True and hit['先後反転'] == turned
        assert hit['別解'] == [move(notation, '横移動')]


@pytest.mark.parametrize('bad', [['7g7f'], ['4a4b'], ['2g2f', '2g2f']])
def test_invalid_tesuji_accept(db_file, bad):
    write(db_file, {}, [{**tesuji(key(), '7g7f'), 'accept': bad}])
    assert call(data(), 'book', {}) == {'状態': '一致なし'}


def test_game10_observer_strategy_owner_overrides_shared_opening(db_file, monkeypatch):
    monkeypatch.setattr(coach_knowledge, 'MIN_FULL_PLIES', 0)
    game10 = Path(__file__).resolve().parents[2] / 'scripts/games/game10.kif'
    moves = [sh.move_to_usi(m) for m in KIF.Parser.parse_str(game10.read_text()).moves]
    row = {**STRATEGY, 'tags': ['右四間飛車', '四間飛車'], 'text': '先手の２筋に注目。'}
    write(db_file, {key(): joseki(moves[0])}, strategies=[row, {**row, 'id': 'another'}])
    game = tagged(data(moves, perspective='observer'), '四間飛車')
    game['tags']['対局側']['後手'] = {'戦法': [{'名前': '右四間飛車'}]}
    out = call(game, 'book', {})
    assert out['最後の一致']['先後反転'] is False
    assert [(p['先後反転'], p['説明']) for p in out['方針']] == [(True, '後手の８筋に注目。')] * 2
    game['tags']['対局側']['先手'] = game['tags']['対局側']['後手']
    assert call(game, 'book', {})['方針'] == []


def test_neutral_tag_only_plan_requires_primary_strategy(db_file):
    row = {**STRATEGY, 'tags': ['主戦法', '相手戦法']}
    write(db_file, {}, strategies=[row])
    game = tagged(data(), '相手戦法')
    assert call(game, 'book', {}) == {'状態': '一致なし'}
    game['tags']['対局側']['後手'] = {'戦法': [{'名前': '主戦法'}]}
    assert call(game, 'book', {})['方針'][0]['先後反転'] is True


def test_shallow_full_match_hides_last_match_and_notes(db_file):
    # 10手未満の一致は戦型違いでも起きるので出さず、10手以上なら出す。
    line = OPENING + ['9g9f', '9c9d']
    write(db_file, {key(line[:i]): joseki(line[i], **({'note': NOTE} if i == 1 else {})) for i in range(len(line))})
    shallow = call(data(line[:2] + ['5g5f']), 'book', {})
    assert shallow.get('最後の一致') is None and shallow.get('近くの注記', []) == []
    deep = call(data(line + ['1g1f']), 'book', {})
    assert deep['最後の一致']['手数'] == len(line) - 1
    assert deep['近くの注記']


def test_last_match_needs_consecutive_book_moves(db_file):
    # 局面番号ではなく、連続して本の手を指した手数で表示を決める。
    line = OPENING + ['9g9f', '9c9d']
    write(db_file, {key(line[:i]): joseki(line[i], note=NOTE) for i in range(len(line))})
    joined = line[2:4] + line[:2] + line[4:]  # 手順前後で10手目に合流するが、合流前の手は表にない。
    out = call(data(joined[:10] + ['1g1f']), 'book', {})
    assert out.get('最後の一致') is None and out.get('近くの注記', []) == []


def test_fork_without_deep_full_match_hides_shallow_notes(db_file):
    # 分岐点には専用の注記があるので、浅い全局面一致の注記は出さない。
    other = {**STRATEGY, 'id': 'other', 'tags': ['別戦法'], 'title': '別の方針'}
    table = opening_table()
    table[key(OPENING)]['strategy'] = 'other'
    write(db_file, table, strategies=[{**STRATEGY, 'tags': ['試験戦法', '架空囲い']}, other])
    moves = [*OPENING, '9g9f']
    moves[1] = '1c1d'
    result = call(tagged(data(moves), '別戦法'), 'book', {})
    assert result['駒組みの分岐点']['参照'] == '10:position'
    assert result['最後の一致'] is None and result['近くの注記'] == []
