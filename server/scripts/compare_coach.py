#!/usr/bin/env python3
"""匿名化資料でLLMを直接比較する。Workerには接続せず、予算を共有台帳で制限する。"""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import math
import os
import re
from pathlib import Path
import statistics
import sys
import time
import uuid
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener

PROVIDERS = {
    "openai": ("https://api.openai.com/v1/chat/completions", "gpt-6-luna", "OPENAI_API_KEY", "max_completion_tokens"),
    "deepseek": ("https://api.deepseek.com/chat/completions", "deepseek-flash", "DEEPSEEK_API_KEY", "max_tokens"),
}
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'container'))
from coach_facts import build_facts

PROMPT = Path(__file__).resolve().parents[1] / "src/coach-prompt.txt"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # 認証ヘッダーを別ホストへ転送しない。


def references(results):
    refs = []
    for r in results:
        refs.append({"id": f'{r["ply"]}:position', "ply": r["ply"], "score": r["score"], "pv": [], "provenMate": False})
        for c in r["candidates"]:
            if c.get("pv"):
                refs.append({"id": f'{r["ply"]}:candidate:{c["rank"]}', "ply": r["ply"], "score": c["score"], "pv": c["pv"], "provenMate": False})
        if r.get("mate"):
            refs.append({"id": f'{r["ply"]}:mate', "ply": r["ply"], "score": None, "pv": r["mate"]["pv"], "provenMate": True})
    return refs


def prose(value):
    return re.sub(r'(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])', '（指し手は参照で確認）', value)


def body(payload, provider, prompt=None, reasoning_effort="none", max_tokens=2000, api="chat"):
    _, model, _, token_parameter = PROVIDERS[provider]
    a = payload["analysis"]
    data = {"facts": build_facts({"initial": a["initial"], "moves": a["moves"], "results": a["results"], "perspective": payload["perspective"]}),
            "perspective": payload["perspective"], "profile": {"practice": [prose(p) for p in payload["profile"].get("practice", [])], "goal": prose(payload["profile"].get("goal", ""))}, "style": payload["style"],
            "history": [{"role": h["role"], "content": prose(h["content"])} for h in payload["history"]], "question": prose(payload.get("question", "対局を振り返ってください"))}
    messages = [{"role": "system", "content": PROMPT.read_text() if prompt is None else prompt},
                {"role": "user", "content": json.dumps(data, ensure_ascii=False, separators=(",", ":"))}]
    if api == "responses":
        return {"model": model, "input": messages, "stream": False, "reasoning": {"effort": reasoning_effort},
                "text": {"format": {"type": "json_object"}}, "max_output_tokens": max_tokens}
    return {"model": model, "messages": messages, "stream": False, "reasoning_effort": reasoning_effort,
            "response_format": {"type": "json_object"}, token_parameter: max_tokens}


def cost_usage(data, api):
    usage = data["usage"]
    if api == "responses":
        return {"prompt_tokens": usage["input_tokens"], "completion_tokens": usage["output_tokens"],
                "prompt_tokens_details": usage.get("input_tokens_details")}
    return usage


def cost_usd(usage, prices):
    """usageが欠けた呼び出しを無料扱いにしない。キャッシュ書込の内訳があれば別単価。"""
    incoming, outgoing = usage["prompt_tokens"], usage["completion_tokens"]
    details = usage.get("prompt_tokens_details") or {}
    cached = usage.get("prompt_cache_hit_tokens", details.get("cached_tokens", 0))
    written = details.get("cache_write_tokens", 0)
    if any(type(n) is not int or n < 0 for n in (incoming, outgoing, cached, written)) or cached + written > incoming:
        raise ValueError("使用トークン数が不正です")
    return ((incoming - cached - written) * prices[0] + cached * prices[1] + outgoing * prices[2] + written * prices[3]) / 1_000_000


def reserve_usd(request_body, prices):
    # shortcut: tokenizer依存を避けUTF-8全バイト数+余裕を入力上限にする。巨大入力の比較時は公式tokenizerへ。
    incoming = len(json.dumps(request_body, ensure_ascii=False).encode()) + 4096
    outgoing = request_body.get("max_output_tokens", request_body.get("max_completion_tokens", request_body.get("max_tokens", 2000)))
    return (incoming * max(prices[0], prices[1], prices[3]) + outgoing * prices[2]) / 1_000_000


def ledger_total(events):
    amounts = {}
    for event in events:
        amounts[event["id"]] = event["usd"]
    return sum(amounts.values())


def append_event(ledger, event):
    ledger.seek(0, os.SEEK_END)
    ledger.write(json.dumps(event) + "\n")
    ledger.flush()
    os.fsync(ledger.fileno())


def save(path, result):
    temporary = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=PROVIDERS)
    parser.add_argument("--request-file", type=Path, help="単一POST本文、または [{name,payload}] の比較ケース")
    parser.add_argument("--output", type=Path, help="応答も含め0600で逐次保存。既存ファイルは上書きしない")
    parser.add_argument("--prompt-file", type=Path, default=PROMPT)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--openai-api", choices=["chat", "responses"], default="chat")
    parser.add_argument("--reasoning-effort", choices=["none", "low", "medium", "high", "xhigh", "max"], default="none")
    parser.add_argument("--max-tokens", type=int, default=2000, help="推論を含む出力上限")
    parser.add_argument("--timeout", type=float, default=45, help="ソケット待ち上限（秒）")
    parser.add_argument("--input-usd-per-million", type=float)
    parser.add_argument("--cached-usd-per-million", type=float)
    parser.add_argument("--output-usd-per-million", type=float)
    parser.add_argument("--cache-write-usd-per-million", type=float)
    parser.add_argument("--budget-file", type=Path, help="全提供元・全実験で共用するJSONL台帳（必須）")
    parser.add_argument("--budget-usd", type=float, default=3, help="累計上限。最大3ドル")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        import unittest
        suite = unittest.defaultTestLoader.discover(str(Path(__file__).parent), pattern="test_compare_coach.py")
        if not unittest.TextTestRunner().run(suite).wasSuccessful():
            raise SystemExit(1)
        return
    prices = (args.input_usd_per_million, args.cached_usd_per_million, args.output_usd_per_million,
              args.cache_write_usd_per_million if args.cache_write_usd_per_million is not None else args.input_usd_per_million)
    if not args.provider or not args.request_file or not args.output or not args.budget_file or not 1 <= args.runs <= 20:
        parser.error("provider、request-file、output、budget-file と runs=1〜20 が必要です")
    if any(p is None or not math.isfinite(p) or p < 0 for p in prices) or not 0 < args.budget_usd <= 3:
        parser.error("公式単価（入力・キャッシュ・出力）と budget-usd=0超〜3以下が必要です")
    if not 1 <= args.max_tokens <= 128000 or not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("max-tokens=1〜128000 と正の有限 timeout が必要です")
    if args.provider == "deepseek" and args.reasoning_effort not in ("none", "low", "high", "max"):
        parser.error("DeepSeekの推論量は none/low/high/max を指定してください")
    if args.provider == "openai" and args.cache_write_usd_per_million is None:
        parser.error("OpenAIには公式のキャッシュ書込単価も必要です")
    if args.provider != "openai" and args.openai_api != "chat":
        parser.error("Responses APIの比較はOpenAIだけに対応しています")
    endpoint, model, key_name, _ = PROVIDERS[args.provider]
    if args.openai_api == "responses":
        endpoint = "https://api.openai.com/v1/responses"
    api_key = os.environ.get(key_name)
    if not api_key:
        parser.error(key_name + " を環境変数に設定してください（実行はしていません）")
    payload = json.loads(args.request_file.read_text())
    cases = payload if isinstance(payload, list) else [{"name": args.request_file.stem, "payload": payload}]
    if not cases:
        parser.error("比較ケースが空です")
    prompt = args.prompt_file.read_text()
    result = {"model": model, "promptSHA256": hashlib.sha256(prompt.encode()).hexdigest(),
              "pricesPerMillion": prices, "api": args.openai_api, "reasoningEffort": args.reasoning_effort,
              "maxTokens": args.max_tokens, "timeoutSeconds": args.timeout, "records": []}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # ネットワーク前に上書き禁止を確定する。
    with os.fdopen(os.open(args.output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as output:
        json.dump(result, output)
    args.budget_file.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(args.budget_file, os.O_CREAT | os.O_RDWR | os.O_APPEND, 0o600)
    with os.fdopen(fd, "a+") as ledger:
        fcntl.flock(ledger, fcntl.LOCK_EX)  # 同時起動も同じ予算枠を使う。
        ledger.seek(0)
        events = [json.loads(line) for line in ledger]
        for run in range(args.runs):
            for case in cases:
                request_body = body(case["payload"], args.provider, prompt, args.reasoning_effort, args.max_tokens, args.openai_api)
                user_message = request_body.get("messages", request_body.get("input"))[1]["content"]
                reserved = reserve_usd(request_body, prices)
                if ledger_total(events) + reserved > args.budget_usd:
                    raise SystemExit("次の呼び出しが予算を超える可能性があるため停止しました")
                identity = f"{args.output.resolve()}:{uuid.uuid4()}"
                event = {"id": identity, "usd": reserved, "state": "reserved"}
                append_event(ledger, event)
                events.append(event)
                record = {"case": case["name"], "run": run + 1, "startedAt": datetime.now(timezone.utc).isoformat(),
                          "inputSHA256": hashlib.sha256(user_message.encode()).hexdigest()}
                start = time.monotonic()
                try:
                    request = Request(endpoint, method="POST", data=json.dumps(request_body, ensure_ascii=False).encode(),
                                      headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json", "User-Agent": "kifumate-measurement/1.0"})
                    with build_opener(NoRedirect).open(request, timeout=args.timeout) as response:
                        raw = response.read(8 * 1024 * 1024 + 1)
                        if len(raw) > 8 * 1024 * 1024:
                            raise ValueError("応答上限超過")
                        data = json.loads(raw)
                    record["seconds"] = round(time.monotonic() - start, 3)
                    record["response"] = {k: data[k] for k in ("id", "model", "choices", "usage", "output", "status") if k in data}
                    record["estimatedUSD"] = cost_usd(cost_usage(data, args.openai_api), prices)
                    event = {"id": identity, "usd": record["estimatedUSD"], "state": "settled"}
                    append_event(ledger, event)
                    events.append(event)
                except Exception as error:
                    # 例外本文・HTTPヘッダーは保存しない。usage不明なら予約を残し、自動再試行しない。
                    record.update(seconds=round(time.monotonic() - start, 3), error=type(error).__name__, reservedUSD=reserved)
                    if isinstance(error, HTTPError):
                        record["httpStatus"] = error.code
                result["records"].append(record)
                save(args.output, result)
                print(json.dumps({k: v for k, v in record.items() if k != "response"}), flush=True)
                if "error" in record:
                    raise SystemExit("呼び出し失敗。使用量不明分は台帳の予約を維持して停止しました")
                if record["estimatedUSD"] > reserved or ledger_total(events) > args.budget_usd:
                    raise SystemExit("想定上限を超えた使用量のため停止しました")
    print(json.dumps({"model": model, "medianSeconds": statistics.median(r["seconds"] for r in result["records"]),
                      "runs": len(result["records"]), "totalUSD": sum(r["estimatedUSD"] for r in result["records"])}))


if __name__ == "__main__":
    main()
