// 生USIや評価の数値はこの型に入れない。表記・局面の確定はPython/cshogi側で行う。
export interface CoachFacts {
  視点: string;
  実戦手: [手数: number, 表記: string, 印: string, 形勢: string, 境界値?: string][];
  終局: Record<string, any>;
  参照: Record<string, any>[];
}

const ACTORS = 'あなた|相手|先手|後手';
const PIECES = '成香|成桂|成銀|と金|飛車|歩|香|桂|銀|金|角|飛|玉|王|と(?!いう)|馬|龍|竜';
const RANKS = '一二三四五六七八九';
const KIF = `([▲△☗☖]\\s*)?([1-9${RANKS}][1-9${RANKS}]|同)\\s*(${PIECES})(不成|成|打)?(?:\\(([1-9]{2})\\))?`;
const USI = /(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])/;

function piece(s: string) {
  return s.replace('飛車', '飛').replace('と金', 'と').replace('竜', '龍').replace('王', '玉');
}
function notation(match: RegExpMatchArray) {
  const [, side, square, name, suffix, origin] = match;
  return [side?.trim().replace('☗', '▲').replace('☖', '△') ?? '',
    square.replace(/[一二三四五六七八九]/g, c => String(RANKS.indexOf(c) + 1)), piece(name), suffix ?? '', origin ?? ''];
}
function matchesMove(m: RegExpMatchArray, source?: string) {
  const actual = source?.match(new RegExp(`^${KIF}$`));
  if (!actual) return false;
  const expected = notation(actual);
  return notation(m).every((part, i) => ((i === 0 || i === 4) && !part) || part === expected[i]);
}

export function notationIssue(text: string, facts?: CoachFacts, kind: 'facts' | 'advice' = 'facts'): string | undefined {
  text = text.normalize('NFKC');
  if (USI.test(text)) return 'usi';
  if (/[+−‒–—-]\s*[0-9一二三四五六七八九十百千万]/.test(text) || /評価値\s*(?:は|が|[:=])?\s*[0-9]/.test(text)) return 'numeric_evaluation';
  const played = facts?.実戦手 ?? [];
  if (kind === 'facts') {
    const proven = [...played.map(r => r[1]), ...(facts?.参照.flatMap(r => (r['読み筋'] ?? []).map((m: any) => m['表記'])) ?? [])];
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
  const n = /^(\d+):position$/.exec(id);
  const row = n ? facts.実戦手[Number(n[1]) - 1] : undefined;
  if (!row) return undefined;
  const [, kif, , state] = row;
  const sender = kif.startsWith('▲') ? '先手' : '後手';
  const actor = facts.視点 === '観戦' ? sender : facts.視点.includes(`あなたが${sender}`) ? 'あなた' : '相手';
  const explicit = new RegExp(`^(${ACTORS})が`).exec(state)?.[1];
  const favored = explicit ?? (/不利|敗勢/.test(state) ? '相手' : /有利|勝勢/.test(state) ? 'あなた' : 'なし');
  const other = ({あなた: '相手', 相手: 'あなた', 先手: '後手', 後手: '先手'} as Record<string, string>)[favored];
  return {id, 優勢な側: favored, 宣言できる側: state.includes('宣言可能') ? favored : undefined,
    詰まされる側: state.includes('が詰ませる方向') ? other : undefined,
    直前の実戦手: {指した側: actor, 動いた駒: kif.match(new RegExp(KIF))?.[3] ?? ''}};
}

export function hasFactReference(id: string, facts: CoachFacts): boolean {
  return facts.参照.some(r => r.id === id) || /^(\d+):position$/.test(id) && !!facts.実戦手[Number(id.split(':')[0]) - 1];
}

export function contradicts(text: string, selected: string[], facts: CoachFacts): boolean {
  if (facts.視点 === '観戦' && /あなた/.test(text)) return true;
  const refs = selected.flatMap(id => facts.参照.find(r => r.id === id) ?? compactPosition(id, facts) ?? []);
  for (const clause of text.split(/[。！？\n、]/)) {
    // shortcut: 明示的な主語と断定だけを検査。省略・比喩まで扱うには別の評価器が必要。
    // 否定・仮定・目的を含む文は安全側に許可し、確かな断定だけを照合する。
    if (/ない|なく|なかった|ません|なら|たら|れば|せば|けば|てば|場合|仮に|仮定|もし|かもしれ|でしょう|だろう|ように|ために/.test(clause)) continue;
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
        const moves = refs.flatMap(r => r['読み筋'] ?? (r['直前の実戦手'] ? [r['直前の実戦手']] : []));
        if (moves.length && !moves.some(m => m['指した側'] === actor && piece(m['動いた駒']) === piece(mentioned[1]))) return true;
      }
    }
  }
  return false;
}
