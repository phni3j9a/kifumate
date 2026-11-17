import { useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Color, formatKIFMove, Move, Square, type PieceType } from "tsshogi";
import { Board } from "../../components/board";
import { useGame } from "../../components/use-game";
import {
  Button,
  Card,
  colors,
  IconButton,
  Label,
  Message,
  Page,
  styles,
} from "../../components/ui";
import { Branch, legalMoves, readKif } from "../../core/kif";
import { toggleFavorite } from "../../storage/repository";
export default function GameScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { game, error, db } = useGame(id);
  const record = useMemo(() => (game ? readKif(game.kif) : null), [game]);
  const [ply, setPly] = useState(0),
    [branch, setBranch] = useState<Branch | null>(null),
    [, redraw] = useState(0);
  const [selected, setSelected] = useState<Square | PieceType | null>(null),
    [promotion, setPromotion] = useState<Move[]>([]),
    [message, setMessage] = useState(""),
    [flipped, setFlipped] = useState(false),
    [showMoves, setShowMoves] = useState(false),
    [favorite, setFavorite] = useState<number | null>(null);
  if (!record || !game)
    return (
      <Page>
        <Message text={error || "棋譜を読み込んでいます…"} error={!!error} />
      </Page>
    );
  const total = game.plies;
  record.goto(Math.min(ply, total));
  const position = branch?.position || record.position;
  const baseBottom = game.self_side === "white" ? Color.WHITE : Color.BLACK;
  const bottom = flipped
    ? baseBottom === Color.BLACK
      ? Color.WHITE
      : Color.BLACK
    : baseBottom;
  const top = bottom === Color.BLACK ? Color.WHITE : Color.BLACK;
  const name = (color: Color) =>
    `${color === Color.BLACK ? "☗ " + game.black : "☖ " + game.white}${position.color === color ? " ・手番" : ""}`;
  const moves = selected ? legalMoves(position, selected) : [];
  const last = branch
    ? (branch.moves[branch.at - 1] ?? null)
    : record.current.move instanceof Move
      ? record.current.move
      : null;
  function clear() {
    setSelected(null);
    setPromotion([]);
    setMessage("");
  }
  function leaveBranch() {
    setPly(branch?.base ?? ply);
    setBranch(null);
    clear();
  }
  function commit(move: Move) {
    try {
      const b = branch ?? new Branch(ply, position);
      b.play(move);
      setBranch(b);
      redraw((v) => v + 1);
      clear();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "指せませんでした。");
    }
  }
  function square(sq: Square) {
    const choices = moves.filter((m) => m.to.equals(sq));
    if (choices.length === 1) {
      commit(choices[0]!);
      return;
    }
    if (choices.length > 1) {
      setPromotion(choices);
      return;
    }
    const piece = position.board.at(sq);
    clear();
    if (!piece) return;
    if (piece.color !== position.color) {
      setMessage("いまは反対側の手番です。");
      return;
    }
    if (!(selected instanceof Square && selected.equals(sq))) setSelected(sq);
  }
  function hand(color: Color, type: PieceType) {
    clear();
    if (color !== position.color) setMessage("いまは反対側の手番です。");
    else setSelected(selected === type ? null : type);
  }
  function step(to: number) {
    clear();
    if (branch) {
      branch.step(to);
      redraw((v) => v + 1);
    } else setPly(Math.max(0, Math.min(total, to)));
  }
  const at = branch?.at ?? ply,
    end = branch?.moves.length ?? total;
  async function fav() {
    try {
      await toggleFavorite(db, {
        ...game!,
        favorite: favorite ?? game!.favorite,
      });
      setFavorite((previous) => ((previous ?? game!.favorite) ? 0 : 1));
    } catch {
      setMessage("お気に入りを保存できませんでした。");
    }
  }
  return (
    <Page>
      <Stack.Screen
        options={{
          title: branch ? "分岐を検討" : "対局",
          headerRight: () => (
            <IconButton
              name="information-outline"
              label="対局情報"
              onPress={() => router.push({ pathname: "/info", params: { id } })}
            />
          ),
        }}
      />
      <View style={s.readout}>
        <Label muted>{game.self_side ? "あなた" : "先手"}</Label>
        <Text style={s.badge}>{branch ? "分岐中" : "未解析"}</Text>
        <Label muted>{game.self_side ? "相手" : "後手"}</Label>
      </View>
      <View accessibilityLabel="形勢はまだ分かりません" style={s.bar}>
        <View style={{ backgroundColor: colors.yellow, width: "50%" }} />
        <View style={{ backgroundColor: colors.blue, flex: 1 }} />
      </View>
      <Text style={s.player} numberOfLines={2}>
        {name(top)}
      </Text>
      <Board
        position={position}
        bottom={bottom}
        selected={selected}
        moves={moves}
        onSquare={square}
        onHand={hand}
        last={last}
      />
      <Text style={[s.player, { textAlign: "right" }]} numberOfLines={2}>
        {name(bottom)}
      </Text>
      <View style={[styles.row, { justifyContent: "space-between" }]}>
        <IconButton
          name={branch ? "undo" : "skip-backward"}
          label={branch ? "本譜に戻る" : "最初へ"}
          onPress={() => (branch ? leaveBranch() : step(0))}
        />
        <IconButton
          name="chevron-left"
          label="1手戻る"
          disabled={at === 0}
          onPress={() => step(at - 1)}
        />
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text style={{ color: colors.ink, fontWeight: "800", fontSize: 13 }}>
            {branch
              ? `分岐 ${at}手目`
              : ply
                ? `${ply}手目 / ${total}手`
                : "開始局面"}
          </Text>
          <Text style={{ color: colors.ink, fontSize: 14 }}>
            {last ? formatKIFMove(last) : "　"}
          </Text>
        </View>
        <IconButton
          name="chevron-right"
          label="1手進む"
          disabled={at >= end}
          onPress={() => step(at + 1)}
        />
        <IconButton
          name="skip-forward"
          label="最後へ"
          disabled={at >= end}
          onPress={() => step(end)}
        />
      </View>
      <Message text={message} />
      {branch ? (
        <Card>
          <Label>本譜の{branch.base}手目から分岐中</Label>
          <Label muted>
            駒または持ち駒を選んで、色の付いたマスへ。本譜と戦績は変わりません。分岐はこの画面を閉じると消えます。
          </Label>
          <Button primary onPress={leaveBranch}>
            本譜に戻る
          </Button>
        </Card>
      ) : (
        <Button
          primary
          onPress={() => {
            clear();
            setBranch(new Branch(ply, position));
          }}
        >
          ここから分岐を試す
        </Button>
      )}
      <View style={[styles.row, { justifyContent: "space-between" }]}>
        <Button onPress={() => setShowMoves(!showMoves)}>
          {showMoves ? "手順を閉じる" : "棋譜の手順"}
        </Button>
        <IconButton
          name="rotate-3d-variant"
          label="盤の向きを変える"
          onPress={() => {
            setFlipped(!flipped);
            clear();
          }}
        />
        <IconButton
          name={(favorite ?? game.favorite) ? "star" : "star-outline"}
          label="お気に入りを切り替える"
          onPress={() => void fav()}
        />
      </View>
      {showMoves && (
        <Card>
          {branch ? (
            <>
              <Label muted>分岐の手順</Label>
              <Button onPress={() => step(0)}>分岐の開始局面</Button>
              {branch.moves.map((m, i) => (
                <Button key={i} onPress={() => step(i + 1)}>
                  {i + 1} {formatKIFMove(m)}
                </Button>
              ))}
            </>
          ) : (
            <>
              <Button onPress={() => step(0)}>開始局面</Button>
              {record.moves
                .filter((n) => n.move instanceof Move)
                .map((n) => (
                  <Button key={n.ply} onPress={() => step(n.ply)}>
                    {n.ply} {n.displayText}
                  </Button>
                ))}
            </>
          )}
        </Card>
      )}
      <View style={s.graph} accessibilityLabel="評価値グラフ 未解析">
        {[3000, 1500, 0, -1500, -3000].map((v) => (
          <View key={v} style={s.graphRow}>
            <Text style={s.axis}>
              {v > 0 ? "+" : ""}
              {v}
            </Text>
            <View style={s.line} />
          </View>
        ))}
        <Text style={s.graphMessage}>未解析・まだ評価値はありません</Text>
      </View>
      <Card>
        <Label>候補手　—</Label>
        <Label muted>
          未解析です。解析の連携は準備中です。盤を動かして、別の手を試すことはできます。
        </Label>
      </Card>
      <Button
        onPress={() => router.push({ pathname: "/info", params: { id } })}
      >
        対局情報・結果を直す
      </Button>
      <Button
        onPress={() => router.push({ pathname: "/export", params: { id } })}
      >
        KIFを書き出す
      </Button>
      <Modal
        visible={promotion.length > 0}
        transparent
        animationType="fade"
        onRequestClose={() => setPromotion([])}
      >
        <View style={s.overlay}>
          <View style={styles.card}>
            <Label title>成りますか？</Label>
            {promotion.map((m) => (
              <Button key={m.usi} primary={m.promote} onPress={() => commit(m)}>
                {m.promote ? "成る" : "成らない"}
              </Button>
            ))}
            <Pressable
              accessibilityRole="button"
              onPress={() => setPromotion([])}
              style={{ padding: 16 }}
            >
              <Label>キャンセル</Label>
            </Pressable>
          </View>
        </View>
      </Modal>
    </Page>
  );
}
const s = StyleSheet.create({
  readout: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  badge: {
    color: colors.ink,
    backgroundColor: "#EEEADD",
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 99,
    fontWeight: "800",
  },
  bar: {
    height: 12,
    borderRadius: 99,
    borderWidth: 2,
    borderColor: colors.ink,
    flexDirection: "row",
    overflow: "hidden",
  },
  player: {
    color: colors.ink,
    fontWeight: "800",
    fontSize: 14,
    lineHeight: 22,
  },
  graph: {
    height: 150,
    position: "relative",
    justifyContent: "space-between",
    backgroundColor: "#FFFFFF88",
    borderRadius: 12,
    padding: 8,
  },
  graphRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  axis: { fontSize: 10, width: 36, textAlign: "right", color: colors.muted },
  line: { height: 1, backgroundColor: colors.line, flex: 1 },
  graphMessage: {
    position: "absolute",
    top: 58,
    alignSelf: "center",
    color: colors.muted,
    backgroundColor: colors.background,
    padding: 8,
    fontSize: 12,
  },
  overlay: {
    flex: 1,
    backgroundColor: "#24284699",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
});
