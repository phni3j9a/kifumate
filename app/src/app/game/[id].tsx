import { CoachSheet } from "../../coach/sheet";
import { useCoach } from "../../coach/provider";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import {
  router,
  useFocusEffect,
  useIsFocused,
  useLocalSearchParams,
} from "expo-router";
import { Color, formatMove, Move, Square, type PieceType } from "tsshogi";
import { Board } from "../../components/board";
import { ChanceBar } from "../../components/chance-bar";
import { EvaluationHelp } from "../../components/evaluation-help";
import ExportSheet from "../../components/export-sheet";
import { EvalGraph } from "../../components/graph";
import { Icon } from "../../components/icons";
import {
  ask,
  hideToast,
  MenuRow,
  Sheet,
  toast,
} from "../../components/overlay";
import { colors, font, line, radius, shadow } from "../../components/theme";
import {
  Button,
  PageHeader,
  Problem,
  RoundButton,
  Screen,
} from "../../components/ui";
import { useGame } from "../../components/use-game";
import { dateParts, moveText } from "../../core/format";
import { Branch, gameOutcome, legalMoves, readStoredKif } from "../../core/kif";
import { AnalysisPanel } from "../../components/analysis-panel";
import { useAnalysis, useRealtime } from "../../analysis/provider";
import { positionKey } from "../../analysis/realtime-types";
import { RealtimeToggle } from "../../components/realtime-controls";
import {
  candidateRows,
  readingText,
  type CandidateRow,
  analysisInput,
  cp,
  percent,
  phaseRanges,
  pointsFor,
  scoreText,
  startPly,
  signed,
} from "../../analysis/display";
import { needsRetryConfirmation, type Mode } from "../../analysis/types";
import { deleteGame, toggleFavorite } from "../../storage/repository";

/** 対局者名（.id）。手番の側はミント色になり「手番」と出る */
function PlayerName({
  name,
  color,
  turn,
  bottom,
}: {
  name: string;
  color: Color;
  turn: boolean;
  bottom: boolean;
}) {
  const avatar = (
    <View style={[s.av, { backgroundColor: bottom ? colors.you : colors.opp }]}>
      <Text style={font(500, 8)}>{color === Color.BLACK ? "☗" : "☖"}</Text>
    </View>
  );
  const tn = turn && <Text style={font(900, 9.5)}>手番</Text>;
  return (
    <View
      accessible
      accessibilityLabel={`${color === Color.BLACK ? "先手" : "後手"} ${name}${turn ? "、手番" : ""}`}
      style={[
        s.id,
        bottom
          ? { paddingLeft: 8, paddingRight: 1 }
          : { paddingLeft: 1, paddingRight: 8 },
        turn && { backgroundColor: colors.mint, borderColor: colors.ink },
      ]}
    >
      {bottom ? tn : avatar}
      <Text numberOfLines={1} style={[font(700, 11.5, 1.3), { flexShrink: 1 }]}>
        {name}
      </Text>
      {bottom ? avatar : tn}
    </View>
  );
}

export default function GameScreen() {
  const { id, coach } = useLocalSearchParams<{ id: string; coach?: string }>();
  return <GameView key={id} id={id} openCoach={coach === "1"} />;
}
function GameView({ id, openCoach }: { id: string; openCoach: boolean }) {
  const [coachOpen, setCoachOpen] = useState(openCoach);
  const [coachFull, setCoachFull] = useState(false);
  const [coachTop, setCoachTop] = useState(450);
  const [coachFullTop, setCoachFullTop] = useState(46);
  const focused = useIsFocused();
  const coach = useCoach();
  const { game, error, db } = useGame(id);
  const kif = game?.kif;
  const record = useMemo(
    () => (kif === undefined ? null : readStoredKif(kif)),
    [kif],
  );
  const [ply, setPly] = useState(0),
    [branch, setBranch] = useState<Branch | null>(null),
    [, redraw] = useState(0);
  const [selected, setSelected] = useState<Square | PieceType | null>(null),
    [promotion, setPromotion] = useState<Move[]>([]),
    [flipped, setFlipped] = useState(false),
    [sheet, setSheet] = useState<
      "moves" | "menu" | "export" | "evaluation" | null
    >(null),
    [favorite, setFavorite] = useState<number | null>(null);
  const told = useRef(false);
  const opened = useRef(false);
  const [initialized, setInitialized] = useState(false);
  const { records, offline, controller, ready, watchReview } = useAnalysis();
  const undoBranch = useRef<(() => void) | null>(null);
  const clearBranchUndo = useCallback(() => {
    if (undoBranch.current) hideToast(undoBranch.current);
    undoBranch.current = null;
  }, []);
  const [movesRow, setMovesRow] = useState<{
    y: number;
    height: number;
  } | null>(null);
  const loaded = !!record && !!game;
  const reviewJump = useRef(() => {});
  useFocusEffect(
    useCallback(() => {
      const unwatch = loaded
        ? watchReview({ id, jump: () => reviewJump.current() })
        : undefined;
      return () => {
        unwatch?.();
        clearBranchUndo();
      };
    }, [watchReview, id, loaded, clearBranchUndo]),
  );
  const analysis = records[id];
  const rt = useRealtime();
  const rtController = rt.controller;
  const branchInput =
    record && branch
      ? {
          initial: record.initialPosition.sfen,
          moves: [
            ...record.moves
              .filter((n) => n.move instanceof Move)
              .slice(0, branch.base)
              .map((n) => (n.move as Move).usi),
            ...branch.moves.slice(0, branch.at).map((m) => m.usi),
          ],
        }
      : null;
  const branchKey = branchInput ? positionKey(branchInput) : null;
  const inputRef = useRef(branchInput);
  inputRef.current = branchInput;
  useFocusEffect(
    useCallback(() => {
      rtController.setVisible(true);
      if (inputRef.current) rtController.move(inputRef.current);
      return () => rtController.setVisible(false);
    }, [rtController]),
  );
  const previousBranchKey = useRef<string | null>(null);
  useEffect(() => {
    if (inputRef.current) rtController.move(inputRef.current);
    else if (previousBranchKey.current) rtController.leaveBranch();
    previousBranchKey.current = branchKey;
  }, [branchKey, rtController]);
  const lowTold = useRef(false);
  useEffect(() => {
    if (
      branchKey &&
      rt.quota?.low &&
      rt.quota.remainingMs > 0 &&
      !lowTold.current
    ) {
      lowTold.current = true;
      toast(
        `分岐中の解析は、今月あと${Math.ceil(rt.quota.remainingMs / 60000)}分使えます`,
      );
    }
  }, [branchKey, rt.quota]);
  const rtResult = branchKey === rt.positionKey ? rt.result : null;
  const rtBusy =
    !!branch &&
    rt.enabled &&
    rt.paid === true &&
    (branchKey !== rt.positionKey ||
      rt.status === "preparing" ||
      rt.status === "analyzing");
  const [candidateState, setCandidateState] = useState({ key: "", index: 0 });
  const candidateKey = `${ply}:${branch?.at}`;
  const candidate =
    candidateState.key === candidateKey ? candidateState.index : 0;
  const setCandidate = (index: number) =>
    setCandidateState({ key: candidateKey, index });
  const results = useMemo(
    () =>
      analysis?.attempt
        ? analysis.attempt.results
        : analysis?.saved?.results || [],
    [analysis],
  );
  const evaluated = useMemo(
    () =>
      record
        ? pointsFor(
            record,
            results,
            game?.self_side === "white" ? Color.WHITE : Color.BLACK,
          )
        : [],
    [record, results, game?.self_side],
  );
  const phases = useMemo(() => (record ? phaseRanges(record) : []), [record]);
  if (record && ready && !initialized) {
    setInitialized(true);
    if (analysis?.saved && !analysis.attempt) setPly(startPly(evaluated));
  }
  useEffect(() => {
    if (!record || !ready || opened.current) return;
    opened.current = true;
    if (analysis?.saved && !analysis.attempt) {
      const n = startPly(evaluated);
      if (n)
        toast(
          game?.self_side
            ? "あなたの最初の悪手から表示しています"
            : "最初の悪手から表示しています",
        );
    }
  }, [record, ready, analysis, evaluated, game?.self_side]);
  const { width: W, height: H } = useWindowDimensions();
  const base = branch?.base;
  // 戻る操作は、まず分岐を抜ける（モックの back()）。
  useFocusEffect(
    useCallback(() => {
      if (base === undefined && !coachOpen) return;
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        if (coachOpen) {
          setCoachOpen(false);
          return true;
        }
        setPly(base!);
        setBranch(null);
        setSelected(null);
        setPromotion([]);
        return true;
      });
      return () => sub.remove();
    }, [base, coachOpen]),
  );
  if (!record || !game)
    return (
      <Screen>
        <PageHeader title="対局" />
        <Problem text={error || "棋譜を読み込んでいます…"} />
      </Screen>
    );
  // 画面の高さに合わせて少しだけ大きくする（app.css の --u：720px で 0、900px で 10）
  const u = Math.max(0, Math.min(10, (H - 720) / 18));
  const cb = 34 + u * 0.7;
  const total = game.plies;
  record.goto(Math.min(ply, total));
  const position = branch?.position || record.position;
  const own = !!game.self_side;
  const self = game.self_side === "white" ? Color.WHITE : Color.BLACK;
  const bottom = !own && flipped ? Color.WHITE : self;
  const top = bottom === Color.BLACK ? Color.WHITE : Color.BLACK;
  // 反転は盤だけ。形勢情報の軸は自分の側（観戦では先手）に固定する。
  const nameOf = (color: Color) =>
    color === Color.BLACK ? game.black : game.white;
  const sideOf = (color: Color) => (color === Color.BLACK ? "先手" : "後手");
  const over = !branch && ply >= total;
  const moves = selected ? legalMoves(position, selected) : [];
  const last = branch
    ? (branch.moves[branch.at - 1] ?? null)
    : record.current.move instanceof Move
      ? record.current.move
      : null;
  const mainText = (n: { displayText: string }) => moveText(n.displayText);
  const branchText = (i: number) =>
    moveText(
      formatMove(branch!.positions[i]!, branch!.moves[i]!, {
        lastMove: i ? branch!.moves[i - 1] : (mainLast ?? undefined),
      }),
    );
  const mainLast =
    record.current.move instanceof Move ? record.current.move : null;
  const at = branch?.at ?? ply,
    end = branch?.moves.length ?? total;
  const mainMoves = record.moves.filter((n) => n.move instanceof Move);
  function clear() {
    setSelected(null);
    setPromotion([]);
  }
  function leaveBranch() {
    setPly(branch?.base ?? ply);
    setBranch(null);
    clear();
  }
  function jumpMain(to: number) {
    setPly(Math.max(0, Math.min(total, to)));
    setBranch(null);
    clear();
    if (!branch || branch.moves.length < 2) return;
    const restore = () => {
      if (undoBranch.current !== restore) return;
      clearBranchUndo();
      setPly(branch.base);
      setBranch(branch);
      clear();
    };
    undoBranch.current = restore;
    toast("本譜に戻りました", { label: "分岐に戻る", onPress: restore });
  }
  reviewJump.current = () =>
    jumpMain(
      startPly(
        pointsFor(
          record,
          controller.snapshot.records[id]?.saved?.results ?? [],
          self,
        ),
      ),
    );
  function commit(move: Move) {
    // 本譜の次の手と同じなら、分岐にせず本譜を1手進める（モックの commitMove と同じ）
    const next = mainMoves[ply]?.move;
    if (!branch && next instanceof Move && move.equals(next)) {
      setPly(ply + 1);
      clear();
      return;
    }
    try {
      const b = branch ?? new Branch(ply, position);
      clearBranchUndo();
      b.play(move);
      setBranch(b);
      redraw((v) => v + 1);
      clear();
      if (!branch && !told.current) {
        told.current = true;
        toast("分岐は保存されません。本譜や戦績は変わりません");
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "指せませんでした。");
    }
  }
  const turnName = () =>
    own
      ? position.color === self
        ? "あなた"
        : "相手"
      : (position.color === Color.BLACK ? "☗" : "☖") + sideOf(position.color);
  function square(sq: Square) {
    if (promotion.length) {
      clear();
      return;
    }
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
      toast(`いまは${turnName()}の番です`);
      return;
    }
    if (!(selected instanceof Square && selected.equals(sq))) setSelected(sq);
  }
  function hand(color: Color, type: PieceType) {
    clear();
    if (color !== position.color) toast(`いまは${turnName()}の番です`);
    else setSelected(selected === type ? null : type);
  }
  function step(to: number) {
    clear();
    if (!branch) setPly(Math.max(0, Math.min(total, to)));
    else if (to < 1) leaveBranch();
    else {
      branch.step(to);
      redraw((v) => v + 1);
    }
  }
  const point = evaluated[ply];
  const shown = !branch ? results.find((r) => r.ply === ply) : undefined;
  const rows = candidateRows(
    position,
    over ? undefined : shown,
    mainMoves[ply]?.move instanceof Move
      ? (mainMoves[ply]!.move as Move)
      : undefined,
    self,
    own,
  );
  rows.forEach((r) => {
    r.reading = readingText(position, r.pv);
  });
  let branchRow: CandidateRow | undefined;
  if (branch) {
    const atBase = results.find((r) => r.ply === branch.base);
    const lines = [
      ...(atBase?.mate ? [{ pv: atBase.mate.pv, score: atBase.score }] : []),
      ...(atBase?.candidates || []),
    ];
    const matching = lines.find((l) =>
      branch.moves.slice(0, branch.at).every((m, i) => l.pv[i] === m.usi),
    );
    if (matching) {
      const pv = matching.pv.slice(branch.at),
        move = pv[0] ? position.createMoveByUSI(pv[0]) : null;
      branchRow = {
        label: "おすすめ",
        text: move ? moveText(formatMove(position, move)) : "読み筋はここまで",
        pv,
        reading: readingText(position, pv),
        move,
        score: matching.score,
        game: false,
      };
    }
  }
  if (branch && rtResult) {
    branchRow = candidateRows(position, rtResult, undefined, self, own)[0];
    if (branchRow) branchRow.reading = readingText(position, branchRow.pv);
    else
      branchRow = {
        label: "分岐",
        text: "読み筋はここまで",
        move: null,
        pv: [],
        score: rtResult.score,
        game: false,
      };
  }
  if (rtBusy) branchRow = undefined;
  const shownScore = branch ? branchRow?.score : shown?.score;
  const value = cp(shownScore);
  const comparablePly = branch ? branch.base + branch.at : -1;
  const comparable =
    branchRow && analysis?.saved && !analysis.attempt && comparablePly <= total
      ? results.find((r) => r.ply === comparablePly)
      : undefined;
  const previousResult = results.find((r) => r.ply === ply - 1);
  const textBefore = scoreText(previousResult?.score, self),
    textAfter = scoreText(shownScore, self);
  const deltaText =
    previousResult?.score?.kind === "cp" && shownScore?.kind === "cp"
      ? signed(
          ((cp(shownScore) || 0) - (cp(previousResult.score) || 0)) *
            (self === Color.BLACK ? 1 : -1),
        )
      : "";
  let recommendation = "";
  const best = previousResult?.candidates[0]?.move;
  if (
    !branch &&
    !over &&
    point?.mark &&
    point.mark !== "好手" &&
    best &&
    last &&
    best !== last.usi
  ) {
    const beforePosition = position.clone();
    beforePosition.undoMove(last);
    recommendation = previousResult?.mate
      ? `${previousResult.mate.plies}手詰めあり`
      : `${own && last.color === self ? "おすすめは" : "最善は"} ${readingText(beforePosition, [best])[0] || ""}`;
  }
  const winner = game.winner || gameOutcome(record);
  const winnerColor =
    winner === "black" ? Color.BLACK : winner === "white" ? Color.WHITE : null;
  const resultLabel =
    winnerColor !== null
      ? `${own ? (winnerColor === self ? "あなた" : "相手") : winnerColor === Color.BLACK ? "先手" : "後手"}の勝ち`
      : winner === "draw"
        ? "引き分け"
        : "結果は不明";
  const evaluationLabel = over
    ? `${total}手で${resultLabel}`
    : ply > 0 && shown
      ? textBefore === textAfter && textAfter.endsWith("以上")
        ? textAfter
        : `${textBefore} → ${textAfter}`
      : textAfter;
  const chance =
    over && winnerColor !== null
      ? winnerColor === self
        ? 100
        : 0
      : over || value === null
        ? null
        : percent((self === Color.BLACK ? 1 : -1) * value);
  const favored = over
    ? winnerColor
    : value === null || Math.abs(value) < 150
      ? null
      : value > 0
        ? Color.BLACK
        : Color.WHITE;
  const stateLabel = analysis?.attempt
    ? needsRetryConfirmation(analysis.attempt)
      ? "要確認"
      : offline
        ? "中断中"
        : analysis.attempt.job?.status === "queued"
          ? "解析待ち"
          : "解析中"
    : analysis?.saved && shown
      ? "解析済み"
      : "未解析";
  const advantage = over
    ? resultLabel
    : value === null
      ? stateLabel
      : Math.abs(value) < 150
        ? "ほぼ互角"
        : `${value > 0 === (self === Color.BLACK) ? (own ? "あなた" : "先手") : own ? "相手" : "後手"}が${Math.abs(value) < 450 ? "やや有利" : Math.abs(value) < 1000 ? "有利" : Math.abs(value) < 2000 ? "優勢" : "勝勢"}`;
  function start(mode: Mode, confirmed = false) {
    const run = () => {
      const { offline, quota } = controller.snapshot;
      if (
        needsRetryConfirmation(controller.snapshot.records[id]?.attempt) &&
        !confirmed
      ) {
        ask({
          title: "前回の依頼の結果が分かりません",
          text: "保存期間が過ぎている可能性があります。もう一度解析すると、今週の回数を新たに使うことがあります。",
          ok: "もう一度解析する",
          no: "やめる",
          onOk: () => start(mode, true),
        });
        return;
      }
      if (offline) {
        ask({
          title: "通信できません",
          image: "sys-offline",
          text: "つながってから、もう一度お試しください。保存済みの棋譜と解析結果は見られます。",
          ok: "もう一度試す",
          onOk: () => {
            void controller.sync().then(() => {
              if (!controller.snapshot.offline) start(mode, confirmed);
              else toast("通信できません。つながってからお試しください");
            });
          },
          no: "閉じる",
        });
        return;
      }
      if (
        quota &&
        (quota.totalRemaining === 0 ||
          (mode === "precise" && quota.preciseRemaining === 0))
      ) {
        ask({
          title:
            mode === "precise" && quota.totalRemaining > 0
              ? "今週の精密解析は使い切りました"
              : "今週の解析は使い切りました",
          image: "sys-limit",
          text: `月曜の午前0時（日本時間）に、また使えます。次の更新：${new Date(quota.resetsAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}。${quota.totalRemaining > 0 ? "ふつうの解析は使えます。" : "保存済みの結果は見られます。"}`,
          ok: quota.totalRemaining > 0 ? "ふつうで解析する" : "閉じる",
          single: quota.totalRemaining === 0,
          onOk:
            quota.totalRemaining > 0
              ? () => start("std", confirmed)
              : undefined,
        });
        return;
      }
      clearBranchUndo();
      setBranch(null);
      clear();
      void controller
        .start(id, analysisInput(record!, mode), confirmed)
        .catch((e) =>
          toast(e instanceof Error ? e.message : "解析を依頼できませんでした"),
        );
    };
    run();
  }
  function tryRow(row: CandidateRow) {
    if (row.move) commit(row.move);
  }
  const isFavorite = !!(favorite ?? game.favorite);
  async function fav() {
    setSheet(null);
    try {
      await toggleFavorite(db, { ...game!, favorite: +isFavorite });
      setFavorite(isFavorite ? 0 : 1);
      toast(isFavorite ? "お気に入りから外しました" : "お気に入りに入れました");
    } catch {
      toast("お気に入りを保存できませんでした");
    }
  }
  function remove() {
    setSheet(null);
    ask({
      title: "この棋譜を削除しますか",
      text: "解析結果と、AIコーチの解説・質問の履歴もいっしょに消えます。戦績からも外れます。元には戻せません。使った回数は戻りません。",
      ok: "削除する",
      danger: true,
      onOk: async () => {
        try {
          if (controller.snapshot.records[id]?.attempt) {
            await controller.cancel(id);
            if (controller.snapshot.records[id]?.attempt) {
              toast(
                "通信できないため中止を確認できません。つながってから削除してください",
              );
              return;
            }
          }
          if (coach.controller.snapshot.records[id]?.attempt) {
            await coach.controller.cancel(id);
            if (coach.controller.snapshot.records[id]?.attempt) {
              toast(
                "通信できないためAIコーチの中止を確認できません。つながってから削除してください",
              );
              return;
            }
          }
          await deleteGame(db, id);
          router.dismissTo("/");
          toast("削除しました");
        } catch {
          toast("削除できませんでした。もう一度お試しください");
        }
      },
    });
  }
  const date = dateParts(game.played_at);
  const plyLabel = (n: number) => (n ? `${n}手目` : "開始局面");
  const evalHelp = (
    <Pressable
      accessibilityRole="button"
      onPress={() => setSheet("evaluation")}
      hitSlop={{ top: 10, bottom: 10, left: 5, right: 5 }}
    >
      <Text
        style={[
          font(700, 10.5, 1.3, colors.ink2),
          { textDecorationLine: "underline", textDecorationStyle: "dotted" },
        ]}
      >
        評価値
      </Text>
    </Pressable>
  );
  return (
    <Screen bottom>
      <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
        <View
          onLayout={(e) =>
            setCoachFullTop(
              e.nativeEvent.layout.y + e.nativeEvent.layout.height + 2,
            )
          }
          style={[s.hd, { height: 42 + u * 0.4 }]}
        >
          <RoundButton
            icon="prev"
            label="戻る"
            onPress={() =>
              branch
                ? leaveBranch()
                : router.canGoBack()
                  ? router.back()
                  : router.replace("/")
            }
          />
          <View style={{ flex: 1, gap: 3 }}>
            <View style={s.wl}>
              <Text style={font(700, 10.5)}>
                {own ? "あなた" : sideOf(self)}
                {chance !== null && !over ? ` ${chance}%` : ""}
              </Text>
              <View
                style={[
                  s.jg,
                  {
                    backgroundColor:
                      favored === null
                        ? colors.white
                        : favored === self
                          ? colors.you
                          : colors.opp,
                  },
                ]}
              >
                <Text style={font(900, 10.5)}>
                  {branch && rtBusy
                    ? "解析中"
                    : branch && value === null
                      ? "分岐中"
                      : advantage}
                </Text>
              </View>
              <Text style={font(700, 10.5)}>
                {chance !== null && !over ? `${100 - chance}% ` : ""}
                {own
                  ? "相手"
                  : sideOf(self === Color.BLACK ? Color.WHITE : Color.BLACK)}
              </Text>
            </View>
            <ChanceBar
              chance={chance}
              terminal={over}
              visible={focused}
              label={
                over && winnerColor !== null
                  ? resultLabel
                  : chance === null
                    ? "形勢はまだ分かりません"
                    : `${own ? "あなた" : sideOf(self)}の勝率 ${chance}%`
              }
            />
          </View>
          <RoundButton
            icon="more"
            label="この対局のメニュー"
            onPress={() => setSheet("menu")}
          />
        </View>
        <View style={s.sp} />
        <View
          style={[
            s.nmr,
            { height: 21 + u * 0.2, opacity: coachOpen && coachFull ? 0 : 1 },
          ]}
        >
          <PlayerName
            name={nameOf(top)}
            color={top}
            turn={!over && position.color === top}
            bottom={false}
          />
          {branch && (
            <RealtimeToggle state={rt} toggle={() => rtController.toggle()} />
          )}
        </View>
        <Board
          position={position}
          bottom={bottom}
          selected={selected}
          moves={promotion.length ? [] : moves}
          onSquare={square}
          onHand={hand}
          last={last}
          promotion={promotion}
          onPromote={commit}
          over={over}
          arrow={
            branch
              ? branchRow?.move
              : !over && analysis?.saved && !analysis.attempt
                ? rows[candidate]?.move
                : null
          }
          mark={!branch ? point?.mark : undefined}
          label={`${branch ? `分岐${at}手目` : plyLabel(ply)}の盤面`}
        />
        <View
          onLayout={(e) =>
            setCoachTop(
              e.nativeEvent.layout.y + e.nativeEvent.layout.height + 3,
            )
          }
          style={[s.nmr, { height: 21 + u * 0.2, justifyContent: "flex-end" }]}
        >
          {branch && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="本譜に戻る"
              onPress={leaveBranch}
              hitSlop={{ top: 9, bottom: 9, left: 4, right: 4 }}
              style={s.brl}
            >
              <Icon name="undo" size={12} strokeWidth={2.2} />
              <Text style={font(900, 11)}>
                本譜（{plyLabel(branch.base)}）に戻る
              </Text>
            </Pressable>
          )}
          <PlayerName
            name={nameOf(bottom)}
            color={bottom}
            turn={!over && position.color === bottom}
            bottom
          />
        </View>
        <View style={s.sp} />
        <View
          style={[
            s.ct,
            { paddingTop: 2 + u * 0.2, paddingBottom: 6 + u * 0.2 },
          ]}
        >
          <RoundButton
            size={cb}
            warn={!!branch}
            icon={branch ? "undo" : "first"}
            label={branch ? "本譜に戻る" : "最初へ"}
            onPress={() => (branch ? leaveBranch() : step(0))}
          />
          <RoundButton
            size={cb}
            icon="prev"
            label="1手戻る"
            disabled={at === 0}
            onPress={() => step(at - 1)}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="棋譜を開く"
            onPress={() => {
              setMovesRow(null);
              setSheet("moves");
            }}
            style={({ pressed }) => [
              s.now,
              { height: cb },
              branch && { backgroundColor: colors.mintSoft },
              pressed && { transform: [{ translateY: 2 }], boxShadow: "none" },
            ]}
          >
            <Text style={font(700, 10.5, 1, colors.ink2)}>
              {branch ? `分岐${at}手目` : plyLabel(ply)}
            </Text>
            <Text
              numberOfLines={1}
              style={[font(900, 15 + u * 0.12), { flexShrink: 1 }]}
            >
              {!last
                ? ""
                : branch
                  ? branchText(at - 1)
                  : mainText(record.current)}
            </Text>
            <Icon name="down" size={14} strokeWidth={2.6} />
          </Pressable>
          <RoundButton
            size={cb}
            icon="next"
            label="1手進む"
            disabled={at >= end}
            onPress={() => step(at + 1)}
          />
          <RoundButton
            size={cb}
            icon="last"
            label="最後へ"
            disabled={at >= end}
            onPress={() => step(end)}
          />
        </View>
        <View style={s.sp} />
        <AnalysisPanel
          onCoach={() => {
            clear();
            setCoachFull(false);
            setCoachOpen(true);
          }}
          analysis={analysis}
          received={!!shown}
          branch={!!branch}
          branchRow={branchRow}
          realtime={rt}
          retryRealtime={rtController.retry}
          toggleRealtime={() => rtController.toggle()}
          rows={rows}
          selected={candidate}
          onSelect={(i) => {
            setCandidate(i);
            clear();
          }}
          onTry={tryRow}
          self={self}
          u={u}
          start={start}
          ending={over ? `${total}手で${resultLabel}` : undefined}
        />
        <View style={s.sp} />
        <View
          style={[
            s.gc,
            { maxHeight: 29 + u * 0.3 + Math.min(0.4 * W, 0.18 * H) },
          ]}
        >
          <View style={[s.ro, { height: 20 + u * 0.3 }]}>
            {branch ? (
              <>
                <View style={s.bk}>
                  <Text style={font(900, 10.5)}>分岐 {at}手目</Text>
                </View>
                {branchRow && evalHelp}
                <Text
                  style={font(
                    branchRow ? 900 : 700,
                    branchRow ? 12.5 : 10.5,
                    1,
                    branchRow ? colors.ink : colors.ink2,
                  )}
                >
                  {branchRow
                    ? scoreText(shownScore, self)
                    : rtBusy
                      ? "解析中…"
                      : rt.paid === false
                        ? "評価値は出ません"
                        : !rt.enabled
                          ? "分岐中の解析はオフ"
                          : rt.status === "offline"
                            ? "通信できないため、評価値は出ません"
                            : rt.status === "limit"
                              ? "今月の分岐中の解析は残り0分"
                              : "評価値 —"}
                </Text>
                {comparable?.score ? (
                  <>
                    <Text style={font(700, 10.5, 1.3, colors.ink2)}>
                      本譜の{comparablePly}手目は
                    </Text>
                    <Text style={font(900, 12.5, 1.3)}>
                      {scoreText(comparable.score, self)}
                    </Text>
                  </>
                ) : branchRow && !rtResult ? (
                  <Text style={font(700, 10.5, 1.3, colors.ink2)}>
                    保存した読み筋
                  </Text>
                ) : null}
              </>
            ) : (
              <>
                {over || (shown && !ply) ? (
                  <Text style={font(700, 10.5, 1, colors.ink2)}>
                    {over ? "終局" : "開始局面"}
                  </Text>
                ) : (
                  evalHelp
                )}
                <Text style={font(900, 12.5)}>{evaluationLabel}</Text>
                <Text style={font(700, 10.5, 1, colors.ink2)}>
                  {over
                    ? ""
                    : value === null
                      ? analysis?.attempt
                        ? needsRetryConfirmation(analysis.attempt)
                          ? "前回の依頼を確認してください"
                          : analysis.attempt.job?.status === "queued"
                            ? "順番が来たら解析します"
                            : offline
                              ? "通信が戻ると、続きから再開します"
                              : "アプリを閉じても解析は続きます"
                        : "まだ解析していません"
                      : point?.mark === "好手"
                        ? "好手！"
                        : deltaText}
                </Text>
                {recommendation && (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => jumpMain(ply - 1)}
                  >
                    <Text style={font(900, 10.5, 1, colors.ink2)}>
                      {recommendation} ›
                    </Text>
                  </Pressable>
                )}
              </>
            )}
          </View>
          <EvalGraph
            ply={ply}
            total={total}
            points={evaluated}
            sign={self === Color.BLACK ? 1 : -1}
            phases={phases}
            labels={own ? ["あなた", "相手"] : ["先手", "後手"]}
            branch={
              branch ? { base: branch.base, at: branch.at, value } : undefined
            }
            onPly={jumpMain}
          />
        </View>
        <View style={s.spb} />
      </ScrollView>
      {coachOpen && (
        <CoachSheet
          game={game}
          onFullChange={setCoachFull}
          halfTop={coachTop}
          fullTop={coachFullTop}
          onClose={() => setCoachOpen(false)}
          ply={ply}
          branch={!!branch}
          start={() => start("precise")}
          jump={jumpMain}
          tryLine={(p, pv) => {
            clearBranchUndo();
            record.goto(p);
            const next = new Branch(p, record.position);
            for (const usi of pv) {
              const m = next.position.createMoveByUSI(usi);
              if (!m || !next.position.isValidMove(m)) break;
              next.play(m);
            }
            next.step(Math.min(1, next.moves.length));
            setPly(p);
            setBranch(next);
            clear();
          }}
        />
      )}
      {sheet === "moves" && (
        <Sheet
          visible
          title={
            branch
              ? "分岐の手順"
              : `棋譜（${date ? `${date.m}/${date.d}・` : ""}${total}手）`
          }
          onClose={() => setSheet(null)}
          scrollRow={movesRow}
        >
          {branch ? (
            <>
              <View style={s.mrh}>
                <Text style={[font(700, 11.5, 1.4, colors.ink2), { flex: 1 }]}>
                  {plyLabel(branch.base)}
                  から分かれた手順です。本譜と戦績は変わりません。
                </Text>
                <Button
                  size="sm"
                  onPress={() => {
                    setSheet(null);
                    leaveBranch();
                  }}
                >
                  本譜に戻る
                </Button>
              </View>
              {branch.moves.map((m, i) => (
                <Pressable
                  key={i}
                  accessibilityRole="button"
                  aria-selected={i + 1 === at}
                  onLayout={
                    i + 1 === at
                      ? (e) => setMovesRow(e.nativeEvent.layout)
                      : undefined
                  }
                  onPress={() => {
                    setSheet(null);
                    step(i + 1);
                  }}
                  style={[
                    s.mr,
                    i + 1 === at && { backgroundColor: colors.you },
                  ]}
                >
                  <Text style={s.mn}>{i + 1}</Text>
                  <Text style={font(700, 13.5, 1.2)}>{branchText(i)}</Text>
                </Pressable>
              ))}
            </>
          ) : (
            // shortcut: 全手を一度に描く。数千手の棋譜で開くのが遅ければ FlatList にする
            [null, ...mainMoves].map((n, i) => {
              const score = results.find((r) => r.ply === i)?.score;
              return (
                <Pressable
                  key={i}
                  accessibilityRole="button"
                  aria-selected={i === ply}
                  onPress={() => jumpMain(i)}
                  onLayout={
                    i === ply
                      ? (e) => setMovesRow(e.nativeEvent.layout)
                      : undefined
                  }
                  style={[s.mr, i === ply && { backgroundColor: colors.you }]}
                >
                  <Text style={s.mn}>{i || ""}</Text>
                  <Text style={font(700, 13.5, 1.2)}>
                    {n ? mainText(n) : "開始局面"}
                  </Text>
                  <Text style={[font(900, 10, 1.2), { marginLeft: "auto" }]}>
                    {evaluated[i]?.mark ||
                      (evaluated[i]?.mate ? "詰みあり" : "")}
                  </Text>
                  {score && (
                    <Text style={font(700, 11, 1.2, colors.ink2)}>
                      {scoreText(score, self)}
                    </Text>
                  )}
                </Pressable>
              );
            })
          )}
        </Sheet>
      )}
      <Sheet
        auto
        visible={sheet === "menu"}
        title="この対局"
        onClose={() => setSheet(null)}
      >
        <MenuRow
          first
          icon="star"
          tone={isFavorite ? "on" : undefined}
          label={isFavorite ? "お気に入りから外す" : "お気に入りに入れる"}
          onPress={() => void fav()}
        />
        <MenuRow
          icon="info"
          label="対局情報"
          sub="対局者・結果・戦法と囲い（修正もここから）"
          onPress={() => {
            setSheet(null);
            router.push({ pathname: "/info", params: { id } });
          }}
        />
        {!own && (
          <MenuRow
            icon="refresh"
            label="盤の向きを変える"
            sub={`いまは${sideOf(bottom)}の側から見ています`}
            onPress={() => {
              setSheet(null);
              setFlipped(!flipped);
              clear();
            }}
          />
        )}
        <MenuRow
          icon="export"
          label="KIFを書き出す"
          sub={
            Platform.OS === "web"
              ? "コピー・ファイルに保存"
              : "コピー・ファイルに保存・共有"
          }
          onPress={() => setSheet("export")}
        />
        <MenuRow
          icon="trash"
          tone="danger"
          label="この棋譜を削除"
          onPress={remove}
        />
      </Sheet>
      <EvaluationHelp
        visible={sheet === "evaluation"}
        close={() => setSheet(null)}
        you={own ? "あなた" : sideOf(self)}
        opponent={own ? "相手" : "後手"}
      />
      <ExportSheet
        visible={sheet === "export"}
        onClose={() => setSheet(null)}
        id={id}
        kif={game.kif}
      />
    </Screen>
  );
}
const s = StyleSheet.create({
  sp: { flex: 1 },
  spb: { flexGrow: 1.5, flexShrink: 1, flexBasis: 10, minHeight: 10 },
  hd: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
  },
  wl: {
    height: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
  },
  jg: {
    // 高さ16の行からはみ出す分（18.5−16）。上下の余白で高さを作ると Android では文字の行が縮められて切れる
    height: 18.5,
    marginVertical: -1.25,
    justifyContent: "center",
    paddingHorizontal: 8,
    borderWidth: line.thin,
    borderColor: colors.ink,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
  },
  nmr: { flexDirection: "row", alignItems: "center", paddingHorizontal: 4 },
  id: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    maxWidth: "52%",
    paddingVertical: 1,
    borderWidth: line.thin,
    borderColor: "transparent",
    borderRadius: radius.pill,
  },
  av: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: line.thin,
    borderColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  brl: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    height: 19,
    marginRight: "auto",
    paddingLeft: 5,
    paddingRight: 7,
    borderWidth: line.thin,
    borderColor: colors.ink,
    borderRadius: radius.pill,
    backgroundColor: colors.coralSoft,
  },
  ct: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 12,
  },
  now: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingHorizontal: 6,
    borderWidth: line.ol,
    borderColor: colors.ink,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
    boxShadow: shadow.small,
  },
  gc: {
    flexGrow: 1000,
    flexShrink: 0,
    flexBasis: 112,
    marginTop: 5,
    marginHorizontal: 12,
    paddingTop: 4,
    paddingHorizontal: 5,
    paddingBottom: 1,
    backgroundColor: colors.white,
    borderWidth: line.ol,
    borderColor: colors.ink,
    borderRadius: radius.card,
    boxShadow: shadow.card,
  },
  ro: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 5,
    overflow: "hidden",
  },
  bk: {
    height: 18.5,
    justifyContent: "center",
    paddingHorizontal: 7,
    borderWidth: line.thin,
    borderColor: colors.ink,
    borderRadius: radius.pill,
    backgroundColor: colors.mintSoft,
  },
  mr: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: 10,
    borderRadius: 10,
  },
  mn: {
    ...font(700, 11, 1.2, colors.ink2),
    width: 30,
    fontVariant: ["tabular-nums"],
  },
  mrh: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginHorizontal: 2,
    marginBottom: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: line.thin,
    borderStyle: "dashed",
    borderColor: colors.dash,
    borderRadius: 12,
  },
});
