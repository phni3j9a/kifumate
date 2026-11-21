# SPDX-License-Identifier: GPL-3.0-only
"""USI 中継。外部へは Worker 経由だけで到達させる。棋譜の個人情報は受け取らない。"""
from functools import partial
import json
import os
from pathlib import Path
import queue
import re
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cshogi
from coach_facts import build_facts
from coach_tools import ToolError, call as coach_tool

MAX_MOVES = 512
MAX_TOOL_CALLS = 30
MAX_TOOL_ARGS = 16_000
MAX_TOOL_RESULT = 24_000
MAX_TOOL_BATCH_SECONDS = 3
TOOL_READ_SECONDS = 5
MAX_MATE_SECONDS = 0.75
TOOL_SCHEMAS = {tool['name']: tool['parameters'] for tool in json.loads(Path(__file__).with_name('coach_tools_schema.json').read_text())}
tool_slots = threading.BoundedSemaphore(2)
MODES = {"std": (250, 1, 1), "precise": (1000, 2, 3)}
MAX_REALTIME_SEARCH_MS = 60_000
MOVE = re.compile(r"(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])\Z")


class InvalidInput(ValueError):
    pass


class Superseded(Exception):
    pass


def validate_sfen(sfen):
    """C++ パーサへ渡す前に構造と駒数を検査し、不正入力によるクラッシュを防ぐ。"""
    parts = sfen.split(" ")
    if len(parts) != 4 or parts[1] not in ("b", "w") or not re.fullmatch(r"[1-9][0-9]{0,5}", parts[3]):
        raise InvalidInput()
    ranks = parts[0].split("/")
    if len(ranks) != 9:
        raise InvalidInput()
    counts = {p: 0 for p in "PLNSGBRK"}
    kings = {"K": 0, "k": 0}
    for rank in ranks:
        squares = 0
        tokens = re.findall(r"\+[PLNSBRplnsbr]|[PLNSGBRKplnsgbrk1-9]", rank)
        if "".join(tokens) != rank:
            raise InvalidInput()
        for token in tokens:
            if token.isdigit():
                squares += int(token)
            else:
                p = token[-1]
                counts[p.upper()] += 1
                if p in kings:
                    kings[p] += 1
                squares += 1
        if squares != 9:
            raise InvalidInput()
    if kings != {"K": 1, "k": 1}:
        raise InvalidInput()
    if not parts[2]:
        raise InvalidInput()
    if parts[2] != "-":
        tokens = re.findall(r"([1-9][0-9]?)?([PLNSGBRplnsgbr])", parts[2])
        if "".join(n + p for n, p in tokens) != parts[2] or len({p for _, p in tokens}) != len(tokens):
            raise InvalidInput()
        for n, p in tokens:
            counts[p.upper()] += int(n or 1)
    if any(counts[p] > limit for p, limit in zip("PLNSGBRK", [18, 4, 4, 4, 4, 2, 2, 2])):
        raise InvalidInput()


def prepare(data, *, realtime=False):
    if not isinstance(data, dict) or set(data) != {"initial", "moves", "mode", "ply"}:
        raise InvalidInput()
    initial, moves, mode, ply = (data[k] for k in ("initial", "moves", "mode", "ply"))
    if not isinstance(initial, str) or not isinstance(moves, list) or len(moves) > MAX_MOVES:
        raise InvalidInput()
    if mode not in MODES or type(ply) is not int or not 0 <= ply <= len(moves):
        raise InvalidInput()
    if initial != "startpos":
        validate_sfen(initial)
    board = cshogi.Board() if initial == "startpos" else cshogi.Board(initial)
    if not board.is_ok():
        raise InvalidInput()
    # 全列を先に検証し、不正な後半を含む棋譜を成功扱いにしない。
    target = None
    positions = []
    for i, usi in enumerate(moves):
        if i == ply:
            target = board.sfen()
        if realtime and i < ply:
            positions.append(board.sfen().rsplit(' ', 1)[0])
        if not isinstance(usi, str) or not MOVE.fullmatch(usi):
            raise InvalidInput()
        move = board.move_from_usi(usi)
        if not move or not board.is_legal(move):
            raise InvalidInput()
        board.push(move)
    target = target or board.sfen()
    # 解析対象と同じ局面が過去に3回ある場合だけ千日手。打開後は探索を続ける。
    repetition = realtime and positions.count(target.rsplit(' ', 1)[0]) == 3
    return cshogi.Board(target), initial, moves, mode, ply, repetition


def coach_facts(game, *, include_mate_replies=False):
    if not isinstance(game, dict) or set(game) - {'initial', 'moves', 'results', 'perspective', 'question', 'tags'}:
        raise InvalidInput()
    if 'question' in game and (not isinstance(game['question'], str) or len(game['question']) > 1000):
        raise InvalidInput()
    prepare({'initial': game['initial'], 'moves': game['moves'], 'mode': 'precise', 'ply': 0})
    results = game['results']
    if not isinstance(results, list) or len(results) != len(game['moves']) + 1:
        raise InvalidInput()
    # 読み筋も、生の文字列をcshogiに渡す前に形式を確かめる。提示する部分の合法性はbuild_facts/道具側で検査する。
    for ply, row in enumerate(results):
        if not isinstance(row, dict) or type(row.get('ply')) is not int or row['ply'] != ply:
            raise InvalidInput()
        candidates, mate = row['candidates'], row.get('mate')
        if not isinstance(candidates, list) or len(candidates) > 3:
            raise InvalidInput()
        for source in candidates + ([mate] if mate is not None else []):
            if not isinstance(source, dict) or not isinstance(pv := source['pv'], list) or len(pv) > 128 or any(
                not isinstance(m, str) or not MOVE.fullmatch(m) for m in pv
            ) or source is mate and not pv:
                raise InvalidInput()
        if include_mate_replies and mate is not None:
            branches = mate.get('branches', [])
            if not isinstance(branches, list) or len(branches) > 600 or any(
                not isinstance(b, dict) or not all(isinstance(b.get(k), str) and MOVE.fullmatch(b[k]) for k in ('reply', 'mate'))
                for b in branches
            ):
                raise InvalidInput()
    return build_facts(game, include_mate_replies=include_mate_replies)


def tool_arguments(value, schema):
    """共有宣言で使う型・必須項目・配列上限だけを検査する。"""
    if 'enum' in schema:
        return value in schema['enum']
    match schema.get('type'):
        case 'object':
            props = schema['properties']
            return isinstance(value, dict) and set(schema['required']) <= value.keys() <= props.keys() and all(
                tool_arguments(v, props[k]) for k, v in value.items())
        case 'array':
            return isinstance(value, list) and len(value) <= schema['maxItems'] and all(tool_arguments(v, schema['items']) for v in value)
        case 'string':
            return isinstance(value, str)
        case 'integer':
            return type(value) is int
        case 'boolean':
            return type(value) is bool
        case None:
            return True  # 主張の期待値は型ごとに異なる。


def bounded_mate(board, prev, view, *, deadline):
    # cshogiの探索はGILを解放しないので、時間切れは別プロセスごと止める。
    seconds = min(MAX_MATE_SECONDS, deadline - time.monotonic())
    try:
        if seconds > 0:
            moves = list(map(cshogi.move_to_usi, board.history))
            start = board.copy()
            for _ in moves:
                start.pop()
            child = subprocess.run([sys.executable, str(Path(__file__).with_name('coach_tools.py'))],
                                   input=json.dumps([start.sfen(), moves, prev, view]), text=True, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, timeout=seconds, check=True,
                                   env={**os.environ, 'OPENBLAS_NUM_THREADS': '1'})
            return json.loads(child.stdout)
    except subprocess.TimeoutExpired:
        pass
    return {'状態': '未確認', '注意': '時間上限。詰まないことを証明したわけではない'}


def run_coach_tools(data):
    if not isinstance(data, dict) or set(data) != {'game', 'calls'}:
        raise InvalidInput()
    game, calls = data['game'], data['calls']
    if not isinstance(calls, list) or not 1 <= len(calls) <= MAX_TOOL_CALLS:
        raise InvalidInput()
    deadline = time.monotonic() + MAX_TOOL_BATCH_SECONDS
    facts = coach_facts(game)
    results = []
    for item in calls:
        try:
            if time.monotonic() >= deadline:
                raise ToolError('調査の時間上限に達しました')
            if not isinstance(item, dict) or set(item) != {'name', 'arguments'} or not isinstance(item['name'], str):
                raise ToolError('道具の引数が不正です')
            name, raw = item['name'], item['arguments']
            if name not in TOOL_SCHEMAS or name == 'check_draft':
                raise ToolError('不明な道具です')
            if not isinstance(raw, str) or len(raw.encode()) > MAX_TOOL_ARGS or not tool_arguments(args := json.loads(raw), TOOL_SCHEMAS[name]):
                raise ToolError('道具の引数が不正です')
            result = coach_tool(game, name, args, facts=facts, search=partial(bounded_mate, deadline=deadline))
            if len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode()) > MAX_TOOL_RESULT:
                raise ToolError('結果が大きすぎます。対象を絞って確認してください')
        except ToolError as e:
            result = e.result
        except (ValueError, TypeError, RecursionError):
            result = {'エラー': '道具の引数が不正です'}
        except Exception:
            result = {'エラー': '道具を実行できませんでした'}
        results.append(result)
    return {'results': results}


def score_for_sente(kind, raw, turn, bound=None):
    sign = 1 if turn == cshogi.BLACK else -1
    if kind == "mate" and raw in ("+", "-"):
        value = None
        winner = "sente" if (raw == "+") == (sign == 1) else "gote"
    else:
        value = int(raw) * sign
        winner = None if kind == "cp" else ("sente" if (int(raw) > 0) == (sign == 1) else "gote")
    result = {"kind": kind, "value": value}
    if winner:
        result["winner"] = winner
    if bound:
        result["bound"] = bound if sign == 1 else {"lowerbound": "upperbound", "upperbound": "lowerbound"}[bound]
    return result


def parse_info(line, board):
    tokens = line.split()
    if not tokens or tokens[0] != "info" or "score" not in tokens or "pv" not in tokens or "string" in tokens:
        return None
    try:
        s = tokens.index("score")
        kind, raw = tokens[s + 1:s + 3]
        if kind not in ("cp", "mate"):
            return None
        bound = tokens[s + 3] if tokens[s + 3:s + 4] and tokens[s + 3] in ("lowerbound", "upperbound") else None
        score = score_for_sente(kind, raw, board.turn, bound)
        rank = int(tokens[tokens.index("multipv") + 1]) if "multipv" in tokens else 1
        depth = int(tokens[tokens.index("depth") + 1]) if "depth" in tokens else 0
        copy = cshogi.Board(board.sfen())
        pv = []
        for usi in tokens[tokens.index("pv") + 1:][:128]:
            if not MOVE.fullmatch(usi):
                break
            move = copy.move_from_usi(usi)
            if not move or not copy.is_legal(move):
                break
            copy.push(move)
            pv.append(usi)
        if not pv or not 1 <= rank <= 3:
            return None
        return {"rank": rank, "depth": depth, "score": score, "move": pv[0], "pv": pv}
    except (ValueError, IndexError):
        return None


def mate_proof(board):
    """cshogi の詰み候補を合法手と全応手で再検証し、証明したものだけ返す。"""
    if board.is_check() or board.is_game_over():
        return None
    first = board.mate_move_in_1ply() or board.mate_move(3)
    if not first or not board.is_legal(first):
        return None
    attack = cshogi.Board(board.sfen())
    attack.push(first)
    if not attack.is_check():
        return None
    usi = cshogi.move_to_usi(first)
    replies = list(attack.legal_moves)
    if not replies:
        return {"plies": 1, "pv": [usi], "branches": []}
    branches = []
    for reply in replies:
        line = cshogi.Board(attack.sfen())
        line.push(reply)
        last = line.mate_move_in_1ply()
        if not last or not line.is_legal(last):
            return None
        line.push(last)
        if not line.is_check() or list(line.legal_moves):
            return None
        branches.append({"reply": cshogi.move_to_usi(reply), "mate": cshogi.move_to_usi(last)})
    return {"plies": 3, "pv": [usi, branches[0]["reply"], branches[0]["mate"]], "branches": branches}


# 公式AVX2ターゲット（corei7-avx + BMI1/BMI2）の前提。全vCPUの共通集合で判定する。
AVX2_FLAGS = frozenset("avx avx2 xsave bmi1 bmi2 popcnt ssse3 sse4_1 sse4_2 aes pclmulqdq cx16".split())


def cpu_details(text=None):
    if text is None:
        try:
            text = Path("/proc/cpuinfo").read_text()
        except OSError:
            text = ""
    processors = []
    models = set()
    for block in text.strip().split("\n\n"):
        fields = dict(line.split(":", 1) for line in block.splitlines() if ":" in line)
        fields = {k.strip(): v.strip() for k, v in fields.items()}
        if "model name" in fields:
            models.add(fields["model name"])
        if "processor" in fields:
            processors.append(set(fields.get("flags", "").split()))
    flags = set.intersection(*processors) if processors else set()
    return {"models": sorted(models), "flags": sorted(flags), "avx2Usable": AVX2_FLAGS <= flags}


def selected_engine(cpuinfo=None):
    return "/app/engine-avx2" if cpu_details(cpuinfo)["avx2Usable"] else "/app/engine-compatible"


class Engine:
    def __init__(self, command=None):
        self.process = subprocess.Popen(command or [os.environ.get("ENGINE_PATH") or selected_engine()],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        text=True, bufsize=1)
        self.lines = queue.Queue()
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        try:
            self.send("usi")
            self.until("usiok", 15)
            for name, value in [("EvalDir", os.environ.get("EVAL_DIR", "/app/eval")), ("FV_SCALE", 40),
                                ("USI_Hash", 128), ("BookFile", "no_book"), ("NetworkDelay", 0),
                                ("MinimumThinkingTime", 0), ("EnteringKingRule", "CSARule27")]:
                self.send(f"setoption name {name} value {value}")
            self.mode = None
        except Exception:
            self.close()
            raise

    def _read(self):
        for line in self.process.stdout:
            self.lines.put(line.strip())
        self.lines.put(None)

    def send(self, line):
        self.process.stdin.write(line + "\n")
        self.process.stdin.flush()

    def until(self, prefix, seconds, cancel=None):
        deadline = time.monotonic() + seconds
        lines = []
        stopped = False
        while True:
            if cancel is not None and cancel.is_set() and not stopped:
                self.send('stop')
                stopped = True
            try:
                line = self.lines.get(timeout=min(0.02, max(0.001, deadline - time.monotonic())))
            except queue.Empty:
                if time.monotonic() >= deadline:
                    raise RuntimeError('analysis_timeout')
                continue
            if line is None:
                raise RuntimeError("analysis_unavailable")
            if line.startswith(prefix):
                if stopped or (cancel is not None and cancel.is_set()):
                    raise Superseded()
                return lines + [line]
            lines.append(line)
            if len(lines) > 10000 or time.monotonic() >= deadline:
                raise RuntimeError("analysis_timeout")

    def analyze(self, data, cancel=None, movetime_ms=None):
        board, initial, moves, mode, ply, repetition = prepare(data, realtime=cancel is not None or movetime_ms is not None)
        if repetition:
            if cancel is not None and cancel.is_set():
                raise Superseded()
            result = {"ply": ply, "score": None, "candidates": [], "mate": None}
            if movetime_ms is not None:
                result['terminal'] = True
            return result
        ms, threads, multipv = MODES[mode]
        if movetime_ms is not None:
            ms = movetime_ms
        if self.mode != mode:
            self.send(f"setoption name Threads value {threads}")
            self.send(f"setoption name MultiPV value {multipv}")
            self.send("isready")
            self.until("readyok", 30)
            self.send("usinewgame")
            self.mode = mode
        if cancel is not None and cancel.is_set():
            raise Superseded()
        position = "startpos" if initial == "startpos" else "sfen " + initial
        self.send("position " + position + (" moves " + " ".join(moves[:ply]) if ply else ""))
        self.send(f"go movetime {ms}")
        lines = self.until("bestmove", ms / 1000 + 10, cancel)
        candidates = {}
        for line in lines:
            info = parse_info(line, board)
            if info and info["rank"] <= multipv:
                candidates[info["rank"]] = info
        ordered = [candidates[k] for k in sorted(candidates)]
        # 宣言勝ちは着手でも詰みでもない。bestmove の終端を見て専用結果にする。
        bestmove = lines[-1].split()[1:2]
        if bestmove == ["win"]:
            score = {"kind": "declaration", "value": None, "winner": "sente" if board.turn == cshogi.BLACK else "gote"}
            candidate = {"rank": 1, "depth": 0, "score": score, "declarationWin": True, "pv": []}
            result = {"ply": ply, "score": score, "candidates": [candidate], "mate": None}
            terminal = True
        else:
            game_over = board.is_game_over()
            score = ordered[0]["score"] if ordered else None
            if game_over and board.is_check():
                score = score_for_sente("mate", "0", board.turn)
            terminal = game_over or bestmove in (["resign"], ["none"])
            if not ordered and score is None and not (terminal if movetime_ms is not None else game_over):
                raise RuntimeError("analysis_unavailable")
            result = {"ply": ply, "score": score, "candidates": ordered, "mate": mate_proof(board)}
        if movetime_ms is not None:
            result['terminal'] = terminal
        return result

    def close(self):
        self.process.kill()
        self.process.wait(timeout=5)
        self.reader.join(timeout=1)
        self.process.stdin.close()
        self.process.stdout.close()


engine = None
lock = threading.Lock()
realtime_lock = threading.Lock()
realtime_latest = None
realtime_cancel = None


def replace_search(session, sequence, round_number):
    global realtime_latest, realtime_cancel
    if not isinstance(session, str) or not re.fullmatch(r'[0-9a-f-]{36}', session) or not all(
        type(n) is int and 0 <= n <= 2**53 - 1 for n in (sequence, round_number)
    ):
        raise InvalidInput()
    order = (sequence, round_number)
    with realtime_lock:
        # 次のセッションは destroy 後に別プロセスで開始する。
        if realtime_latest and (realtime_latest[0] != session or order <= realtime_latest[1:]):
            raise Superseded()
        if realtime_cancel is not None:
            realtime_cancel.set()
        realtime_latest = (session, *order)
        realtime_cancel = threading.Event()
        return realtime_cancel


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # 入力やヘッダーをアクセスログへ残さない。

    def do_GET(self):
        self.respond(200 if self.path in ("/health", "/ping") else 404, {"ok": self.path in ("/health", "/ping")})

    def respond(self, status, data):
        body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # 局面変更でクライアントが古いHTTP要求を破棄した。

    def read_tool_body(self, length):
        deadline = time.monotonic() + TOOL_READ_SECONDS
        previous = self.connection.gettimeout()
        body = bytearray()
        try:
            while len(body) < length:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise TimeoutError()
                self.connection.settimeout(left)
                chunk = self.rfile.read1(min(65_536, length - len(body)))
                if not chunk:
                    raise InvalidInput()
                body.extend(chunk)
        finally:
            self.connection.settimeout(previous)
        return json.loads(body)

    def do_POST(self):
        global engine
        deepening = self.path == '/realtime/deepen'
        realtime = deepening or self.path == '/realtime'
        if not realtime and self.path not in ("/analyze", "/coach-facts", "/coach-tools"):
            return self.respond(404, {"error": "not_found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            limit = {"/coach-facts": 1_048_576, "/coach-tools": 2_097_152}.get(self.path, 16384)
            if not 0 < length <= limit:
                return self.respond(413, {"error": "input_too_large"})
            if self.path == "/coach-tools":
                if not tool_slots.acquire(blocking=False):
                    self.close_connection = True
                    return self.respond(503, {"error": "tools_busy"})
                try:
                    data = self.read_tool_body(length)
                except TimeoutError:
                    self.close_connection = True
                    status, result = 408, {"error": "input_timeout"}
                else:
                    status, result = 200, run_coach_tools(data)
                finally:
                    tool_slots.release()
                return self.respond(status, result)
            data = json.loads(self.rfile.read(length))
            if self.path == "/coach-facts":
                return self.respond(200, coach_facts(data, include_mate_replies=True))
            cancel = movetime_ms = None
            if realtime:
                keys = {'initial', 'moves', 'mode', 'ply', 'sessionId', 'sequence'}
                if deepening:
                    keys.update(('round', 'movetimeMs'))
                if not isinstance(data, dict) or set(data) != keys:
                    raise InvalidInput()
                session, sequence = data.pop('sessionId'), data.pop('sequence')
                round_number = 0
                if deepening:
                    round_number, movetime_ms = data.pop('round'), data.pop('movetimeMs')
                    if type(movetime_ms) is not int or not MODES['std'][0] <= movetime_ms <= MAX_REALTIME_SEARCH_MS:
                        raise InvalidInput()
                if data['mode'] != 'std' or data['ply'] != len(data['moves']):
                    raise InvalidInput()
            prepare(data)
            if realtime:
                cancel = replace_search(session, sequence, round_number)
            with lock:
                try:
                    if cancel is not None and cancel.is_set():
                        raise Superseded()
                    if engine is None:
                        engine = Engine()
                    result = engine.analyze(data, cancel, movetime_ms)
                except Superseded:
                    raise
                except Exception:
                    if engine is not None:
                        engine.close()
                        engine = None
                    raise
            self.respond(200, result)
        except Superseded:
            self.respond(409, {'error': 'superseded'})
        except (ValueError, TypeError, KeyError, RecursionError, IndexError, AttributeError):
            self.respond(422, {"error": "invalid_position_or_move"})
        except Exception:
            self.respond(503, {"error": "analysis_unavailable"})


if __name__ == "__main__":
    # PID 1 でも SIGTERM で終了し、プラットフォームの強制停止待ちを避ける。
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    server = ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        if engine is not None:
            engine.close()
