import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, {
  Circle,
  ClipPath,
  Defs,
  G,
  Line,
  Path,
  Rect,
  Text as SvgText,
} from "react-native-svg";
import {
  Color,
  Square,
  standardPieceName,
  type ImmutablePosition,
  type Move,
  type PieceType,
} from "tsshogi";
import { colors, font, fonts, line, shadow } from "./theme";

// モック game.js の boardSVG() と同じ座標系（1マス 100×108、右に段の文字、上に筋の数字）。
const CW = 100,
  CH = 108,
  OX = 10,
  OY = 38,
  BW = OX + 900 + 34,
  BH = OY + 972 + 12;
const VBX = -4,
  VBY = -4,
  VBW = BW + 8,
  VBH = BH + 20;
const PIECE = "M50 9L79 25L89 99L11 99L21 25Z";
const RANKS = "一二三四五六七八九";
// 盤の上の字と、駒ごとの大きさ（歩は小さく、玉は大きく）
const faces: Record<PieceType, [string, number, boolean]> = {
  pawn: ["歩", 0.9, false],
  lance: ["香", 0.93, false],
  knight: ["桂", 0.94, false],
  silver: ["銀", 0.97, false],
  gold: ["金", 0.97, false],
  bishop: ["角", 1, false],
  rook: ["飛", 1, false],
  king: ["玉", 1.03, false],
  promPawn: ["と", 0.9, true],
  promLance: ["杏", 0.93, true],
  promKnight: ["圭", 0.94, true],
  promSilver: ["全", 0.97, true],
  horse: ["馬", 1, true],
  dragon: ["竜", 1, true],
};
const faceOf = (type: PieceType, color: Color) =>
  type === "king" && color === Color.WHITE ? "王" : faces[type][0];
const centered = (y: number, size: number) => y + 0.35 * size; // SVG の dy=".35em"

/** 駒1枚の絵（駒台と「成る／成らない」で使う。モックの faceSVG） */
function Face({
  type,
  color,
  mine,
  width,
  height,
}: {
  type: PieceType;
  color: Color;
  mine: boolean;
  width: number;
  height: number;
}) {
  return (
    <Svg width={width} height={height} viewBox="0 0 100 108" aria-hidden>
      <Path
        d={PIECE}
        fill={mine ? colors.white : colors.oppPiece}
        stroke={colors.ink}
        strokeWidth={7}
        strokeLinejoin="round"
      />
      <SvgText
        x={50}
        y={centered(64, 56)}
        textAnchor="middle"
        fontFamily={fonts[900]}
        fontSize={56}
        fill={faces[type][2] ? colors.promoted : colors.ink}
      >
        {faceOf(type, color)}
      </SvgText>
    </Svg>
  );
}

export function Board({
  position,
  bottom,
  selected,
  moves,
  onSquare,
  onHand,
  last,
  promotion,
  onPromote,
  label,
  over = false,
  arrow,
  mark,
}: {
  position: ImmutablePosition;
  bottom: Color;
  selected: Square | PieceType | null;
  moves: Move[];
  onSquare: (sq: Square) => void;
  onHand: (color: Color, type: PieceType) => void;
  last: Move | null;
  promotion: Move[];
  onPromote: (move: Move) => void;
  label: string;
  /** 終局した局面では王手の印を出さない */
  over?: boolean;
  arrow?: Move | null;
  mark?: string;
}) {
  const flip = bottom === Color.WHITE;
  const top = flip ? Color.BLACK : Color.WHITE;
  const xy = (sq: Square): [number, number] =>
    flip
      ? [OX + (sq.file - 1) * CW, OY + (9 - sq.rank) * CH]
      : [OX + (9 - sq.file) * CW, OY + (sq.rank - 1) * CH];
  const picked = selected instanceof Square ? selected : null;
  const king =
    !over && position.checked
      ? position.board.findKing(position.color)
      : undefined;

  function arrowSVG() {
    if (!arrow || selected || promotion.length) return null;
    const [tx, ty] = xy(arrow.to),
      ex = tx + 50,
      ey = ty + 54;
    if (!(arrow.from instanceof Square)) {
      const mine = position.color === bottom;
      return (
        <G>
          <G transform={`translate(${tx} ${ty})`} opacity={0.5}>
            <G transform={mine ? undefined : "rotate(180 50 54)"}>
              <Path
                d={PIECE}
                fill={mine ? colors.white : colors.oppPiece}
                stroke={colors.ink}
                strokeWidth={3.4}
              />
              <SvgText
                x={50}
                y={centered(64, 56)}
                textAnchor="middle"
                fontFamily={fonts[900]}
                fontSize={56}
                fill={colors.ink}
              >
                {faces[arrow.pieceType][0]}
              </SvgText>
            </G>
          </G>
          <Circle
            cx={ex}
            cy={ey}
            r={47}
            fill="none"
            stroke={colors.mint}
            strokeWidth={6}
          />
        </G>
      );
    }
    const [fx, fy] = xy(arrow.from),
      sx = fx + 50,
      sy = fy + 54,
      dx = ex - sx,
      dy = ey - sy,
      length = Math.hypot(dx, dy) || 1,
      ux = dx / length,
      uy = dy / length,
      px = -uy,
      py = ux;
    const tipOff = position.board.at(arrow.to) ? 34 : 12,
      head = Math.min(46, Math.max(26, length - tipOff - 44)),
      start = Math.max(0, Math.min(44, length - tipOff - head - 2)),
      hw = (30 * head) / 46;
    const ax = sx + ux * start,
      ay = sy + uy * start,
      tipX = ex - ux * tipOff,
      tipY = ey - uy * tipOff,
      bx = tipX - ux * head,
      by = tipY - uy * head;
    const d = `M${tipX} ${tipY}L${bx + px * hw} ${by + py * hw}L${bx - px * hw} ${by - py * hw}Z`;
    return (
      <G>
        <Line
          x1={ax}
          y1={ay}
          x2={bx}
          y2={by}
          stroke={colors.ink}
          strokeWidth={25}
          strokeLinecap="round"
        />
        <Path
          d={d}
          fill={colors.ink}
          stroke={colors.ink}
          strokeWidth={10}
          strokeLinejoin="round"
        />
        <Line
          x1={ax}
          y1={ay}
          x2={bx}
          y2={by}
          stroke={colors.mint}
          strokeWidth={15}
          strokeLinecap="round"
        />
        <Path d={d} fill={colors.mint} />
      </G>
    );
  }
  function piece(sq: Square, lift: boolean) {
    const p = position.board.at(sq)!;
    const [x, y] = xy(sq);
    const [, scale, promoted] = faces[p.type];
    const mine = p.color === bottom;
    const turn =
      (mine ? "" : "rotate(180 50 54) ") +
      (scale !== 1
        ? `translate(${(50 * (1 - scale)).toFixed(2)} ${(58 * (1 - scale)).toFixed(2)}) scale(${scale})`
        : "");
    const edge = {
      stroke: colors.ink,
      strokeWidth: 3.4,
      strokeLinejoin: "round" as const,
    };
    return (
      <G key={`${sq.file}${sq.rank}`} transform={`translate(${x} ${y})`}>
        <Path
          d={PIECE}
          fill={colors.ink}
          {...edge}
          transform={`translate(0 6) ${turn}`}
        />
        <G transform={`translate(0 ${lift ? -7 : 0}) ${turn}`}>
          <Path
            d={PIECE}
            {...edge}
            fill={
              p.type === "king"
                ? mine
                  ? colors.you
                  : colors.oppKing
                : mine
                  ? colors.white
                  : colors.oppPiece
            }
          />
          <SvgText
            x={50}
            y={centered(64, 52)}
            textAnchor="middle"
            fontFamily={fonts[900]}
            fontSize={52}
            fill={promoted ? colors.promoted : colors.ink}
          >
            {faceOf(p.type, p.color)}
          </SvgText>
        </G>
      </G>
    );
  }
  function tray(color: Color) {
    // 飛・角・金・銀・桂・香・歩の順（tsshogi の counts の並び）
    const pieces = position.hand(color).counts.filter((p) => p.count > 0);
    return (
      <View style={[s.col, color === bottom && { justifyContent: "flex-end" }]}>
        <View>
          <View
            accessibilityLabel={
              color === bottom ? "自分側の駒台" : "相手側の駒台"
            }
            style={[s.tray, !pieces.length && s.trayNone]}
          >
            {pieces.length ? (
              pieces.map((p) => (
                <View
                  key={p.type}
                  style={[
                    s.hk,
                    selected === p.type &&
                      position.color === color && {
                        backgroundColor: colors.you,
                      },
                  ]}
                >
                  <Face
                    type={p.type}
                    color={color}
                    mine={color === bottom}
                    width={19}
                    height={20.5}
                  />
                  {p.count > 1 && (
                    <View style={s.hkCount}>
                      <Text
                        style={[
                          font(900, 8, 11 / 8, colors.white),
                          { textAlign: "center" },
                        ]}
                      >
                        {p.count}
                      </Text>
                    </View>
                  )}
                </View>
              ))
            ) : (
              <Text style={s.none}>{"な\nし"}</Text>
            )}
          </View>
          {/* 押せる範囲は駒台の上に重ねる。幅は列いっぱいの30、高さは駒＋駒の間で26。隣の駒とは重ならない */}
          <View style={s.hits}>
            {pieces.map((p) => (
              <Pressable
                key={p.type}
                accessibilityRole="button"
                accessibilityLabel={`${color === Color.BLACK ? "先手" : "後手"}の持ち駒 ${standardPieceName(p.type)} ${p.count}枚`}
                onPress={() => onHand(color, p.type)}
                style={{ height: 26 }}
              />
            ))}
          </View>
        </View>
      </View>
    );
  }
  const ask = promotion[0];
  const askAt = ask ? xy(ask.to) : null;
  const squares = position.board.listNonEmptySquares();
  return (
    <View style={s.mid}>
      {tray(top)}
      <View style={s.board}>
        <Svg
          width="100%"
          height="100%"
          viewBox={`${VBX} ${VBY} ${VBW} ${VBH}`}
          accessibilityRole="image"
          accessibilityLabel={label}
        >
          <Defs>
            <ClipPath id="sfc">
              <Rect x={OX} y={OY} width={900} height={972} rx={12} />
            </ClipPath>
          </Defs>
          <Rect x={0} y={12} width={BW} height={BH} rx={34} fill={colors.ink} />
          <Rect
            x={0}
            y={0}
            width={BW}
            height={BH}
            rx={34}
            fill="#FFCB6B"
            stroke={colors.ink}
            strokeWidth={5}
          />
          <G clipPath="url(#sfc)">
            <Rect x={OX} y={OY} width={900} height={972} fill="#FFF3D1" />
            <Rect x={OX} y={OY} width={900} height={CH * 3} fill="#FFF9E8" />
            <Rect
              x={OX}
              y={OY + CH * 6}
              width={900}
              height={CH * 3}
              fill="#FFE9B6"
            />
            {last?.from instanceof Square && (
              <Rect
                x={xy(last.from)[0] + 9}
                y={xy(last.from)[1] + 9}
                width={CW - 18}
                height={CH - 18}
                rx={10}
                fill="none"
                stroke="rgba(36,40,70,0.42)"
                strokeWidth={4}
                strokeDasharray="12 9"
              />
            )}
            {last && (
              <Rect
                x={xy(last.to)[0]}
                y={xy(last.to)[1]}
                width={CW}
                height={CH}
                fill="rgba(36,40,70,0.15)"
              />
            )}
            {king && (
              <Rect
                x={xy(king)[0]}
                y={xy(king)[1]}
                width={CW}
                height={CH}
                fill="rgba(255,100,100,0.45)"
              />
            )}
            {picked && (
              <Rect
                x={xy(picked)[0]}
                y={xy(picked)[1]}
                width={CW}
                height={CH}
                fill={colors.you}
              />
            )}
          </G>
          {Array.from({ length: 8 }, (_, i) => (
            <G key={i} stroke={colors.ink} strokeWidth={1.6} opacity={0.3}>
              <Line
                x1={OX + (i + 1) * CW}
                y1={OY}
                x2={OX + (i + 1) * CW}
                y2={OY + 972}
              />
              <Line
                x1={OX}
                y1={OY + (i + 1) * CH}
                x2={OX + 900}
                y2={OY + (i + 1) * CH}
              />
            </G>
          ))}
          <Rect
            x={OX}
            y={OY}
            width={900}
            height={972}
            rx={12}
            fill="none"
            stroke={colors.ink}
            strokeWidth={3.5}
          />
          {[
            [3, 3],
            [6, 3],
            [3, 6],
            [6, 6],
          ].map(([i, j]) => (
            <Circle
              key={`${i}${j}`}
              cx={OX + i! * CW}
              cy={OY + j! * CH}
              r={8}
              fill={colors.ink}
              opacity={0.6}
            />
          ))}
          {Array.from({ length: 9 }, (_, i) => (
            <G
              key={i}
              fontFamily={fonts[900]}
              fontSize={26}
              fill={colors.ink}
              textAnchor="middle"
            >
              <SvgText
                x={xy(new Square(i + 1, 1))[0] + 50}
                y={centered(OY / 2 + 1, 26)}
              >
                {i + 1}
              </SvgText>
              <SvgText
                x={OX + 900 + 17}
                y={centered(xy(new Square(1, i + 1))[1] + 54, 26)}
              >
                {RANKS[i]}
              </SvgText>
            </G>
          ))}
          {squares
            .filter((sq) => !picked?.equals(sq))
            .map((sq) => piece(sq, false))}
          {picked && position.board.at(picked) && piece(picked, true)}
          {moves.map((m) => {
            const [x, y] = xy(m.to);
            return position.board.at(m.to) ? (
              <Circle
                key={m.usi}
                cx={x + 50}
                cy={y + 54}
                r={45}
                fill="none"
                stroke={colors.coral}
                strokeWidth={8}
              />
            ) : (
              <Circle
                key={m.usi}
                cx={x + 50}
                cy={y + 54}
                r={15}
                fill={colors.mint}
                stroke={colors.ink}
                strokeWidth={3}
              />
            );
          })}
          {arrowSVG()}
          {mark && last && (
            <G
              transform={`translate(${xy(last.to)[0] + 85} ${xy(last.to)[1] + 17})`}
            >
              <Circle
                r={21}
                fill={
                  mark === "悪手"
                    ? colors.coral
                    : mark === "好手"
                      ? colors.mint
                      : colors.orange
                }
                stroke={colors.ink}
                strokeWidth={4}
              />
              <SvgText
                textAnchor="middle"
                y={9}
                fontFamily={fonts[900]}
                fontSize={28}
                fill={colors.ink}
              >
                {mark === "悪手" ? "×" : mark === "好手" ? "◎" : "△"}
              </SvgText>
            </G>
          )}
          {king &&
            (() => {
              const [x, y] = xy(king);
              const bx = Math.max(OX + 6, Math.min(OX + 900 - 90, x + 8));
              const by = y > OY + 20 ? y - 26 : y + CH - 8;
              return (
                <G>
                  <Rect
                    x={bx}
                    y={by}
                    width={84}
                    height={36}
                    rx={18}
                    fill={colors.coral}
                    stroke={colors.ink}
                    strokeWidth={3.4}
                  />
                  <SvgText
                    x={bx + 42}
                    y={centered(by + 18, 23)}
                    textAnchor="middle"
                    fontFamily={fonts[900]}
                    fontSize={23}
                    fill={colors.ink}
                  >
                    王手
                  </SvgText>
                </G>
              );
            })()}
        </Svg>
        {Square.all.map((sq) => {
          const [x, y] = xy(sq);
          const p = position.board.at(sq);
          const target = moves.some((m) => m.to.equals(sq));
          return (
            <Pressable
              key={`${sq.file}${sq.rank}`}
              testID={`square-${sq.file}-${sq.rank}`}
              accessibilityRole="button"
              accessibilityLabel={`${sq.file}${RANKS[sq.rank - 1]} ${p ? (p.color === Color.BLACK ? "先手" : "後手") + standardPieceName(p.type) : "空"}${target ? " 移動できる" : ""}`}
              onPress={() => onSquare(sq)}
              style={{
                position: "absolute",
                left: `${((x - VBX) / VBW) * 100}%`,
                top: `${((y - VBY) / VBH) * 100}%`,
                width: `${(CW / VBW) * 100}%`,
                height: `${(CH / VBH) * 100}%`,
              }}
            />
          );
        })}
        {ask && askAt && (
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel="成りますか"
            style={[
              s.prm,
              {
                left: `${Math.max(22, Math.min(78, ((askAt[0] + 50 - VBX) / VBW) * 100))}%`,
                top: `${Math.max(12, Math.min(88, ((askAt[1] + 54 - VBY) / VBH) * 100))}%`,
              },
            ]}
          >
            {[...promotion]
              .sort((a, b) => +b.promote - +a.promote)
              .map((m) => (
                <Pressable
                  key={m.usi}
                  accessibilityRole="button"
                  accessibilityLabel={m.promote ? "成る" : "成らない"}
                  onPress={() => onPromote(m)}
                  style={[
                    s.prmButton,
                    m.promote && {
                      backgroundColor: colors.you,
                      borderColor: colors.ink,
                    },
                  ]}
                >
                  <Face
                    type={m.promote ? promotedType(m.pieceType) : m.pieceType}
                    color={m.color}
                    mine
                    width={28}
                    height={30}
                  />
                  <Text style={font(900, 10)}>
                    {m.promote ? "成る" : "成らない"}
                  </Text>
                </Pressable>
              ))}
          </View>
        )}
      </View>
      {tray(bottom)}
    </View>
  );
}
const promotedType = (type: PieceType): PieceType =>
  (
    ({
      pawn: "promPawn",
      lance: "promLance",
      knight: "promKnight",
      silver: "promSilver",
      bishop: "horse",
      rook: "dragon",
    }) as Partial<Record<PieceType, PieceType>>
  )[type] ?? type;
const s = StyleSheet.create({
  mid: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: 3,
    paddingHorizontal: 3,
  },
  // 見た目は幅24の列（.col）。押せる範囲のために左右の余白（3）まで含めた幅30にし、負の余白で戻す
  col: {
    width: 30,
    marginHorizontal: -3,
    alignItems: "stretch",
    paddingTop: 2,
    paddingBottom: 8,
  },
  tray: {
    alignSelf: "center",
    width: 24,
    alignItems: "center",
    gap: 3,
    paddingVertical: 3,
    borderWidth: line.thin,
    borderStyle: "solid", // Android は trayNone の破線を外しても実線に戻らない
    borderColor: colors.ink,
    borderRadius: 9,
    backgroundColor: colors.white,
  },
  trayNone: {
    borderStyle: "dashed",
    borderColor: "rgba(36,40,70,0.4)",
    backgroundColor: "transparent",
  },
  // 縦書きの「なし」（writing-mode の代わりに1字ずつ改行。1字の送りは縦の字幅＋.2em で 10.7px）
  none: {
    ...font(700, 8.5, 10.7 / 8.5, colors.ink2),
    textAlign: "center",
    paddingVertical: 3,
  },
  // 駒台の枠（1.5）＋内側（3）から、駒の間の半分（1.5）を引いた位置から並べる
  hits: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    paddingVertical: 3,
  },
  hk: {
    width: 22,
    height: 23,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  hkCount: {
    position: "absolute",
    right: 0,
    bottom: -1,
    minWidth: 11,
    height: 11,
    paddingHorizontal: 2,
    borderRadius: 6,
    backgroundColor: colors.ink,
  },
  board: { flex: 1, aspectRatio: VBW / VBH },
  prm: {
    position: "absolute",
    zIndex: 3,
    flexDirection: "row",
    gap: 5,
    padding: 5,
    backgroundColor: colors.white,
    borderWidth: line.ol,
    borderColor: colors.ink,
    borderRadius: 14,
    boxShadow: shadow.card,
    transform: [{ translateX: "-50%" }, { translateY: "-50%" }],
  },
  prmButton: {
    alignItems: "center",
    gap: 3,
    minWidth: 56,
    paddingTop: 5,
    paddingHorizontal: 6,
    paddingBottom: 4,
    borderRadius: 9,
    borderWidth: line.thin,
    borderColor: "transparent",
  },
});
