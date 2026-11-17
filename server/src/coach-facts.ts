// 数値やUSIはこの型に入れない。表記・局面の確定はPython/cshogi側で行う。
export interface CoachFacts {
  視点: string;
  実戦手: Record<string, any>[];
  終局: Record<string, any>;
  参照: Record<string, any>[];
}

export function contradicts(text: string, selected: string[], facts: CoachFacts): boolean {
  if (facts.視点 === '観戦' && /あなた/.test(text)) return true;
  const refs = facts.参照.filter(r => selected.includes(r.id));
  const actors = 'あなた|相手|先手|後手';
  for (const clause of text.split(/[。！？\n、]/)) {
    // shortcut: 明示的な主語と断定だけを検査。省略・比喩まで扱うには別の評価器が必要。
    for (const match of clause.matchAll(new RegExp(`(${actors})(?:側|の側)?(?:が|は|に)([^。！？]{0,45})`, 'g'))) {
      const [, actor, rest] = match;
      if (/^(?:先手|後手)(?:です|でした)/.test(rest) && !facts.視点.includes(actor + 'が' + rest.slice(0, 2))) return true;
      if (/(?:勝ちました|勝ち切りました|勝利しました|宣言勝ちです|宣言勝ちでした)/.test(rest) && facts.終局['勝った側'] !== actor) return true;
      if (/(?:負けました|敗れました)/.test(rest) && facts.終局['負けた側'] !== actor) return true;
      const declaration = /(?:入玉|勝利)?宣言(?:が)?(?:可能|でき|出来)/.test(rest);
      const favored = /(?:やや|大きく)?(?:有利|優勢|優位|勝勢|リード)(?:です|でした|に|を|と|な|で|が|に立)/.test(rest);
      const mated = /(?:詰まされ|詰む側|詰まされる側)/.test(rest);
      const key = declaration ? '宣言できる側' : mated ? '詰まされる側' : favored ? '優勢な側' : null;
      if (key && refs.length && !refs.some(r => r[key] === actor)) return true;
      const piece = /(?:の)?(成香|成桂|成銀|歩|香|桂|銀|金|角|飛車|飛|玉|王|と金|と|馬|龍|竜)(?:を動か|を進め|を引|を上が|で取り|で取っ)/.exec(rest);
      if (piece && refs.length) {
        const normalize = (s: string) => s.replace('飛車', '飛').replace('と金', 'と').replace('竜', '龍').replace('王', '玉');
        const moves = refs.flatMap(r => r['読み筋'] ?? (r['直前の実戦手'] ? [r['直前の実戦手']] : []));
        if (moves.length && !moves.some(m => m['指した側'] === actor && normalize(m['動いた駒']) === normalize(piece[1]))) return true;
      }
    }
  }
  return false;
}
