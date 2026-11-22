# SPDX-License-Identifier: GPL-3.0-only
"""将棋の短い知識集。記述はすべて独自の要約。"""
from collections import defaultdict, deque
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
MIN_FULL_PLIES = 10
MIN_FORMATION_MOVES = 5
NO_MATCH = {'状態': '一致なし'}
ROTATE_MOVE = str.maketrans('123456789abcdefghi', '987654321ihgfedcba')
FILES = '123456789１２３４５６７８９'
ROTATE_TEXT = str.maketrans(FILES + RANKS + '右左▲☗△☖', '987654321９８７６５４３２１' + RANKS[::-1] + '左右△☖▲☗')
SWAP_SIDE = {'先手': '後手', '後手': '先手'}
ORIENTED_TEXT = re.compile(rf'(?<![0-9０-９])[{FILES}][{RANKS}筋]|先手|後手|[右左](?![銀桂金香飛角玉四美])|[▲☗△☖]')


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


def layout(board, side):
    return bytes(p if p // 16 == side else 0 for p in board.pieces)


def formation_index(table):
    # 共有序盤はv1では一章にしか属さない。合流・循環も含め、子孫の所属を親へ伝播する。
    parents, children = defaultdict(set), defaultdict(dict)
    membership = {key: {row['strategy']} for key, row in table.items()}
    for key, row in table.items():
        b = sh.Board(key + ' 1')
        for move in row['moves']:
            b.push_usi(move)
            child = position_key(b)
            b.pop()
            if child in table:
                parents[child].add(key)
                children[key][move] = child
            else:
                membership.setdefault(child, set()).add(row['strategy'])
    queue = deque(table)
    while queue:
        child = queue.popleft()
        for parent in parents[child]:
            if not membership[child] <= membership[parent]:
                membership[parent].update(membership[child])
                queue.append(parent)
    index = defaultdict(list)
    for key in membership:
        for oriented, turned in ((key, False), (rotated_key(key), True)):
            b = sh.Board(oriented + ' 1')
            for side in (sh.BLACK, sh.WHITE):
                sources = [key] if b.turn == side and key in table else children[key].values()
                index[side, layout(b, side)].append((key, turned, sources))
    return index, membership, children


def strategy_tags_by_side(game):
    # Worker の classificationCatalog で区別した戦法だけを使い、囲いや大分類は数えない。
    raw = game.get('tags')
    sides = raw.get('対局側') if isinstance(raw, dict) else None
    if not isinstance(sides, dict):
        return {}
    return {name: {tag['名前'] for tag in side['戦法'] if isinstance(tag, dict) and isinstance(tag.get('名前'), str)}
            for name, side in sides.items() if name in ('先手', '後手') and isinstance(side, dict) and isinstance(side.get('戦法'), list)}


def strategy_plans(ids, strategies, by_side, selected):
    plans = []
    for id_ in dict.fromkeys(ids):
        if not id_ or (selected is not None and id_ not in selected):
            continue
        row = strategies[id_]
        owners = [side for side, tags in by_side.items() if row['tags'] and row['tags'][0] in tags]
        turned = owners[0] == '後手' if len(owners) == 1 else None
        if turned is None and ORIENTED_TEXT.search(row['title'] + ' ' + row['text']):
            continue
        plans.append({**description(row, turned), '先後反転': turned})
        if len(plans) == 2:
            break
    return plans


def selected_strategies(by_side, strategies):
    tags = set().union(*by_side.values())
    if not tags:
        return None
    scores = {id_: len(tags.intersection(row['tags'])) for id_, row in strategies.items()}
    best = max(scores.values(), default=0)
    return {id_ for id_, score in scores.items() if score == best and best}


def formation(game, boards):
    strategies, table, _, indexed = database()
    view = game['perspective']
    if view == 'observer' or not table:
        return None
    index, membership, children = indexed
    by_side = strategy_tags_by_side(game)
    selected = selected_strategies(by_side, strategies)
    side = sh.BLACK if view == 'sente' else sh.WHITE
    run, last = 0, None
    moves = game['moves']
    for ply, (sfen, _) in enumerate(boards):
        b = sh.Board(sfen)
        rows = [r for r in index.get((side, layout(b, side)), ()) if selected is None or selected & membership[r[0]]]
        if not rows:
            run = 0
            continue
        if ply and b.turn != side:
            run += 1
        if run >= MIN_FORMATION_MOVES:
            # 相手の応手の後も陣形が一致した場合だけ、自分の次の手と比較する。
            last = (ply, run, rows) if b.turn == side else None
    if not last or last[0] >= len(moves):
        return None
    ply, run, rows = last
    sfen, prev = boards[ply]
    b = sh.Board(sfen)
    legal = {sh.move_to_usi(m) for m in b.legal_moves}
    choices, topics, notes = {}, {}, {}
    for key, turned, sources in rows:
        for source in sources:
            for move in table[source]['moves']:
                child = children[source].get(move)
                belongs = membership[child] if child else {table[source]['strategy']}
                if selected is not None and not selected & belongs:
                    continue
                usi = move.translate(ROTATE_MOVE) if turned else move
                if usi == moves[ply]:
                    return None  # 実戦手も本の手なら逸脱ではない。表示上限より先に調べる。
                if usi in legal and usi not in choices and len(choices) < 8:
                    choices[usi] = {**book_move(move_fact(b.copy(), usi, prev, view)[0]), '先後反転': turned}
        row = table.get(key, {})  # 末端には着手や注記の行がない。
        topics.update(dict.fromkeys((row.get('strategy'), *sorted(membership[key]))))
        if (note := row.get('note')) and len(notes) < 2 and (selected is None or row['strategy'] in selected):
            text = oriented_text(note['text'], 240, turned)
            notes[text] = {'説明': text, '先後反転': turned}
    return {'一致した自分の手数': run, '手数': ply + 1, '参照': f'{ply}:position',
            '実戦手': move_fact(b, moves[ply], prev, view)[0]['表記'], '定跡の手': list(choices.values()),
            '方針': strategy_plans(topics, strategies, by_side, selected), '注記': list(notes.values())}


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
        if 'accept' in row:
            check_moves(b, row['accept'])
            require(len(set(row['accept'])) == len(row['accept']) and row['answer'][0] not in row['accept'])
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
    return strategies, joseki, tesuji, formation_index(joseki)


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
    return {}, {}, {}, {}


def database():
    # 同時に初回を迎えてもファイルを二度読まず、診断も一度だけにする。
    with DB_LOCK:
        return load_database(DB_PATH)


def short(text, limit):
    return text if len(text) <= limit else text[:limit - 1] + '…'


def oriented_text(text, limit, turned):
    # shortcut: 明示された座標・左右・先後・符号だけを置換。文脈に依存する説明は別途確認する。
    if turned:
        text = ORIENTED_TEXT.sub(lambda m: SWAP_SIDE.get(m[0], m[0].translate(ROTATE_TEXT)), text)
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
    strategies, _, tesuji, _ = database()
    for row in [*strategies.values(), *(r for rows in tesuji.values() for r in rows)]:
        title, tags, text = (unicodedata.normalize('NFKC', s) for s in (row['title'], ' '.join(row['tags']), row['text']))
        if score := sum(3 if w in title else 2 if w in tags else 1 if w in text else 0 for w in words):
            hit = description(row)
            hits.append((score, {'項目': hit['題'], '説明': hit['説明']}))
    return [item for _, item in sorted(hits, key=lambda h: -h[0])[:8]]


def book(game):
    strategies, joseki, tesuji, _ = database()
    if not strategies and not tesuji:
        return NO_MATCH.copy()
    view, moves, initial = game['perspective'], game['moves'], game['initial']
    b = sh.Board() if initial == 'startpos' else sh.Board(initial)
    prev = last = last_departure = None
    tactics, notes, topics, boards = [], [], [], []
    by_side = strategy_tags_by_side(game)
    selected = selected_strategies(by_side, strategies)
    matched_plies = 0
    for ply in range(len(moves) + 1):
        boards.append((b.sfen(), prev))
        actual = moves[ply] if ply < len(moves) else None
        ref = {'手数': ply, '参照': f'{ply}:position'}
        key = position_key(b)
        book_moves = {}
        for key_, turned in ((key, False), (rotated_key(key), True)):
            if row := joseki.get(key_):
                topics.append((ply, row['strategy']))
                if note := row.get('note'):
                    notes.append((ply, {**ref, '説明': oriented_text(note['text'], 240, turned), '先後反転': turned}))
                for move in row['moves']:
                    book_moves.setdefault(move.translate(ROTATE_MOVE) if turned else move, turned)
            for row in tesuji.get(key_, ()):
                if strategy := row.get('strategy'):
                    topics.append((ply, strategy))
                if len(tactics) < 3:
                    answers = [row['answer'][0], *row.get('accept', [])]
                    if turned:
                        answers = [m.translate(ROTATE_MOVE) for m in answers]
                    first, *alternates = [book_move(move_fact(b.copy(), m, prev, view)[0]) for m in answers]
                    tactics.append({**ref, **description(row, turned), '正解': first, '先後反転': turned,
                                    **({'別解': alternates} if alternates else {}),
                                    '実戦で正解': None if actual is None else actual in answers})
        if book_moves:
            # 再合流したら、それ以前に一時的に外れた着手は取り消す。
            last = {**ref, '先後反転': key not in joseki}
            last_departure = (b.copy(), prev, book_moves) if actual is not None and matched_plies >= MIN_FULL_PLIES else None
        matched_plies = matched_plies + 1 if actual in book_moves else 0
        if actual is not None:
            _, prev = move_fact(b, actual, prev, view)
    fork = formation(game, boards)
    departure = None
    if last_departure is not None:
        board, previous, book_moves = last_departure
        ply = last['手数']
        fact, _ = move_fact(board.copy(), moves[ply], previous, view)
        departure = {'参照': last['参照'], '手数': ply + 1, '指した側': fact['指した側'], '実戦手': fact['表記'],
                     '本の手': [{**book_move(move_fact(board.copy(), move, previous, view)[0]), '先後反転': turned}
                               for move, turned in list(book_moves.items())[:8]]}
    near = last['手数'] if last else tactics[0]['手数'] if tactics else 0
    closest = lambda item: (abs(item[0] - near), item[0])
    topic_ids = [id_ for _, id_ in sorted(topics, key=closest)]
    if selected:
        topic_ids.extend(id_ for id_ in strategies if id_ in selected)
    plans = fork['方針'] if fork else strategy_plans(topic_ids, strategies, by_side, selected)
    if not (last or tactics or fork or plans):
        return NO_MATCH.copy()
    return {'状態': '一致あり' if last or tactics or fork else '方針のみ', '最後の一致': last, '最初に外れた手': departure,
            **({'駒組みの分岐点': fork} if fork else {}),
            '方針': plans,
            '近くの注記': [note for _, note in sorted(notes, key=closest)[:2]], '手筋': tactics}
