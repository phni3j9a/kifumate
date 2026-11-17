import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  Color,
  Square,
  standardPieceName,
  type ImmutablePosition,
  type Move,
  type PieceType,
} from "tsshogi";
import { colors } from "./ui";
const faces: Record<string, string> = {
  promPawn: "と",
  promLance: "杏",
  promKnight: "圭",
  promSilver: "全",
  horse: "馬",
  dragon: "竜",
};
export function Board({
  position,
  bottom,
  selected,
  moves,
  onSquare,
  onHand,
  last,
}: {
  position: ImmutablePosition;
  bottom: Color;
  selected: Square | PieceType | null;
  moves: Move[];
  onSquare: (sq: Square) => void;
  onHand: (color: Color, type: PieceType) => void;
  last: Move | null;
}) {
  const opponent = bottom === Color.BLACK ? Color.WHITE : Color.BLACK;
  function tray(color: Color) {
    const pieces = position
      .hand(color)
      .counts.filter((p) => p.count > 0)
      .reverse();
    return (
      <View
        style={[s.tray, color === bottom && { justifyContent: "flex-end" }]}
        accessibilityLabel={color === bottom ? "自分側の駒台" : "相手側の駒台"}
      >
        {pieces.length ? (
          pieces.map((p) => (
            <Pressable
              key={p.type}
              accessibilityRole="button"
              accessibilityLabel={`${color === Color.BLACK ? "先手" : "後手"}の持ち駒 ${standardPieceName(p.type)} ${p.count}枚`}
              onPress={() => onHand(color, p.type)}
              style={[
                s.hand,
                selected === p.type &&
                  position.color === color && { backgroundColor: colors.mint },
              ]}
            >
              <Text
                style={[
                  s.handText,
                  color !== bottom && { transform: [{ rotate: "180deg" }] },
                ]}
              >
                {standardPieceName(p.type)}
                {p.count > 1 ? p.count : ""}
              </Text>
            </Pressable>
          ))
        ) : (
          <Text style={s.none}>なし</Text>
        )}
      </View>
    );
  }
  return (
    <View style={s.mid}>
      {tray(opponent)}
      <View style={s.board}>
        <View style={s.coordinates}>
          {Array.from({ length: 9 }, (_, x) => (
            <Text key={x} style={s.file}>
              {bottom === Color.BLACK ? 9 - x : x + 1}
            </Text>
          ))}
        </View>
        {Array.from({ length: 9 }, (_, y) => (
          <View key={y} style={s.rank}>
            {Array.from({ length: 9 }, (_, x) => {
              const sq = new Square(
                  bottom === Color.BLACK ? 9 - x : x + 1,
                  bottom === Color.BLACK ? y + 1 : 9 - y,
                ),
                piece = position.board.at(sq),
                picked = selected instanceof Square && selected.equals(sq),
                target = moves.some((m) => m.to.equals(sq)),
                recent = last?.to.equals(sq);
              return (
                <Pressable
                  key={x}
                  testID={`square-${sq.file}-${sq.rank}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${sq.file}${"一二三四五六七八九"[sq.rank - 1]} ${piece ? (piece.color === Color.BLACK ? "先手" : "後手") + standardPieceName(piece.type) : "空"}${target ? " 移動できる" : ""}`}
                  onPress={() => onSquare(sq)}
                  style={[
                    s.square,
                    recent && { backgroundColor: "#FFE28A" },
                    picked && { backgroundColor: "#85E5D3" },
                    target && { backgroundColor: "#C6F2DE" },
                  ]}
                >
                  {piece && (
                    <View
                      style={[
                        s.piece,
                        {
                          transform: [
                            {
                              rotate:
                                piece.color === bottom ? "0deg" : "180deg",
                            },
                          ],
                        },
                      ]}
                    >
                      <View style={s.tip} />
                      <Text
                        style={[
                          s.face,
                          faces[piece.type] && { color: "#A92323" },
                        ]}
                      >
                        {faces[piece.type] || standardPieceName(piece.type)}
                      </Text>
                    </View>
                  )}
                  {!piece && target && <View style={s.dot} />}
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
      {tray(bottom)}
    </View>
  );
}
const s = StyleSheet.create({
  mid: { flexDirection: "row", gap: 4, alignItems: "stretch", width: "100%" },
  tray: {
    width: 32,
    backgroundColor: "#F2E6CD",
    borderRadius: 10,
    paddingVertical: 8,
    gap: 4,
    alignItems: "center",
  },
  hand: {
    width: 32,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  handText: { fontSize: 17, fontWeight: "800", color: colors.ink },
  none: { fontSize: 10, color: colors.muted, paddingTop: 8 },
  board: {
    flex: 1,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: "#F7D99F",
    padding: 3,
    paddingTop: 0,
    boxShadow: "0 3px 0 #242846",
  },
  coordinates: { flexDirection: "row", paddingVertical: 4 },
  file: { flex: 1, textAlign: "center", color: colors.muted, fontSize: 10 },
  rank: { flexDirection: "row" },
  square: {
    width: "11.111111%",
    aspectRatio: 0.93,
    borderWidth: 0.5,
    borderColor: "#B99C6B",
    alignItems: "center",
    justifyContent: "center",
  },
  piece: {
    width: "85%",
    height: "80%",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFEAB9",
    borderRadius: 3,
    borderWidth: 0.5,
    borderColor: "#A7894F",
  },
  tip: {
    position: "absolute",
    top: -3,
    width: "65%",
    height: 6,
    backgroundColor: "#FFEAB9",
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
  },
  face: { fontSize: 19, color: colors.ink, fontWeight: "900", lineHeight: 24 },
  dot: { width: 8, height: 8, borderRadius: 99, backgroundColor: "#116A59" },
});
