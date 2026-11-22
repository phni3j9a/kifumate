type Direction = '前進' | '後退' | '横移動' | '打つ';
interface PositionSide { 玉: string | null; 盤上: Record<string, string[]>; 持駒: Record<string, number> }

// 生USIや評価の数値はこの型に入れない。表記・局面の確定はPython/cshogi側で行う。
export interface CoachFacts {
  視点: string;
  実戦手: [手数: number, 表記: string, 印: string, 形勢: string, 移動: Direction, ...注記: ('境界値' | '深読み')[]][];
  終局: Record<string, any>;
  参照: Record<string, any>[];
  要所?: (Record<string, any> & {実戦手: {表記: string}})[];
  仮の手順?: Record<string, any>[];
  詰みの別応手?: Record<string, Record<string, any>[][]>;
}

const ACTORS = 'あなた|相手|先手|後手';
const PIECES = '成香|成桂|成銀|と金|飛車|歩|香|桂|銀|金|角|飛|玉|王|と(?!いう)|馬|龍|竜';
const RANKS = '一二三四五六七八九';
const SQUARE = `[1-9${RANKS}][1-9${RANKS}]`;
const KIF_PIECES = PIECES.replace('と(?!いう)', `と(?!いう|${SQUARE})`);
const PV = '仮の読み筋（実戦とは別）';
const KIF = `([▲△☗☖]\\s*)?(${SQUARE}|同)\\s*(${KIF_PIECES})(不成|成|打)?(?:\\(([1-9]{2})\\))?`;
const USI = /(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])/;

function piece(s: string) {
  return s.replace('飛車', '飛').replace('と金', 'と').replace('竜', '龍').replace('王', '玉');
}
function squareNumber(s: string) {
  return s.replace(/[一二三四五六七八九]/g, c => String(RANKS.indexOf(c) + 1));
}
function notation(match: RegExpMatchArray) {
  const [, side, square, name, suffix] = match;
  return [side?.trim().replace('☗', '▲').replace('☖', '△') ?? '', squareNumber(square), piece(name), suffix ?? ''];
}
function matchesMove(m: RegExpMatchArray, source?: string) {
  const actual = source?.match(new RegExp(`^${KIF}$`));
  if (!actual) return false;
  const expected = notation(actual);
  // 省略できる「打」や補足の移動元は判定を左右しない。「打」と明記した移動手は別の手。
  return notation(m).every((part, i) => i === 0 && !part || i === 3 && !part && expected[i] === '打' || part === expected[i]);
}

export function lineOrigin(id: string, facts: CoachFacts): string | undefined {
  if (!/^\d+:line:[a-f0-9]+$/.test(id)) return undefined;
  const line = facts.仮の手順?.find(r => r.id === id && `${r.手数}:line:` === id.slice(0, id.lastIndexOf(':') + 1));
  return line ? `${line.手数}:position` : undefined;
}

function linesFor(facts: CoachFacts | undefined, ids: string[]) {
  return facts?.仮の手順?.filter(line => ids.some(id => {
    if (id === `${line.手数}:position` || id === `${line.手数}:deep:position`) return true;
    if (!id.startsWith(`${line.手数}:candidate:`) && !id.startsWith(`${line.手数}:deep:candidate:`)) return false;
    const candidate = facts.参照.find(r => r.id === id)?.[PV];
    // 同じ局面の別候補では足りない。少なくとも指し始めの分岐が同じことを確認する。
    return candidate?.length && line[PV]?.length && candidate[0].表記 === line[PV][0].表記;
  })) ?? [];
}

function variations(facts: CoachFacts | undefined, ids: string[]) {
  if (!facts) return [];
  const shown = facts.参照.filter(r => /^(\d+)(?::deep)?:(?:mate|candidate:\d+)$/.test(r.id) &&
    (ids.includes(r.id) || ids.includes(r.id.replace(/:(?:mate|candidate:\d+)$/, ':position'))));
  return [
    ...shown.flatMap(r => [...(r[PV] ?? []), ...(facts.詰みの別応手?.[r.id] ?? []).flat()]),
    ...linesFor(facts, ids).flatMap(r => r[PV] ?? []),
  ];
}

export function notationIssue(text: string, facts?: CoachFacts, kind: 'facts' | 'advice' = 'facts', ids: string[] = []): string | undefined {
  text = text.normalize('NFKC');
  if (USI.test(text)) return 'usi';
  if (/[+−‒–-]\s*[0-9一二三四五六七八九十百千万]/.test(text) || /評価値\s*(?:は|が|[:=])?\s*[0-9]/.test(text)) return 'numeric_evaluation';
  const played = facts?.実戦手 ?? [];
  if (kind === 'facts') {
    const proven = [...played.map(r => r[1]), ...variations(facts, ids).map(m => m.表記)];
    const move = new RegExp(KIF, 'g');
    for (const mention of text.matchAll(move)) {
      if (!proven.some(source => matchesMove(mention, source))) return 'unknown_move';
    }
    if (/[▲△☗☖]/.test(text.replace(move, ''))) return 'unknown_move';
  }
  for (const mention of text.matchAll(/([0-9]+)\s*手目/g)) {
    const [, n] = mention;
    const suffix = text.slice(mention.index! + mention[0].length);
    const ply = Number(n);
    if (ply > played.length) return 'ply_out_of_range';
    const attached = suffix.match(new RegExp(`^\\s*(?:の|[:(])?\\s*${KIF}`));
    if (attached && !matchesMove(attached, played[ply - 1]?.[1])) return 'move_does_not_match_ply';
  }
}

function compactPosition(id: string, facts: CoachFacts): Record<string, any> | undefined {
  const n = /^(\d+)(:deep)?:position$/.exec(id);
  const row = n ? facts.実戦手[Number(n[1]) - 1] : undefined;
  if (!row) return undefined;
  const [, kif, , state, , ...notes] = row;
  const deep = notes.includes('深読み');
  if (n?.[2] && !deep) return undefined;
  const sender = kif.startsWith('▲') ? '先手' : '後手';
  const actor = facts.視点 === '観戦' ? sender : facts.視点.includes(`あなたが${sender}`) ? 'あなた' : '相手';
  const position = {id, 直前の実戦手: {指した側: actor, 動いた駒: kif.match(new RegExp(KIF))?.[3] ?? ''}};
  if (deep && !n?.[2]) return position; // 盤面は共通だが、一覧の形勢は深読みの参照にだけ使う。
  const explicit = new RegExp(`^(${ACTORS})が`).exec(state)?.[1];
  const favored = explicit ?? (/不利|敗勢/.test(state) ? '相手' : /有利|勝勢/.test(state) ? 'あなた' : 'なし');
  const other = ({あなた: '相手', 相手: 'あなた', 先手: '後手', 後手: '先手'} as Record<string, string>)[favored];
  return {...position, 優勢な側: favored, 宣言できる側: state.includes('宣言可能') ? favored : undefined,
    詰まされる側: state.includes('が詰ませる方向') ? other : undefined};
}

export function hasFactReference(id: string, facts: CoachFacts): boolean {
  return facts.参照.some(r => r.id === id) || !!compactPosition(id, facts);
}

const OWNER_FIRST = new RegExp(`(${ACTORS})(?:の)?(${PIECES})(?:は|が|も)?\\s*(${SQUARE})(?=$|[\\s・。）、，]|です|でした|に(?:い|あ|位置))`, 'g');
const SQUARE_FIRST = new RegExp(`(${SQUARE})\\s*の\\s*(${ACTORS})(?:の)?(${PIECES})`, 'g');

function contradictsPosition(clause: string, refs: Record<string, any>[], facts: CoachFacts) {
  // shortcut: 現在位置の明示だけを照合。前後・候補・時間の混ざる文まで扱うには時系列の解析が必要。
  if (/取|交換|打[つちっ]|進[むみめ]|移動|逃げ|動[くかきい]|[前後]に|これから|予想|想定|練習|読み筋|候補/.test(clause)) return false;
  const boards: Record<string, PositionSide>[] = refs.flatMap(r => r['局面'] ?? []);
  if (!boards.length) return false;
  const claims = [...Array.from(clause.matchAll(OWNER_FIRST), m => [m[1], m[2], m[3]]),
    ...Array.from(clause.matchAll(SQUARE_FIRST), m => [m[2], m[3], m[1]])];
  return claims.some(([side, name, square]) => {
    name = piece(name);
    const actor = facts.視点 !== '観戦' && ['先手', '後手'].includes(side)
      ? facts.視点.includes(`あなたが${side}`) ? 'あなた' : '相手' : side;
    return boards.every(board => {
      const position = board[actor];
      if (!position) return false;
      const occupied = name === '玉' ? [position.玉] : position.盤上[name] ?? [];
      return !occupied.some(sq => sq && squareNumber(sq) === squareNumber(square));
    });
  });
}

function contradictsDirection(clause: string, refs: Record<string, any>[], facts: CoachFacts) {
  const withVerb = new RegExp(`${KIF}\\s*と\\s*(引[いきく]|上が|上げ|前進|後退|横移動)`, 'g');
  if (!withVerb.test(clause)) return false;
  withVerb.lastIndex = 0;
  const moves: (readonly [string, Direction | undefined])[] = [...facts.実戦手.map(r => [r[1], r[4]] as const),
    ...variations(facts, refs.map(r => r.id)).map((m): [string, Direction | undefined] => [m.表記, m.移動])];
  for (const m of clause.matchAll(withVerb)) {
    if (!m[1]) continue;
    const expected = /^(引|後退)/.test(m[6]) ? '後退' : m[6] === '横移動' ? '横移動' : '前進';
    const matched = moves.filter(([kif]) => matchesMove(m, kif));
    if (matched.length && matched.every(([, direction]) => direction && direction !== expected)) return true;
  }
  return false;
}

export function contradicts(text: string, selected: string[], facts: CoachFacts): boolean {
  if (facts.視点 === '観戦' && /あなた/.test(text)) return true;
  const refs = selected.flatMap(id => facts.参照.find(r => r.id === id) ?? compactPosition(id, facts) ?? []);
  for (const clause of text.split(/[。！？\n、]/)) {
    // shortcut: 明示的な主語と断定だけを検査。省略・比喩まで扱うには別の評価器が必要。
    // 否定・仮定・目的を含む文は安全側に許可し、確かな断定だけを照合する。
    if (/ない|なく|なかった|ません|なら|たら|れば|せば|けば|てば|場合|仮に|仮定|もし|かもしれ|でしょう|だろう|ように|ために/.test(clause)) continue;
    if (contradictsPosition(clause.normalize('NFKC'), refs, facts) || contradictsDirection(clause.normalize('NFKC'), refs, facts)) return true;
    const subjects = [...clause.matchAll(new RegExp(`(${ACTORS})(?:側|の側)?(?:が|は|に)`, 'g'))];
    for (const [i, match] of subjects.entries()) {
      const actor = match[1];
      const rest = clause.slice(match.index + match[0].length, subjects[i + 1]?.index).trim();
      if (/^(?:先手|後手)(?:です|でした)$/.test(rest) && !facts.視点.includes(actor + 'が' + rest.slice(0, 2))) return true;
      if (/(?:勝ちました|勝ち切りました|勝利しました|宣言勝ちです|宣言勝ちでした)$/.test(rest) && facts.終局['勝った側'] !== actor) return true;
      if (/(?:負けました|敗れました)$/.test(rest) && facts.終局['負けた側'] !== actor) return true;
      const declaration = /(?:入玉|勝利)?宣言(?:が)?(?:可能(?:です|でした)|(?:でき|出来)(?:ます|ました))$/.test(rest);
      const favored = /(?:(?:やや|大きく)?(?:有利|優勢|優位|勝勢)(?:です|でした|になりました|となりました)|リード(?:しています|していました))$/.test(rest);
      const mated = /(?:詰まされ(?:ました|る側です)|詰む側です)$/.test(rest);
      const key = declaration ? '宣言できる側' : mated ? '詰まされる側' : favored ? '優勢な側' : null;
      if (key && refs.length && !refs.some(r => r[key] === actor)) return true;
      const mentioned = new RegExp(`^(?:その|この)?(?:の)?(${PIECES})(?:を(?:動かしました|進めました|引きました|上がりました)|で(?:取りました|取った手です))$`).exec(rest);
      if (mentioned && refs.length) {
        const moves = refs.flatMap(r => r[PV] ?? (r['直前の実戦手'] ? [r['直前の実戦手']] : []));
        if (moves.length && !moves.some(m => m['指した側'] === actor && piece(m['動いた駒']) === piece(mentioned[1]))) return true;
      }
    }
  }
  return false;
}

export function rememberToolEvidence(facts: CoachFacts, name: string, args: Record<string, any>, result: Record<string, any>) {
  if ('エラー' in result) return;
  const save = (ref: Record<string, any>) => {
    const known = facts.参照.find(r => r.id === ref.id);
    if (known) facts.参照[facts.参照.indexOf(known)] = {...known, ...ref};
    else facts.参照.push(ref);
  };
  if (name === 'saved_analysis' && Array.isArray(result['候補と詰み証明'])) {
    const {候補と詰み証明, ...position} = result;
    save(position);
    for (const ref of 候補と詰み証明) save(ref);
  }
  if (name === 'position' && !args.position?.moves?.length && result.盤面) {
    const id = result['本譜の参照'];
    const ref = facts.参照.find(r => r.id === id) ?? compactPosition(id, facts);
    if (ref) save({...ref, 局面: result.盤面});
  }
  if (name === 'play_line' && result.参照) (facts.仮の手順 ??= []).push(result.参照);
  if (name === 'book') {
    const saveMoves = (id: unknown, moves: unknown[]) => {
      const origin = typeof id === 'string' && /^(\d+):position$/.exec(id);
      if (!origin || !hasFactReference(origin[0], facts)) return;
      // 本の選択肢は連続した手順ではなく、起点が同じ別々の候補。
      for (const 表記 of moves) if (typeof 表記 === 'string') {
        (facts.仮の手順 ??= []).push({手数: Number(origin[1]), [PV]: [{表記}]});
      }
    };
    const first = result.最初に外れた手;
    if (Array.isArray(first?.本の手)) saveMoves(first.参照, first.本の手);
    if (Array.isArray(result.手筋)) for (const item of result.手筋) saveMoves(item?.参照, [item?.正解]);
  }
  if (name === 'mate' && result.状態 === '詰みを証明' && Number.isInteger(args.position?.ply) && Array.isArray(result.手順)) {
    const moves: string[] = [...(result.分岐 ?? []), ...result.手順];
    (facts.仮の手順 ??= []).push({手数: args.position.ply, [PV]: moves.map(表記 => ({表記}))});
  }
}
