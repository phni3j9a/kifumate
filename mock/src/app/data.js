/* ---------- app data: everything here is made up for the mock ---------- */
const TODAY = '2026-11-16';
/* mascot images (assets/mascot), embedded by the build as name → data URI */
const IMG = /*__IMAGES__*/{};
const pic = (name, cls, alt) => `<img class="${cls}" src="${IMG[name] || ''}" alt="${alt || ''}" draggable="false">`;
/* strategies grouped by the two big families; castles with the ones they grow out of */
const ST_MASTER = {
  '居飛車': ['矢倉', '角換わり', '相掛かり', '横歩取り', '雁木', '棒銀', '右四間飛車', '対四間飛車急戦', '対振り持久戦'],
  '振り飛車': ['四間飛車', '三間飛車', '中飛車', '向かい飛車', '相振り飛車'],
};
const CS_MASTER = ['美濃囲い', '高美濃', '銀冠', '舟囲い', 'エルモ囲い', '金矢倉', '雁木囲い', '左美濃', '居飛車穴熊', '振り飛車穴熊', '中住まい'];
const CS_PARENT = { '高美濃': '美濃囲い', '銀冠': '高美濃' };
const PRACTICE = ['四間飛車', '三間飛車', '中飛車', '向かい飛車', '相振り飛車', '矢倉', '角換わり', '相掛かり', '横歩取り', '雁木', '棒銀', '右四間飛車'];
const FOCUS = ['総合', '序盤の駒組み', '中盤の攻防', '終盤', '悪手・改善点'];
const DETAIL = ['かんたん', 'ふつう', 'くわしく'];

const DB = { plan: 'paid', first: false, celebrated: true, online: true, names: [], usage: {}, profile: {}, style: {}, games: [] };
/* limits: free 30 analyses a week; paid 30 precise a week and 60 analyses a week in all (precise included); real-time 300 minutes */
const usageInUse = () => ({ free: 12, freeMax: 30, precise: 12, preciseMax: 30, total: 26, totalMax: 60, rt: 48, rtMax: 300 });
let GAME1 = null, GAME3 = null;
let GSEQ = 0;
/* st: [family, ...specific names] (empty = unclassified); cs: castles in the order they were built */
function mkGame(date, opp, side, res, plies, end, my, mycs, op, opcs, an, fav) {
  const other = side === 's' ? 'g' : 's';
  return {
    id: 'g' + (++GSEQ), date, sente: side === 's' ? DB.names[0] : opp, gote: side === 's' ? opp : DB.names[0],
    self: side, win: res === 'w' ? side : other, plies, end,
    tags: { [side]: { st: my, cs: mycs }, [other]: { st: op, cs: opcs } },
    an, fav: !!fav, data: null, ai: null, edited: false,
  };
}
function gameFromData(G, an, fav) {
  const m = G.meta, t = (o) => ({ st: o.strategy.slice(), cs: o.castle.slice() });
  return {
    id: 'g' + (++GSEQ), date: m.date, sente: m.sente, gote: m.gote,
    self: m.self === 'gote' ? 'g' : 's', win: m.winner === 'gote' ? 'g' : 's', plies: m.plies, end: m.endReason,
    tags: { s: t(m.tags.sente), g: t(m.tags.gote) }, an, fav: !!fav, data: G, ai: null, edited: false,
  };
}
const I = '居飛車', F = '振り飛車';
/* the state the mock normally opens in: an app that has been used for a few months */
function seedData() {
  DB.first = false; DB.celebrated = true;
  DB.names = ['tsubame', 'つばめ'];
  DB.usage = usageInUse();
  DB.profile = { practice: ['四間飛車', '矢倉'], goal: 'アマ初段になりたい。終盤で詰みを逃さないようにしたい。' };
  DB.style = { focus: '総合', detail: 'ふつう' };
  DB.games = [
    mkGame('2026-11-13', 'mozu', 'g', 'w', 112, '投了', [F, '四間飛車'], ['美濃囲い', '高美濃', '銀冠'], [I, '対振り持久戦'], ['居飛車穴熊'], 'pre'),
    mkGame('2026-11-12', 'sekirei', 's', 'l', 98, '投了', [I, '矢倉'], ['金矢倉'], [I, '雁木'], ['雁木囲い'], 'std'),
    /* the one record still waiting for its analysis can be opened as well: it borrows the moves of the
       second sample game, under another opponent and date */
    (GAME3 = gameFromData({ ...window.KIFU2, meta: { ...window.KIFU2.meta, date: '2026-11-10', sente: 'tsugumi' } }, 'none')),
    gameFromData(window.KIFU, 'pre', true),
    mkGame('2026-11-06', 'uguisu', 's', 'w', 121, '投了', [I, '角換わり'], [], [I, '角換わり'], [], 'pre'),
    mkGame('2026-11-03', 'mejiro', 'g', 'w', 89, '投了', [F, '四間飛車'], ['美濃囲い', '高美濃', '銀冠'], [I, '対振り持久戦'], ['左美濃'], 'std'),
    /* one record that is not the user's own game: kept and replayable, left out of the statistics */
    { id: 'g' + (++GSEQ), date: '2026-11-01', sente: 'kiji', gote: 'toki', self: null, win: 's', plies: 128, end: '投了',
      tags: { s: { st: [I, '矢倉'], cs: ['金矢倉'] }, g: { st: [I, '矢倉'], cs: ['金矢倉'] } }, an: 'std', fav: false, data: null, ai: null, edited: false },
    mkGame('2026-10-30', 'hibari', 's', 'l', 104, '投了', [I, '相掛かり'], ['中住まい'], [I, '相掛かり'], ['中住まい'], 'std'),
    mkGame('2026-10-27', 'kakesu', 'g', 'l', 133, '投了', [F, '三間飛車'], ['美濃囲い', '高美濃'], [I, '対振り持久戦'], ['居飛車穴熊'], 'std'),
    mkGame('2026-10-24', 'kawasemi', 's', 'w', 93, '詰み', [I, '対四間飛車急戦'], ['舟囲い'], [F, '四間飛車'], ['美濃囲い'], 'pre', true),
    mkGame('2026-10-20', 'shijukara', 'g', 'w', 108, '投了', [F, '四間飛車'], ['美濃囲い', '高美濃'], [I, '棒銀'], ['舟囲い'], 'std'),
    mkGame('2026-10-17', 'mozu', 's', 'w', 79, '投了', [I, '矢倉'], ['金矢倉'], [I, '矢倉'], ['金矢倉'], 'std'),
    mkGame('2026-10-12', 'aosagi', 'g', 'l', 96, '投了', [F, '四間飛車'], ['美濃囲い'], [I, '対四間飛車急戦'], ['舟囲い', 'エルモ囲い'], 'std'),
    mkGame('2026-10-08', 'kogera', 's', 'l', 117, '投了', [I, '角換わり'], [], [I, '角換わり'], [], 'std'),
    mkGame('2026-10-03', 'sekirei', 'g', 'w', 101, '詰み', [F, '中飛車'], ['美濃囲い'], [I], ['舟囲い'], 'std', true),
    mkGame('2026-09-28', 'hiyodori', 's', 'w', 87, '投了', [I, '対四間飛車急戦'], ['舟囲い'], [F, '四間飛車'], ['美濃囲い'], 'std'),
    mkGame('2026-09-23', 'tsugumi', 'g', 'l', 124, '投了', [F, '四間飛車'], ['美濃囲い', '高美濃', '銀冠'], [I, '対振り持久戦'], ['居飛車穴熊'], 'std'),
    mkGame('2026-09-19', 'uguisu', 's', 'w', 110, '投了', [I, '矢倉'], ['金矢倉'], [I, '右四間飛車'], ['左美濃'], 'std'),
    mkGame('2026-09-14', 'mejiro', 'g', 'w', 92, '投了', [F, '四間飛車'], ['美濃囲い'], [I, '棒銀'], ['舟囲い'], 'std'),
    mkGame('2026-09-09', 'hibari', 's', 'l', 75, '詰み', [I, '相掛かり'], [], [I, '相掛かり'], [], 'std'),
    mkGame('2026-09-02', 'kakesu', 'g', 'w', 118, '投了', [F, '四間飛車'], ['美濃囲い', '高美濃'], [I, '対振り持久戦'], ['左美濃'], 'std'),
    mkGame('2026-08-27', 'shijukara', 's', 'w', 99, '投了', [I, '矢倉'], ['金矢倉'], [I, '雁木'], ['雁木囲い'], 'std'),
    mkGame('2026-08-21', 'aosagi', 'g', 'l', 106, '投了', [], [], [I], [], 'none'),
    mkGame('2026-08-15', 'kogera', 's', 'w', 84, '投了', [I, '棒銀'], ['舟囲い'], [F, '四間飛車'], ['美濃囲い'], 'std'),
  ];
  GAME1 = DB.games.find((g) => g.data === window.KIFU);
}
/* a first launch: nothing saved, no names registered, nothing analysed yet */
function clearData() {
  DB.first = true; DB.celebrated = false;
  DB.names = [];
  DB.usage = { free: 0, freeMax: 30, precise: 0, preciseMax: 30, total: 0, totalMax: 60, rt: 0, rtMax: 300 };
  DB.profile = { practice: [], goal: '' };
  DB.style = { focus: '総合', detail: 'ふつう' };
  DB.games = [];
  GAME1 = null; GAME3 = null;
}
seedData();

const gameById = (id) => DB.games.find((g) => g.id === id);
const oppName = (g) => (g.self === 's' ? g.gote : g.sente);
const myTags = (g) => (g.self ? g.tags[g.self] : null);
const opTags = (g) => (g.self ? g.tags[g.self === 's' ? 'g' : 's'] : null);
const wonBySelf = (g) => !!g.self && g.win === g.self;
/* your result in a record: 'w' won, 'l' lost, 'd' draw, 'u' not known; null when it is not your game */
const resOf = (g) => (!g.self ? null : g.win === 'd' ? 'd' : g.win === 'u' ? 'u' : g.win === g.self ? 'w' : 'l');
const resText = (g) => (g.win === 'd' ? '引き分け' : g.win === 'u' ? '結果は不明' : `${g.win === 's' ? '先手' : '後手'}の勝ち`);
/* the name shown for a side's strategy: the specific names, or the family when nothing more is known */
const stNames = (t) => (t.st.length > 1 ? t.st.slice(1) : t.st.length ? [t.st[0]] : []);
const csFinal = (t) => (t.cs.length ? t.cs[t.cs.length - 1] : null);
