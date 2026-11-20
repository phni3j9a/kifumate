# SPDX-License-Identifier: GPL-3.0-only
"""盤面の質問を、保存済み解析と cshogi だけで解く。"""
from collections import Counter
import hashlib
import json
import re
import unicodedata

import cshogi as sh

from coach_facts import RANKS, build_facts, evaluation, label, move_fact, piece_name, position_fact
from coach_knowledge import lookup

PIECES = tuple(map(piece_name, sh.PIECE_JAPANESE_SYMBOLS))
ALIASES = {'飛車': '飛', '角行': '角', '王': '玉', '竜': '龍', 'と金': 'と', '杏': '成香', '圭': '成桂', '全': '成銀'}
USI = re.compile(r'(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])')
KIF = re.compile(r'([▲△☗☖])?([1-9一二三四五六七八九]{2}|同)(' + '|'.join(sorted(set(PIECES[1:]) | ALIASES.keys(), key=lambda s: (-len(s), s))) + r')([右左直上引寄]*)(不成|成|打)?(?:\(([1-9]{2})\))?')
DIGITS = str.maketrans(RANKS, '123456789')


class ToolError(ValueError):
    def __init__(self, message, **details):
        self.result = {'エラー': message, **details}
        super().__init__(message)


def sq_name(s):
    return str(s // 9 + 1) + RANKS[s % 9]


def square(s):
    if not isinstance(s, str) or not re.fullmatch('[1-9]{2}', n := unicodedata.normalize('NFKC', s).translate(DIGITS)):
        raise ToolError('升は「2四」のように指定してください')
    return (int(n[0]) - 1) * 9 + int(n[1]) - 1


def move_details(b, move, prev, view):
    to = sh.move_to(move)
    origin = None if sh.move_is_drop(move) else sq_name(sh.move_from(move))
    f, _ = move_fact(b, sh.move_to_usi(move), prev, view)
    return {**f, '移動元': origin, '移動先': sq_name(to), '成った': sh.move_is_promotion(move), '王手': b.is_check()}


def resolve(b, notation, prev=None):
    s = re.sub(r'\s+', '', unicodedata.normalize('NFKC', notation))
    if USI.fullmatch(s):
        move = b.move_from_usi(s)
        if move and b.is_legal(move):
            return move
        candidates = []
    elif (m := KIF.fullmatch(s)):
        sign, dest, name, direction, suffix, origin = m.groups()
        name = ALIASES.get(name, name)
        to = (sh.move_to(prev) if prev is not None else None) if dest == '同' else square(dest)
        candidates, matching = [], []
        for mv in b.legal_moves:
            if sh.move_to(mv) != to:
                continue
            drop = sh.move_is_drop(mv)
            typ = sh.HAND_PIECE_JAPANESE_SYMBOLS[sh.move_drop_hand_piece(mv)] if drop else PIECES[sh.move_from_piece_type(mv)]
            if typ != name:
                continue
            candidates.append(mv)
            if sign and (sign in '▲☗') != (b.turn == sh.BLACK):
                continue
            if (suffix == '成') != sh.move_is_promotion(mv) or suffix == '打' and not drop:
                continue
            if drop and (direction or origin or suffix == '不成'):
                continue
            if not drop:
                fr = sh.move_from(mv)
                if origin and square(origin) != fr:
                    continue
                side = 1 if b.turn == sh.BLACK else -1
                dx, dy = (fr // 9 - to // 9) * side, (fr % 9 - to % 9) * side
                # 右左は候補駒同士で比べる（特に馬・龍では複数候補が同じ側にある）。
                if any(d not in ('右', '左') and not {'直': dx == 0 and dy == 1, '上': dy > 0, '引': dy < 0, '寄': dy == 0}[d] for d in direction):
                    continue
                if suffix == '不成' and (sh.move_from_piece_type(mv) not in range(1, 7) or not any(r <= 2 if side == 1 else r >= 6 for r in (fr % 9, to % 9))):
                    continue
            matching.append(mv)
        for d in ('右', '左'):
            if d in direction and matching:
                key = lambda mv: (sh.move_from(mv) // 9) * (1 if b.turn == sh.BLACK else -1)
                # 金銀等では移動先との位置関係、馬龍では移動元候補の左右で区別する。
                if name in ('馬', '龍') and len(matching) > 1:
                    end = (min if d == '右' else max)(map(key, matching))
                    matching = [mv for mv in matching if key(mv) == end]
                else:
                    target = (to // 9) * (1 if b.turn == sh.BLACK else -1)
                    matching = [mv for mv in matching if (key(mv) < target if d == '右' else key(mv) > target)]
        if len(matching) == 1:
            return matching[0]
        if matching:
            raise ToolError('指し手が一意に決まりません。移動元または打を指定してください', 候補=[move_details(b.copy(), mv, prev, 'observer')['表記'] for mv in matching])
    else:
        candidates = []
    raise ToolError('不正な指し手です', 候補=[move_details(b.copy(), mv, prev, 'observer')['表記'] for mv in candidates])


GOLD = ((-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (0, 1))
ORTH = ((0, -1), (1, 0), (0, 1), (-1, 0))
DIAG = ((-1, -1), (1, -1), (-1, 1), (1, 1))
STEPS = {1: ((0, -1),), 3: ((-1, -2), (1, -2)), 4: ((0, -1), *DIAG), 7: GOLD,
         8: ORTH + DIAG, **dict.fromkeys(range(9, 13), GOLD), 13: ORTH, 14: DIAG}
RAYS = {2: ((0, -1),), 5: DIAG, 6: ORTH, 13: DIAG, 14: ORTH}


def attacks(b, fr):
    p = b.piece(fr)
    if not p:
        return set()
    typ, forward = p & 15, -1 if p >> 4 else 1
    x, y = divmod(fr, 9)
    targets = set()
    for slide, directions in ((False, STEPS.get(typ, ())), (True, RAYS.get(typ, ()))):
        for dx, dy in directions:
            nx, ny = x + dx, y + dy * forward
            while 0 <= nx < 9 and 0 <= ny < 9:
                to = nx * 9 + ny
                targets.add(to)
                if not slide or b.piece(to):
                    break
                nx, ny = nx + dx, ny + dy * forward
    return targets


def occupants(b, view, s):
    p = b.piece(s)
    return {'升': sq_name(s), '側': label(p >> 4, view), '駒': PIECES[p & 15]} if p else None


def attack_map(b):
    result = [[[], []] for _ in range(81)]
    for fr in range(81):
        if p := b.piece(fr):
            for to in attacks(b, fr):
                result[to][p >> 4].append(fr)
    return result


def attackers(b, view, attack, s):
    return {label(side, view): [occupants(b, view, fr) for fr in sources] for side, sources in enumerate(attack[s])}


def summary(b, view):
    sides = position_fact(b, view)
    return {'手番': label(b.turn, view), '王手されている': b.is_check(), '両玉': {k: v['玉'] for k, v in sides.items()}, '持駒': {k: v['持駒'] for k, v in sides.items()}}


def safety(b, prev, view):
    attack = attack_map(b)
    out = {}
    for side in (0, 1):
        k = next((s for s in range(81) if b.piece(s) == (side << 4) + 8), None)
        if k is None:
            continue
        x, y = divmod(k, 9)
        ring = [s for s in range(81) if s != k and abs(s // 9 - x) <= 1 and abs(s % 9 - y) <= 1]
        out[label(side, view)] = {'玉': sq_name(k), '周囲': [{'升': sq_name(s), '駒': occupants(b, view, s), '利き': attackers(b, view, attack, s)} for s in ring]}
        if side == b.turn:
            out[label(side, view)]['合法な玉の移動先'] = [sq_name(sh.move_to(mv)) for mv in b.legal_moves if not sh.move_is_drop(mv) and sh.move_from(mv) == k]
    out['手番側が掛けられる王手'] = [f['表記'] for mv in b.legal_moves if (f := move_details(b.copy(), mv, prev, view))['王手']][:40]
    return out


def threats(b, view):
    attack = attack_map(b)
    return [{'対象': occupants(b, view, s), '相手の利き': attackers(b, view, attack, s)[label(1 - (b.piece(s) >> 4), view)],
             '味方の利き': attackers(b, view, attack, s)[label(b.piece(s) >> 4, view)]} for s in range(81) if b.piece(s)]


def sequence(b, prev, view, moves):
    if not isinstance(moves, list) or len(moves) > 16:
        raise ToolError('分岐または手順は16手まで')
    line = []
    for s in moves:
        if not isinstance(s, str) or len(s) > 40:
            raise ToolError('指し手はKIFの文字列で指定してください')
        mv = resolve(b, s, prev)
        f = move_details(b, mv, prev, view)
        prev = mv
        line.append({**f, '直後': summary(b, view)})
    return line, prev


def mate(b, prev, view):
    if b.is_check() and not any(b.legal_moves):
        return {'状態': '既に詰み', '詰まされる側': label(b.turn, view), '手順': []}
    dfpn = sh.DfPn()
    dfpn.set_max_search_node(10000)
    dfpn.set_max_depth(15)
    if not dfpn.search(b):
        return {'状態': '未確認', '探索ノード': dfpn.searched_node, '注意': '詰まないことを証明したわけではない'}
    return {'状態': '詰みを証明', '詰まされる側': label(1 - b.turn, view), '探索ノード': dfpn.searched_node,
            '手順': [f['表記'] for f in sequence(b.copy(), prev, view, list(map(sh.move_to_usi, dfpn.get_pv(b)))[:16])[0]]}


def at(game, pos):
    ply, branch = pos['ply'], pos.get('moves', [])
    if type(ply) is not int or not 0 <= ply <= len(game['moves']):
        raise ToolError('本譜の範囲内の手数を指定してください')
    b = sh.Board() if game['initial'] == 'startpos' else sh.Board(game['initial'])
    prev = None
    for s in game['moves'][:ply]:
        prev = b.move_from_usi(s)
        if not prev or not b.is_legal(prev):
            raise ToolError('本譜に不正な指し手があります')
        b.push(prev)
    line, prev = sequence(b, prev, game['perspective'], branch)
    return b, prev, ply, line


def light_keys(facts):
    return [{k: (v['表記'] if k == '実戦手' else v) for k, v in key.items() if k != '実戦の続き'} for key in facts['要所']]


def capture_totals(line):
    gains = {}
    for f in line:
        if f['取った駒'] != 'なし':
            gains.setdefault(f['指した側'], Counter())[f['取った駒']] += 1
    return gains


def ref_line(ply, line):
    moves = [{k: v for k, v in f.items() if k != '直後'} for f in line]
    tag = hashlib.sha256(json.dumps(moves, ensure_ascii=False).encode()).hexdigest()[:12]
    return {'id': f'{ply}:line:{tag}', '手数': ply, '仮の読み筋（実戦とは別）': moves}


def saved(game, b, prev, ply, facts, limit):
    r = game['results'][ply]
    view = game['perspective']
    sources = [*[(f'{ply}:candidate:{c["rank"]}', c, False) for c in r['candidates'][:limit] if c.get('pv')],
               *([(f'{ply}:mate', r['mate'], True)] if r.get('mate') else [])]
    refs = []
    for id_, source, proven in sources:
        line, _ = sequence(b.copy(), prev, view, source['pv'][:5])
        refs.append({'id': id_, '手数': ply, '仮の読み筋（実戦とは別）': [{k: v for k, v in f.items() if k != '直後'} for f in line],
                     '取る駒': capture_totals(line), '確認済みの詰み': proven,
                     **({'詰まされる側': label(1 - b.turn, view)} if proven else evaluation(source['score'], view))})
    position = {'id': f'{ply}:position', **evaluation(r['score'], view), '確認済みの詰み': bool(r.get('mate'))}
    position.update(next((p for p in facts['参照'] if p['id'] == position['id']), {}))
    position.pop('局面', None)
    return {**position, '指した直前の手の印': facts['実戦手'][ply - 1][2] if ply else 'なし', '候補と詰み証明': refs}


def actual_claim(game, claim, facts):
    kind = claim['type']
    if kind == 'winner':
        return facts['終局'].get('勝った側', '不明')
    b, prev, ply, branch = at(game, claim['position'])
    view = game['perspective']
    if kind == 'piece':
        p = occupants(b, view, square(claim['square']))
        return {k: v for k, v in p.items() if k != '升'} if p else None
    if kind == 'attack':
        return square(claim['to']) in attacks(b, square(claim['from']))
    if kind == 'move':
        return move_details(b, resolve(b, claim['move'], prev), prev, view)[claim['field']]
    if kind == 'captures':
        return capture_totals(sequence(b, prev, view, claim['moves'])[0])
    if kind == 'mate':
        return mate(b, prev, view)['状態']
    if kind == 'evaluation':
        return evaluation(game['results'][ply]['score'], view)['優勢な側'] if not branch else '不明'
    raise ToolError('不明な主張の型です')


def compare(b, prev, view, moves):
    before = threats(b, view)
    relation = lambda rows, key: {(p['対象']['側'], p['対象']['升'], p['対象']['駒'], a['駒'], a['升']) for p in rows for a in p[key]}
    initial_attack, initial_defense = (relation(before, k) for k in ('相手の利き', '味方の利き'))
    variants = []
    for s in moves:
        after = b.copy()
        line, move = sequence(after, prev, view, [s])
        after_threats = threats(after, view)
        new_attacks = relation(after_threats, '相手の利き') - initial_attack
        lost_defense = initial_defense - relation(after_threats, '味方の利き')
        f = line[0]
        # 利きの候補。取り切れるかは合法手や手順で別途確認する。
        fork = sorted((t, p) for side, t, p, _, fr in new_attacks if side != f['指した側'] and fr == f['移動先'])
        variants.append({'手': f, '新しい当たり（対象側・升・駒／攻め駒・升）': sorted(new_attacks),
                         '外れた守り（対象側・升・駒／守り駒・升）': sorted(lost_defense), '両取り候補': fork if len(fork) >= 2 else [],
                         '直後の玉の安全度': safety(after, move, view)})
    return {'指す前の玉の安全度': safety(b, prev, view), '比較': variants}


def call(game, name, args, *, facts=None, draft=None):
    """入力を変更せずJSON値を返す。下書きだけは呼び出し側がTS照合を注入。"""
    try:
        if name == 'knowledge':
            return {'知識': lookup(args['query'])}
        if name == 'game_tags':
            return {'盤面からの分類（未分類は不明）': game.get('tags') or '未分類'}
        if name == 'check_draft':
            if draft is None:
                raise ToolError('TS照合が未接続です')
            return draft(args['draft'])
        view = game['perspective']
        if name in ('keypoints', 'played', 'saved_analysis', 'check_claims') and facts is None:
            facts = build_facts(game)
        if name == 'keypoints':
            return {'要所': light_keys(facts)}
        if name == 'played':
            start, end = args.get('start', 1), args.get('end', len(game['moves']))
            if type(start) is not int or type(end) is not int or start < 1:
                raise ToolError('手数は整数（開始は1以上）で指定してください')
            stop = min(end, start + 29)
            return {'実戦手（手数・符号・印・直後の形勢・移動）': facts['実戦手'][start - 1:stop], **({'次の開始手数': stop + 1} if stop < min(end, len(game['moves'])) else {})}
        if name == 'check_claims':
            result = []
            for c in args['claims'][:8]:
                try:
                    actual = actual_claim(game, c, facts)
                    result.append({'一致': actual == c['expected'], '正しい値': actual})
                except ToolError as e:
                    result.append(e.result)
                except (ValueError, KeyError, TypeError):
                    result.append({'エラー': '主張の引数が不正です'})
            return {'照合': result}
        b, prev, ply, branch = at(game, args['position'])
        if name == 'position':
            return {**summary(b, view), '盤面': position_fact(b, view), '本譜の参照': f'{ply}:position', **({'分岐': [f['表記'] for f in branch]} if branch else {})}
        if name == 'square':
            s = square(args['square'])
            return {'升': sq_name(s), '駒': occupants(b, view, s), '利き（ピンを含む幾何的な利き）': attackers(b, view, attack_map(b), s)}
        if name == 'piece_attacks':
            s = square(args['square'])
            return {'駒': occupants(b, view, s), '利き先（味方駒の升を含む）': [sq_name(t) for t in sorted(attacks(b, s))]}
        if name == 'threats':
            rows = threats(b, view)
            return {'相手の利きがある駒': [p for p in rows if p['相手の利き']], '味方の利きがない駒': [p['対象'] for p in rows if not p['味方の利き']]}
        if name == 'king_safety':
            return safety(b, prev, view)
        if name == 'legal_moves':
            found = []
            for m in b.legal_moves:
                f = move_details(b.copy(), m, prev, view)
                if ('piece' not in args or ALIASES.get(args['piece'], args['piece']) == f['動いた駒']) and ('check' not in args or args['check'] == f['王手']) and ('capture' not in args or args['capture'] == (f['取った駒'] != 'なし')):
                    found.append(f['表記'])
            offset = args.get('offset', 0)
            if type(offset) is not int or offset < 0:
                raise ToolError('offset は0以上の整数です')
            return {'合法手': found[offset:offset + 40], '全件数': len(found)}
        if name in ('play_line', 'material'):
            line, _ = sequence(b, prev, view, args.get('moves', []))
            totals = capture_totals(line)
            if name == 'play_line':
                return {'手順': line, '取った駒の内訳': totals, '参照': ref_line(ply, branch + line)}
            return {'取った駒の内訳': totals, '直後の盤上と持駒': position_fact(b, view)}
        if name == 'compare_moves':
            choices = [args['move']] + ([args['alternative']] if args.get('alternative') else [])
            return compare(b, prev, view, choices)
        if name == 'mate':
            return mate(b, prev, view)
        if name == 'saved_analysis':
            if branch:
                raise ToolError('仮の分岐には保存済み解析がありません')
            return saved(game, b, prev, ply, facts, max(1, min(5, args.get('limit', 2))))
        return {'エラー': '不明な道具です'}
    except ToolError as e:
        return e.result
    except (ValueError, KeyError, TypeError, AttributeError, IndexError):
        return {'エラー': '引数または資料が不正です'}
