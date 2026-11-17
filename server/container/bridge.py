# SPDX-License-Identifier: GPL-3.0-only
"""USI 中継。外部へは Worker 経由だけで到達させる。棋譜の個人情報は受け取らない。"""
import json
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cshogi

MAX_MOVES = 512
MODES = {"std": (250, 1, 1), "precise": (1000, 2, 3)}
MOVE = re.compile(r"(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])\Z")


class InvalidInput(ValueError):
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
    if parts[2] != "-":
        tokens = re.findall(r"([1-9][0-9]?)?([PLNSGBRplnsgbr])", parts[2])
        if "".join(n + p for n, p in tokens) != parts[2] or len({p for _, p in tokens}) != len(tokens):
            raise InvalidInput()
        for n, p in tokens:
            counts[p.upper()] += int(n or 1)
    if any(counts[p] > limit for p, limit in zip("PLNSGBRK", [18, 4, 4, 4, 4, 2, 2, 2])):
        raise InvalidInput()


def prepare(data):
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
    for i, usi in enumerate(moves):
        if i == ply:
            target = board.sfen()
        if not isinstance(usi, str) or not MOVE.fullmatch(usi):
            raise InvalidInput()
        move = board.move_from_usi(usi)
        if not move or not board.is_legal(move):
            raise InvalidInput()
        board.push(move)
    return cshogi.Board(target or board.sfen()), initial, moves, mode, ply


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


class Engine:
    def __init__(self, command=None):
        self.process = subprocess.Popen(command or [os.environ.get("ENGINE_PATH", "/app/engine")],
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
                                ("MinimumThinkingTime", 0)]:
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

    def until(self, prefix, seconds):
        deadline = time.monotonic() + seconds
        lines = []
        while True:
            line = self.lines.get(timeout=max(0.001, deadline - time.monotonic()))
            if line is None:
                raise RuntimeError("analysis_unavailable")
            if line.startswith(prefix):
                return lines
            lines.append(line)
            if len(lines) > 10000 or time.monotonic() >= deadline:
                raise RuntimeError("analysis_timeout")

    def analyze(self, data):
        board, initial, moves, mode, ply = prepare(data)
        ms, threads, multipv = MODES[mode]
        if self.mode != mode:
            self.send(f"setoption name Threads value {threads}")
            self.send(f"setoption name MultiPV value {multipv}")
            self.send("isready")
            self.until("readyok", 30)
            self.send("usinewgame")
            self.mode = mode
        position = "startpos" if initial == "startpos" else "sfen " + initial
        self.send("position " + position + (" moves " + " ".join(moves[:ply]) if ply else ""))
        self.send(f"go movetime {ms}")
        lines = self.until("bestmove", ms / 1000 + 10)
        candidates = {}
        for line in lines:
            info = parse_info(line, board)
            if info and info["rank"] <= multipv:
                candidates[info["rank"]] = info
        ordered = [candidates[k] for k in sorted(candidates)]
        score = ordered[0]["score"] if ordered else None
        if board.is_check() and not list(board.legal_moves):
            score = score_for_sente("mate", "0", board.turn)
        if not ordered and score is None and not board.is_game_over():
            raise RuntimeError("analysis_unavailable")
        return {"ply": ply, "score": score, "candidates": ordered, "mate": mate_proof(board)}

    def close(self):
        self.process.kill()
        self.process.wait(timeout=5)
        self.reader.join(timeout=1)
        self.process.stdin.close()
        self.process.stdout.close()


engine = None
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # 入力やヘッダーをアクセスログへ残さない。

    def do_GET(self):
        self.respond(200 if self.path in ("/health", "/ping") else 404, {"ok": self.path in ("/health", "/ping")})

    def respond(self, status, data):
        body = json.dumps(data, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        global engine
        if self.path != "/analyze":
            return self.respond(404, {"error": "not_found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 16384:
                return self.respond(413, {"error": "input_too_large"})
            data = json.loads(self.rfile.read(length))
            prepare(data)
            with lock:
                try:
                    if engine is None:
                        engine = Engine()
                    result = engine.analyze(data)
                except Exception:
                    if engine is not None:
                        engine.close()
                        engine = None
                    raise
            self.respond(200, result)
        except (InvalidInput, ValueError, TypeError, KeyError):
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
