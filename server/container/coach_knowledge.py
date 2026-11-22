# SPDX-License-Identifier: GPL-3.0-only
"""将棋の短い知識集。記述はすべて独自の要約。"""
from functools import cache
import json
from pathlib import Path
import re
import sys
from threading import Lock
import unicodedata

import cshogi as sh

from coach_facts import RANKS, move_fact
from shogi_input import MOVE, validate_sfen


KNOWLEDGE = {
    '入玉宣言': ('入玉 宣言 点数 28点 27点 持将棋', '手番中、着手前に宣言して時計を止める。玉が敵陣3段内にいて王手されておらず、その範囲に玉以外の自駒が10枚以上必要。玉を除く敵陣内の自駒と持駒を数え、飛・角（龍・馬を含む）を5点、他を1点とし、先手28点以上、後手27点以上。切れ負けでは残り時間も必要で、秒読みでは切れる前に宣言して停止する。条件をすべて満たせば勝ち、一つでも満たさなければ負け。盤面上の条件を満たすことと実際の宣言・勝利は別。大会の規定も確認する。'),
    '持将棋': ('入玉 24点 宣言', '双方入玉して決着が見込めないときの扱い。プロの持将棋は盤上も持駒も数える24点法で、入玉宣言の条件とは別。'),
    '美濃囲い': ('囲い 美濃 振り飛車', '横からの攻めに強い配置を作りやすい。端や玉頭、斜め上から迫られたときは逃げ道も点検する。'),
    '高美濃囲い': ('囲い 美濃 振り飛車', '守りの金を上げて斜め上を厚くした美濃。金を上げた跡の横からの利きには注意。'),
    '銀冠': ('囲い 美濃 振り飛車', '玉頭を銀で受け、上からの攻めに備える形。組み替えの途中や下段の隙を見落としやすい。'),
    '穴熊': ('囲い 居飛車 振り飛車', '玉を隅に入れ金銀で出口を覆う。その場で王手を掛けられにくいが、守りをはがされると逃げる方向が少ない。'),
    '矢倉': ('囲い 居飛車', '玉の前に金銀を並べて上からの攻めに備える。横や下段から回られたときの利きを確認する。'),
    '雁木': ('囲い 居飛車', '二枚の銀を軸に中央を支える柔軟な形。玉の位置や発展形によって端・横への備えは違う。'),
    '舟囲い': ('囲い 居飛車 対振り飛車', '少ない手数で急戦に移れる。金銀が十分連結する前の横からの攻めに注意。'),
    '左美濃': ('囲い 居飛車 美濃', '左側への玉移動と金銀の連結を両立しやすい。玉頭や端を狙える歩や桂が相手にないか確認する。'),
    '金無双': ('囲い 振り飛車', '並べた金で上部を支える簡潔な形。玉の横の銀が通路をふさぐ場合がある。'),
    '中住まい': ('囲い 相掛かり', '玉の左右に逃げ先を残しやすい一方、中央を直接たたかれると応対が難しくなる。'),
    '両取り': ('手筋 フォーク 当たり 王手飛車', '一手で二つの取り先を作る。王手を伴う場合でも、王手を受ける手が同時にもう一方を守れないか確かめる。'),
    'たたきの歩': ('手筋 叩き たたき 垂れ歩', '相手駒の前に歩を打って応手を促し、守りの配置をずらす手筋。取る・かわす・放置の各応手を比べる。'),
    '垂れ歩': ('手筋 たれ歩 と金', 'すぐには取られにくい場所へ歩を打ち、次の成り込みを狙う。成った先で何に当たるかも読む。'),
    '合わせの歩': ('手筋 歩 交換', '相手の歩に自分の歩を接触させ、応手によって筋を開けたり歩を入手したりする。'),
    '継ぎ歩': ('手筋 歩 連打', '先の歩を取らせてから同じ筋で次の歩を使う。相手の駒を釣り出して後続を通せるかが急所。'),
    '底歩': ('手筋 守り 歩', '金などを下段から歩で支えて、横からの攻めに備える。二歩や次の持駒不足も確認する。'),
    '焦点の歩': ('手筋 利き 歩', '複数の相手駒が利く升に歩を打ち、どの駒で取っても相手の配置が乱れることを狙う。'),
    '開き王手': ('手筋 王手 飛 角 香', '利きの線を遮っていた駒が動き、奥の飛・角・香などから王手が通る。動いた駒の次の狙いも点検する。'),
    '駒の損得': ('形勢 駒得 駒損 交換 持駒', '一手で取った駒だけでなく取り返しまで両側を数える。取られた成駒は生駒に戻って持駒になる。'),
    '玉の固さ': ('形勢 玉 安全度 囲い', '守備駒の枚数だけでなく、連結、王手の入り方、玉が逃げられる升を比べる。'),
    '駒の働き': ('形勢 利き 遊び駒', '利きの数より、その利きが玉や争点に届くかを重視する。動ける駒でも攻防に参加できなければ働きは小さい。'),
    '手番': ('形勢 速度 先手 後手', '局面の評価には次に指せる側も関わる。相手に一手渡した場合の脅威と、自分の攻めの速さを比べる。'),
    '詰みと詰めろ': ('詰み 証明 詰めろ 必死 終盤', '詰みは王手を続けてすべての受けを破れること。詰めろは相手が対処しないと次に詰む脅威。探索で見つからないことは非詰みの証明ではない。'),
    'ピンと利き': ('利き 合法手 紐 ピン', '駒の移動方向が升に届いても、動くと自玉が王手になるなら着手できない。幾何的な利きと合法手は区別する。'),
}
RULE_SOURCE = 'https://www.shogi.or.jp/faq/rules/'  # 2026-11-20 確認


DB_PATH = Path(__file__).with_name('knowledge') / 'knowledge.json'
DB_LOCK = Lock()
MAX_DB_BYTES = 16 * 1024 * 1024
INVALID_DB = 'coach_knowledge: invalid knowledge database; ignored'
NO_MATCH = {'状態': '一致なし'}
ROTATE_MOVE = str.maketrans('123456789abcdefghi', '987654321ihgfedcba')
FILES = '123456789１２３４５６７８９'
ROTATE_SQUARE = str.maketrans(FILES + RANKS, '987654321９８７６５４３２１' + RANKS[::-1])
SWAP_WORD = {'先手': '後手', '後手': '先手', '右辺': '左辺', '左辺': '右辺', '右側': '左側', '左側': '右側'}
ORIENTED_TEXT = re.compile(rf'(?<![0-9０-９])[{FILES}][{RANKS}筋]|' + '|'.join(SWAP_WORD))


def require(condition):
    if not condition:
        raise ValueError('invalid knowledge database')


def valid_text(s):
    # JSON のエスケープから入る不正なサロゲートや空白以外の制御文字も拒否する。
    return isinstance(s, str) and bool(s.strip()) and all(c.isprintable() or c.isspace() for c in s)


def check_sources(row):
    sources = row['sources']
    require(isinstance(sources, list) and sources)
    for source in sources:
        require(valid_text(source['book']) and valid_text(source['pages']))


def check_item(row):
    require(re.fullmatch(r'[a-z0-9.-]+', row['id']))
    require(valid_text(row['title']) and valid_text(row['text']))
    require(isinstance(row['tags'], list) and all(map(valid_text, row['tags'])))
    require(row['status'] in ('AI抽出・未監修', 'AI照合済み', '監修済み'))
    check_sources(row)


def normalized_board(sfen):
    position, turn, hands = sfen.split()
    initial = f'{position} {turn} {hands} 1'
    validate_sfen(initial)
    b = sh.Board(initial)
    # is_ok() は不正局面の盤面を出力するので、相手玉の王手だけを黙って検査する。
    a, z = (divmod(b.king_square(side), 9) for side in (sh.BLACK, sh.WHITE))
    require(max(abs(a[0] - z[0]), abs(a[1] - z[1])) > 1)
    opposite = 'w' if turn == 'b' else 'b'
    require(not sh.Board(f'{position} {opposite} {hands} 1').is_check())
    return b


def position_key(board):
    return board.sfen().rsplit(' ', 1)[0]


def rotated_key(key):
    position, turn, hands = key.split(' ')
    ranks = [''.join(re.findall(r'\+?.', row)[::-1]).swapcase() for row in reversed(position.split('/'))]
    hand_tokens = re.findall(r'[0-9]*[A-Za-z]', hands)
    # cshogi の持駒の並びは先手→後手、駒種の順序は色を替えても同じ。
    hands = ''.join(sorted(hand_tokens, key=lambda token: token[-1].isupper())).swapcase() or '-'
    return f'{"/".join(ranks)} {"w" if turn == "b" else "b"} {hands}'


def check_moves(board, moves, *, line=False):
    require(isinstance(moves, list) and moves)
    for usi in moves:
        require(MOVE.fullmatch(usi))
        move = board.move_from_usi(usi)
        require(move and board.is_legal(move))
        if line:
            board.push(move)


def parse_database(raw):
    require(type(raw['version']) is int and raw['version'] == 1)
    require(isinstance(raw['strategies'], list) and isinstance(raw['tesuji'], list) and isinstance(raw['joseki'], dict))
    strategies, joseki, tesuji, ids = {}, {}, {}, set()
    for row in raw['strategies']:
        check_item(row)
        require(row['id'] not in ids)
        strategies[row['id']] = row
        ids.add(row['id'])
    for row in raw['tesuji']:
        check_item(row)
        require(row['id'] not in ids and ('strategy' not in row or row['strategy'] in strategies))
        ids.add(row['id'])
        b = normalized_board(row['sfen'])
        key = position_key(b)
        check_moves(b, row['answer'], line=True)
        tesuji.setdefault(key, []).append(row)
    for sfen, row in raw['joseki'].items():
        b = normalized_board(sfen)
        key = position_key(b)
        require(key not in joseki and row['strategy'] in strategies)
        check_moves(b, row['moves'])
        require(len(row['moves']) == len(set(row['moves'])))
        if 'note' in row:
            require(valid_text(row['note']['text']))
            check_sources(row['note'])
        joseki[key] = row
    return strategies, joseki, tesuji


@cache
def load_database(path):
    try:
        with path.open('rb') as f:
            data = f.read(MAX_DB_BYTES + 1)
        require(len(data) <= MAX_DB_BYTES)
        return parse_database(json.loads(data.decode('utf-8')))
    except FileNotFoundError:
        pass
    except (OSError, ValueError, KeyError, IndexError, TypeError, AttributeError, RecursionError):
        print(INVALID_DB, file=sys.stderr)
    return {}, {}, {}


def database():
    # 同時に初回を迎えてもファイルを二度読まず、診断も一度だけにする。
    with DB_LOCK:
        return load_database(DB_PATH)


def short(text, limit):
    return text if len(text) <= limit else text[:limit - 1] + '…'


def oriented_text(text, limit, turned):
    # shortcut: 明示された升・筋・先後・左右だけを置換。文脈に依存する説明は別途確認する。
    if turned:
        text = ORIENTED_TEXT.sub(lambda m: SWAP_WORD.get(m[0], m[0].translate(ROTATE_SQUARE)), text)
    return short(text, limit)


def description(row, turned=False):
    return {'題': oriented_text(row['title'], 80, turned), '説明': oriented_text(row['text'], 400, turned)}


def book_move(fact):
    return {'表記': fact['表記'], '移動': fact['移動']}


def lookup(query):
    words = unicodedata.normalize('NFKC', query).split()
    hits = []
    for name, (tags, text) in KNOWLEDGE.items():
        score = sum(3 if w in name else 1 if w in tags else 0 for w in words)
        if score or not words:
            hits.append((score, {'項目': name, '説明': text, **({'出典': RULE_SOURCE} if name in ('入玉宣言', '持将棋') else {})}))
    strategies, _, tesuji = database()
    for row in [*strategies.values(), *(r for rows in tesuji.values() for r in rows)]:
        title, tags, text = (unicodedata.normalize('NFKC', s) for s in (row['title'], ' '.join(row['tags']), row['text']))
        if score := sum(3 if w in title else 2 if w in tags else 1 if w in text else 0 for w in words):
            hit = description(row)
            hits.append((score, {'項目': hit['題'], '説明': hit['説明']}))
    return [item for _, item in sorted(hits, key=lambda h: -h[0])[:8]]


def book(game):
    strategies, joseki, tesuji = database()
    if not (joseki or tesuji):
        return NO_MATCH.copy()
    view, moves, initial = game['perspective'], game['moves'], game['initial']
    b = sh.Board() if initial == 'startpos' else sh.Board(initial)
    prev = last = last_departure = None
    tactics, notes, topics = [], [], []
    for ply in range(len(moves) + 1):
        actual = moves[ply] if ply < len(moves) else None
        ref = {'手数': ply, '参照': f'{ply}:position'}
        key = position_key(b)
        book_moves = {}
        for key_, turned in ((key, False), (rotated_key(key), True)):
            if row := joseki.get(key_):
                topics.append((ply, row['strategy'], turned))
                if note := row.get('note'):
                    notes.append((ply, {**ref, '説明': oriented_text(note['text'], 240, turned), '先後反転': turned}))
                for move in row['moves']:
                    book_moves.setdefault(move.translate(ROTATE_MOVE) if turned else move, turned)
            for row in tesuji.get(key_, ()):
                if strategy := row.get('strategy'):
                    topics.append((ply, strategy, turned))
                if len(tactics) < 3:
                    answer = row['answer'][0]
                    if turned:
                        answer = answer.translate(ROTATE_MOVE)
                    fact, _ = move_fact(b.copy(), answer, prev, view)
                    tactics.append({**ref, **description(row, turned), '正解': book_move(fact), '先後反転': turned,
                                    '実戦で正解': None if actual is None else actual == answer})
        if book_moves:
            # 再合流したら、それ以前に一時的に外れた着手は取り消す。
            last = {**ref, '先後反転': key not in joseki}
            last_departure = (b.copy(), prev, book_moves) if actual is not None else None
        if actual is not None:
            _, prev = move_fact(b, actual, prev, view)
    if last is None and not tactics:
        return NO_MATCH.copy()
    departure = None
    if last_departure is not None:
        board, previous, book_moves = last_departure
        ply = last['手数']
        fact, _ = move_fact(board.copy(), moves[ply], previous, view)
        departure = {'参照': last['参照'], '手数': ply + 1, '指した側': fact['指した側'], '実戦手': fact['表記'],
                     '本の手': [{**book_move(move_fact(board.copy(), move, previous, view)[0]), '先後反転': turned}
                               for move, turned in list(book_moves.items())[:8]]}
    near = last['手数'] if last else tactics[0]['手数']
    closest = lambda item: (abs(item[0] - near), item[0])
    topic_turns = {}
    for _, id_, turned in sorted(topics, key=closest):
        topic_turns.setdefault(id_, turned)
    return {'状態': '一致あり', '最後の一致': last, '最初に外れた手': departure,
            '方針': [{**description(strategies[id_], turned), '先後反転': turned}
                   for id_, turned in list(topic_turns.items())[:2]],
            '近くの注記': [note for _, note in sorted(notes, key=closest)[:2]], '手筋': tactics}
