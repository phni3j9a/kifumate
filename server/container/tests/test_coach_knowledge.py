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


def write(path, positions, tactics=()):
    path.write_text(json.dumps({'version': 1, 'strategies': [STRATEGY], 'tesuji': list(tactics), 'joseki': positions},
                               ensure_ascii=False), encoding='utf-8')


def test_missing_database_keeps_builtin_knowledge(db_file, capfd):
    assert call(data(), 'book', {}) == {'状態': '一致なし'}
    assert call({}, 'knowledge', {'query': '入玉宣言'})['知識'][0]['出典'] == coach_knowledge.RULE_SOURCE
    assert call({}, 'knowledge', {'query': '試験戦法'}) == {'知識': []}
    assert capfd.readouterr() == ('', '')


def test_book_and_knowledge(db_file):
    pos = key(LINE[:2])
    write(db_file, {key(): joseki(LINE[0]), key(LINE[:1]): joseki(LINE[1]),
                    pos.replace('/9/', '/45/', 1): joseki(LINE[2], '6i7h', note=NOTE)}, [tesuji(pos, LINE[2], LINE[3])])
    outcome = call(data(LINE[:2] + ['5g5f']), 'book', {})
    assert outcome == {
        '状態': '一致あり', '最後の一致': {'手数': 2, '参照': '2:position'},
        '最初に外れた手': {'手数': 3, '参照': '2:position', '指した側': 'あなた', '実戦手': '▲5六歩(57)',
                       '本の手': ['▲2六歩(27)', '▲7八金(69)']},
        '方針': [{'題': STRATEGY['title'], '説明': STRATEGY['text']}],
        '近くの注記': [{'手数': 2, '参照': '2:position', '説明': NOTE['text']}],
        '手筋': [{'手数': 2, '参照': '2:position', '題': '架空の手筋', '説明': '光輪の歩を使う練習。',
                '正解': '▲2六歩(27)', '実戦で正解': False}],
    }
    followed = call(data(LINE), 'book', {})
    assert followed['最初に外れた手'] is None  # 未収録局面へ進んでも逸脱にはしない。
    assert followed['手筋'][0]['実戦で正解'] is True
    assert call(data(LINE[:2]), 'book', {})['手筋'][0]['実戦で正解'] is None
    for query, title in [('架空の方針', '架空の方針'), ('試験戦法', '架空の方針'), ('薄明', '架空の方針'),
                         ('架空の手筋', '架空の手筋'), ('試験手筋', '架空の手筋'), ('光輪', '架空の手筋')]:
        [hit] = call({}, 'knowledge', {'query': query})['知識']
        assert hit['項目'] == title and set(hit) == {'項目', '説明'}
    assert call({}, 'knowledge', {'query': '入玉宣言'})['知識'][0]['項目'] == '入玉宣言'


def test_position_transposition_and_no_match(db_file):
    alternate = [LINE[2], LINE[3], LINE[0], LINE[1]]
    assert key(LINE) == key(alternate)
    write(db_file, {key(LINE): joseki('2f2e')})
    assert call(data(alternate + ['2f2e']), 'book', {})['最後の一致'] == {'手数': 4, '参照': '4:position'}
    assert call(data(alternate[:3]), 'book', {}) == {'状態': '一致なし'}


def test_rotated_board_turn_hands_and_moves(db_file):
    pos = 'k8/9/9/4+p4/9/9/9/9/8K b 2pgR'
    write(db_file, {pos: joseki('R*4e', '1i2i')}, [tesuji(pos, 'R*4e')])
    rotated = 'k8/9/9/9/9/4+P4/9/9/8K w G2Pr 91'
    out = call(data(['9a9b'], initial=rotated, perspective='observer'), 'book', {})
    assert out['最後の一致'] == {'手数': 0, '参照': '0:position'}
    assert out['最初に外れた手'] == {'手数': 1, '参照': '0:position', '指した側': '後手',
                                '実戦手': '△9二玉(91)', '本の手': ['△6五飛打', '△8一玉(91)']}
    assert out['手筋'][0]['正解'] == '△6五飛打'
    assert call(data(['9a9b'], initial=rotated, perspective='sente'), 'book', {})['最初に外れた手']['指した側'] == '相手'


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


def test_book_bounds_long_descriptions_and_alternatives(db_file):
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
