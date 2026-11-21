# SPDX-License-Identifier: GPL-3.0-only
"""コーチ用の確定情報。盤面とKIF表記は解析と同じcshogiで扱う。"""
import math
import re
import time
import unicodedata
from collections import Counter

import cshogi
from cshogi.KIF import move_to_kif


def piece_name(value):
    return value.replace('杏', '成香').replace('圭', '成桂').replace('全', '成銀')


def label(side, perspective):
    name = ('sente', 'gote')[side]
    return ('先手', '後手')[side] if perspective == 'observer' else ('あなた' if name == perspective else '相手')


RANKS = '一二三四五六七八九'


def position_fact(board, perspective):
    sides = {label(side, perspective): {'玉': None, '盤上': {}, '持駒': {}}
             for side in (cshogi.BLACK, cshogi.WHITE)}
    for square in range(81):
        if not (p := board.piece(square)):
            continue
        side = sides[label(p >> 4, perspective)]
        piece = piece_name(cshogi.PIECE_JAPANESE_SYMBOLS[board.piece_type(square)])
        coordinate = str(square // 9 + 1) + RANKS[square % 9]
        if piece == '玉':
            side['玉'] = coordinate
        else:
            side['盤上'].setdefault(piece, []).append(coordinate)
    for side, hand in enumerate(board.pieces_in_hand):
        sides[label(side, perspective)]['持駒'] = {cshogi.HAND_PIECE_JAPANESE_SYMBOLS[i]: count
                                                   for i, count in enumerate(hand) if count}
    return sides


def move_fact(board, usi, previous, perspective):
    move = board.move_from_usi(usi)
    if not move or not board.is_legal(move):
        raise ValueError('不正な指し手')
    side = board.turn
    notation = move_to_kif(move, previous)
    drop = cshogi.move_is_drop(move)
    ranks = (cshogi.move_from(move) % 9, cshogi.move_to(move) % 9) if not drop else None
    if drop:
        direction = '打つ'
    else:
        advance = (ranks[0] - ranks[1]) * (1 if side == cshogi.BLACK else -1)
        direction = '前進' if advance > 0 else '後退' if advance < 0 else '横移動'
    # KIFは移動元で同種駒を区別する。省略せず残し、成れる手の不成を補う。
    if not drop and not cshogi.move_is_promotion(move):
        piece = cshogi.move_from_piece_type(move)
        if piece in (1, 2, 3, 4, 5, 6) and any(r <= 2 if side == 0 else r >= 6 for r in ranks):
            notation = notation.replace('(', '不成(')
    notation = piece_name(notation).translate(str.maketrans('１２３４５６７８９', '123456789'))
    moved = cshogi.PIECE_JAPANESE_SYMBOLS[cshogi.move_from_piece_type(move)] if not drop else cshogi.HAND_PIECE_JAPANESE_SYMBOLS[cshogi.move_drop_hand_piece(move)]
    captured = cshogi.PIECE_JAPANESE_SYMBOLS[board.piece_type(cshogi.move_to(move))] if board.piece_type(cshogi.move_to(move)) else 'なし'
    fact = {'表記': ('▲', '△')[side] + notation, '指した側': label(side, perspective), '動いた駒': piece_name(moved), '取った駒': piece_name(captured), '移動': direction}
    board.push(move)
    return fact, move


def evaluation(score, perspective):
    if not score:
        return {'形勢': '不明', '優勢な側': '不明'}
    if score['kind'] != 'cp':
        winner = 0 if score['winner'] == 'sente' else 1
        who, loser = label(winner, perspective), label(1 - winner, perspective)
        if score['kind'] == 'declaration':
            return {'形勢': who + 'が入玉宣言可能', '優勢な側': who, '宣言できる側': who}
        return {'形勢': who + 'が詰ませる方向の探索結果', '優勢な側': who, '詰まされる側': loser}
    v = score['value']
    degree = '互角' if abs(v) < 150 else 'やや有利' if abs(v) < 500 else '有利' if abs(v) < 1500 else '大きく有利' if abs(v) < 3000 else '勝勢'
    favored = 'なし' if abs(v) < 150 else label(0 if v > 0 else 1, perspective)
    if perspective == 'observer':
        state = '互角' if favored == 'なし' else favored + 'が' + degree
    else:
        own = v if perspective == 'sente' else -v
        state = '互角' if favored == 'なし' else degree if own > 0 else {'やや有利': 'やや不利', '有利': '不利', '大きく有利': '大きく不利', '勝勢': '敗勢'}[degree]
        state = 'あなたから見て' + state
    return {'形勢': state, '優勢な側': favored, **({'境界値': True} if score.get('bound') else {})}


PV_LIMIT = 5


def line_fact(board, pv, previous, perspective):
    board = board.copy()
    line, gains, losses, checks, promotions = [], {}, {}, Counter(), Counter()
    for usi in pv[:PV_LIMIT]:
        f, previous = move_fact(board, usi, previous, perspective)
        line.append(f)
        actor, opponent = f['指した側'], label(board.turn, perspective)
        if f['取った駒'] != 'なし':
            gains.setdefault(actor, Counter())[f['取った駒']] += 1
            losses.setdefault(opponent, Counter())[f['取った駒']] += 1
        if board.is_check():
            checks[actor] += 1
        if cshogi.move_is_promotion(previous):
            promotions[actor] += 1
    summary = {k: v for k, v in [('取る駒', gains), ('失う駒', losses), ('王手の回数', checks), ('成りの回数', promotions)] if v}
    return line, summary


# 保存済み応手の表記変換だけを行う。探索はせず、異常に大きい資料で本体の生成を遅らせない。
MATE_REPLY_LIMIT = 4096
MATE_REPLY_SECONDS = 0.25


def result_id(row):
    return f'{row["ply"]}:deep' if row.get('_deep') else str(row['ply'])


def deep_result(row):
    return {**row['deep'], '_deep': True} if 'deep' in row else None


def preferred_result(row):
    return deep_result(row) or row


def win_rate(score, sign):
    value = score['value'] if score['kind'] == 'cp' else (3000 if score['winner'] == 'sente' else -3000)
    # expのオーバーフローを避ける。端の値では丸め後の勝率は変わらない。
    return 100 / (1 + math.exp(max(-700, min(700, -sign * value / 600))))


def mate_reply_facts(results, boards, perspective):
    deadline = time.monotonic() + MATE_REPLY_SECONDS
    count = 0
    replies = {}
    for row in results:
        ply = row['ply']
        proof = row.get('mate')
        if not proof:
            continue
        pv = proof['pv']
        for branch in proof.get('branches', []):
            if count >= MATE_REPLY_LIMIT or time.monotonic() >= deadline:
                return replies
            count += 1
            suffix = [branch['reply'], branch['mate']]
            if suffix == pv[1:]:
                continue  # 代表手順は従来の参照に含まれる。
            sfen, prev = boards[ply]
            line, _ = line_fact(cshogi.Board(sfen), [pv[0], *suffix], prev, perspective)
            replies.setdefault(f'{result_id(row)}:mate', []).append(line[1:])
    return replies


def build_facts(data, *, include_mate_replies=False):
    # 署名照合済みの資料。合法性は本譜と実際に提示する読み筋を確認する。
    initial, moves, results, perspective = (data[k] for k in ('initial', 'moves', 'results', 'perspective'))
    if perspective not in ('sente', 'gote', 'observer') or len(results) != len(moves) + 1:
        raise ValueError('不正な資料')
    board = cshogi.Board() if initial == 'startpos' else cshogi.Board(initial)
    boards, positions, deep_positions, played, played_rows = [], [], {}, [], []
    losses, missed, turns = {}, [], []
    previous = None

    def pair(n):
        before, after = results[n - 1:n + 1]
        if 'deep' in before and 'deep' in after:
            return deep_result(before), deep_result(after)
        return before, after

    def position_for(row):
        position = {'id': f'{result_id(row)}:position', '手数': row['ply'], '手番': label(board.turn, perspective),
                    **evaluation(row['score'], perspective), '確認済みの詰み': bool(row.get('mate'))}
        if played:
            position['直前の実戦手'] = played[-1]
        if row.get('mate'):
            position['詰まされる側'] = label(1 - board.turn, perspective)
        return position

    for ply, r in enumerate(results):
        if r['ply'] != ply:
            raise ValueError('不正な手数')
        boards.append((board.sfen(), previous))
        positions.append(position_for(r))
        if deep := deep_result(r):
            deep_positions[ply] = position_for(deep)
        if ply == len(moves):
            break
        sign = 1 if board.turn == cshogi.BLACK else -1
        f, previous = move_fact(board, moves[ply], previous, perspective)
        b, a = pair(ply + 1)
        before, after = b['score'], a['score']
        f['印'] = '判定なし'
        if before and after:
            loss = win_rate(before, sign) - win_rate(after, sign)
            losses[ply + 1] = loss
            best_move = b['candidates'][0].get('move') if b['candidates'] else None
            if ply >= 30 and best_move != moves[ply]:
                f['印'] = '悪手' if loss >= 20 else '疑問手' if loss >= 10 else '判定なし'
            if before['kind'] == after['kind'] == 'cp' and not before.get('bound') and not after.get('bound') and min(abs(before['value']), abs(after['value'])) >= 150 and before['value'] * after['value'] < 0:
                turns.append(ply + 1)
        if b.get('mate') and b['mate']['pv'][0] != moves[ply]:
            # 別の手でも詰みが続く可能性があるため、コーチが断定できる場合だけ詰み逃しを載せる。
            if ply >= 30:
                f['印'] = '判定なし'
            if after and after['kind'] == 'cp' and not after.get('bound') and not (board.is_check() and board.is_game_over()):
                missed.append(ply + 1)
                if ply >= 30:
                    f['印'] = '詰み逃し'
        played.append(f)
        state = evaluation(after, perspective)
        played_rows.append([ply + 1, f['表記'], f['印'], state['形勢'].removeprefix('あなたから見て'), f['移動'],
                            *(['境界値'] if state.get('境界値') else []), *(['深読み'] if a.get('_deep') else [])])

    final = positions[-1]
    outcome = {'終局理由': '不明', '勝敗': '不明'}
    if board.is_check() and board.is_game_over():
        loser, winner = label(board.turn, perspective), label(1 - board.turn, perspective)
        outcome = {'終局理由': '詰み', '勝った側': winner, '負けた側': loser}
        for pos in (final, deep_positions.get(len(moves), final)):
            pos.update({'確認済みの詰み': True, '詰まされる側': loser})

    def limited(actor, count):
        return sorted((n for n in losses if played[n-1]['印'] in ('悪手', '疑問手') and played[n-1]['指した側'] == actor),
                      key=lambda n: -losses[n])[:count]

    if perspective == 'observer':
        ranked = sorted(limited('先手', 3) + limited('後手', 3), key=lambda n: -losses[n])
    else:
        ranked = limited('あなた', 5) + limited('相手', 2)
    question = unicodedata.normalize('NFKC', data.get('question') or '')
    asked = [int(n) for n in re.findall(r'(?<![0-9])[0-9]{1,3}(?![0-9])(?=\s*手目)', question)]
    asked = [n for n in asked if 1 <= n <= len(moves)]
    key_plies = list(dict.fromkeys(asked + missed + ranked + sorted(turns, key=lambda n: -losses[n])[:1]))

    def best(row):
        return next((c for c in row['candidates'] if c['rank'] == 1 and c.get('pv')), None)

    # 印がない短局でも、根拠のある代案を一つだけ出せるようにする。悪手とは扱わない。
    if not key_plies:
        alternatives = [n for n in range(1, len(moves) + 1) if (c := best(pair(n)[0])) and c['pv'][0] != moves[n-1]]
        key_plies = sorted(alternatives, key=lambda n: -losses.get(n, 0))[:1]

    refs = {p['id']: p for p in (positions[0], final)}

    def position_ref(row):
        return deep_positions[row['ply']] if row.get('_deep') else positions[row['ply']]

    def branch(row, candidate=None):
        ply = row['ply']
        mate = candidate is None
        r = row['mate'] if mate else candidate
        suffix = 'mate' if mate else f'candidate:{r["rank"]}'
        id_ = f'{result_id(row)}:{suffix}'
        if id_ not in refs:
            sfen, prev = boards[ply]
            line, summary = line_fact(cshogi.Board(sfen), r['pv'], prev, perspective)
            ref = {'id': id_, '手数': ply, '仮の読み筋（実戦とは別）': line, '確認済みの詰み': mate}
            if mate:
                ref.update({'詰ませる側': position_ref(row)['手番'], '詰まされる側': position_ref(row)['詰まされる側']})
            else:
                ref.update(evaluation(r['score'], perspective))
                ref.update({'読み筋の得失': summary})
            refs[id_] = ref
        return id_

    keypoints = []
    for n in key_plies:
        b, a = pair(n)
        before, after = position_ref(b), position_ref(a)
        for ref in (before, after):
            refs[ref['id']] = ref
        before['局面'] = position_fact(cshogi.Board(boards[n-1][0]), perspective)
        key = {'手数': n, '実戦手': played[n-1],
               '実戦の続き': [{'手数': i + 1, **played[i]} for i in range(n, min(n + 3, len(played)))], '指す前': before['形勢'], '指した後': after['形勢'],
               '指す前の参照': before['id'], '指した後の参照': after['id']}
        if (c := best(b)) and c['pv'][0] != moves[n-1]:
            key['推奨手の参照'] = branch(b, c)
        if c := best(a):
            key['実戦手への応手の参照'] = branch(a, c)
        if n in turns:
            key['形勢逆転'] = True
        if b.get('mate'):
            key['指す前の詰みの参照'] = branch(b)
        if a.get('mate'):
            key['指した後の詰みの参照'] = branch(a)
        if n in missed:
            key['詰みの見逃し'] = True
        keypoints.append(key)

    # 要所以外の詰みは最初と最後の証明を代表例にする。実戦手ゼロの解析局面にも対応。
    proofs = [r for base in results if (r := preferred_result(base)).get('mate')]
    for r in proofs[:1] + proofs[-1:]:
        branch(r)
    if not moves:
        positions[0]['局面'] = position_fact(board, perspective)
        if not proofs and (c := best(results[0])):
            branch(results[0], c)
    return {
        '視点': '観戦' if perspective == 'observer' else label(0, perspective) + 'が先手、' + label(1, perspective) + 'が後手',
        '実戦手': played_rows,
        '終局': outcome, '要所': keypoints, '参照': list(refs.values()),
        **({'詰みの別応手': mate_reply_facts([row for r in results for row in (r, deep_result(r)) if row], boards, perspective)} if include_mate_replies else {}),
        '注意': '境界値と探索上の詰みは未確定。宣言可能は宣言済みではない。読み筋は冒頭のみで実戦とは別。投了・宣言の記録は入力にない。',
    }
