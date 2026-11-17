# SPDX-License-Identifier: GPL-3.0-only
"""コーチ用の確定情報。盤面とKIF表記は解析と同じcshogiで扱う。"""
import cshogi
from cshogi.KIF import move_to_kif


def piece_name(value):
    return value.replace('杏', '成香').replace('圭', '成桂').replace('全', '成銀')


def label(side, perspective):
    name = ('sente', 'gote')[side]
    return ('先手', '後手')[side] if perspective == 'observer' else ('あなた' if name == perspective else '相手')


def move_fact(board, usi, previous, perspective):
    move = board.move_from_usi(usi)
    if not move or not board.is_legal(move):
        raise ValueError('不正な指し手')
    side = board.turn
    notation = move_to_kif(move, previous)
    # KIFは移動元で同種駒を区別する。省略せず残し、成れる手の不成を補う。
    if not cshogi.move_is_drop(move) and not cshogi.move_is_promotion(move):
        piece = cshogi.move_from_piece_type(move)
        ranks = (cshogi.move_from(move) % 9, cshogi.move_to(move) % 9)
        if piece in (1, 2, 3, 4, 5, 6) and any(r <= 2 if side == 0 else r >= 6 for r in ranks):
            notation = notation.replace('(', '不成(')
    notation = piece_name(notation).translate(str.maketrans('１２３４５６７８９', '123456789'))
    moved = cshogi.PIECE_JAPANESE_SYMBOLS[cshogi.move_from_piece_type(move)] if not cshogi.move_is_drop(move) else cshogi.HAND_PIECE_JAPANESE_SYMBOLS[cshogi.move_drop_hand_piece(move)]
    captured = cshogi.PIECE_JAPANESE_SYMBOLS[board.piece_type(cshogi.move_to(move))] if board.piece_type(cshogi.move_to(move)) else 'なし'
    fact = {'表記': ('▲', '△')[side] + notation, '指した側': label(side, perspective), '動いた駒': piece_name(moved), '取った駒': piece_name(captured)}
    board.push(move)
    return fact, move


def evaluation(score, perspective):
    if not score:
        return {'形勢': '不明', '優勢な側': '不明'}
    if score['kind'] != 'cp':
        winner = 0 if score['winner'] == 'sente' else 1
        who, loser = label(winner, perspective), label(1 - winner, perspective)
        if score['kind'] == 'declaration':
            return {'形勢': who + 'が入玉宣言可能', '優勢な側': who, '宣言できる側': who, '注意': '宣言可能という解析。実戦の宣言記録ではない。'}
        return {'形勢': who + 'が詰ませる方向の探索結果', '優勢な側': who, '詰まされる側': loser, '注意': '探索スコアだけでは詰みを確認したことにならない。'}
    v = score['value']
    degree = '互角' if abs(v) < 150 else 'やや有利' if abs(v) < 500 else '有利' if abs(v) < 1500 else '大きく有利' if abs(v) < 3000 else '勝勢'
    favored = 'なし' if abs(v) < 150 else label(0 if v > 0 else 1, perspective)
    if perspective == 'observer':
        state = '互角' if favored == 'なし' else favored + 'が' + degree
    else:
        own = v if perspective == 'sente' else -v
        state = '互角' if favored == 'なし' else degree if own > 0 else {'やや有利': 'やや不利', '有利': '不利', '大きく有利': '大きく不利', '勝勢': '敗勢'}[degree]
        state = 'あなたから見て' + state
    return {'形勢': state, '優勢な側': favored, **({'注意': '探索の境界値であり、確定した評価ではない。'} if score.get('bound') else {})}


def build_facts(data):
    # 公開入口の署名照合後にのみ利用。全本譜と各読み筋の合法性もここで確認する。
    initial, moves, results, perspective = (data[k] for k in ('initial', 'moves', 'results', 'perspective'))
    if perspective not in ('sente', 'gote', 'observer') or len(results) != len(moves) + 1:
        raise ValueError('不正な資料')
    board = cshogi.Board() if initial == 'startpos' else cshogi.Board(initial)
    previous = None
    refs, played = [], []
    for ply, r in enumerate(results):
        if r['ply'] != ply:
            raise ValueError('不正な手数')
        position = {'id': f'{ply}:position', '手数': ply, '手番': label(board.turn, perspective), **evaluation(r['score'], perspective), '確認済みの詰み': bool(r.get('mate'))}
        if played:
            position['直前の実戦手'] = played[-1]
        if r.get('mate'):
            position['詰まされる側'] = label(1 - board.turn, perspective)
        if board.is_check() and board.is_game_over():
            position.update({'終局理由': '詰み', '勝った側': label(1 - board.turn, perspective), '負けた側': label(board.turn, perspective), '詰まされる側': label(board.turn, perspective), '確認済みの詰み': True})
        refs.append(position)
        for c in r['candidates']:
            if not c.get('pv'):
                continue
            copy = board.copy()
            prev, line = previous, []
            for usi in c['pv']:
                f, prev = move_fact(copy, usi, prev, perspective)
                line.append(f)
            refs.append({'id': f'{ply}:candidate:{c["rank"]}', '手数': ply, '候補順位': c['rank'], **evaluation(c['score'], perspective), '読み筋': line, '確認済みの詰み': False})
        if r.get('mate'):
            copy, prev, line = board.copy(), previous, []
            for usi in r['mate']['pv']:
                f, prev = move_fact(copy, usi, prev, perspective)
                line.append(f)
            refs.append({'id': f'{ply}:mate', '手数': ply, '読み筋': line, '確認済みの詰み': True, '詰ませる側': label(board.turn, perspective), '詰まされる側': label(1 - board.turn, perspective)})
        if ply < len(moves):
            f, previous = move_fact(board, moves[ply], previous, perspective)
            before, after = r['score'], results[ply + 1]['score']
            f['手数'] = ply + 1
            f['評価変化'] = '比較できない'
            f['印'] = '判定なし'
            if before and after and before['kind'] == after['kind'] == 'cp' and not before.get('bound') and not after.get('bound'):
                delta = after['value'] - before['value']
                view_delta = delta * (-1 if perspective == 'gote' else 1)
                f['評価変化'] = ('先手から見て' if perspective == 'observer' else 'あなたから見て') + ('改善' if view_delta > 0 else '悪化' if view_delta < 0 else '変化なし')
                loss = -delta if board.turn == 1 else delta
                f['印'] = '悪手' if loss >= 500 else '疑問手' if loss >= 200 else '判定なし'
            played.append(f)
    final = next(r for r in refs if r['id'] == f'{len(moves)}:position')
    outcome = {k: final[k] for k in ('終局理由', '勝った側', '負けた側') if k in final}
    if not outcome:
        outcome = {'終局理由': '不明', '勝敗': '不明', '注意': '投了・宣言などの終局記録は入力にない。探索や宣言可能という結果から実戦の勝敗を作らない。'}
    return {'視点': '観戦' if perspective == 'observer' else label(0, perspective) + 'が先手、' + label(1, perspective) + 'が後手', '実戦手': played, '終局': outcome, '参照': refs}
