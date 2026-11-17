#!/usr/bin/env python3
"""同じ匿名化資料・指示文でLLMを直接比較する（APIキーが必要、サーバーの月回数は消費しない）。"""
import argparse
import json
import os
from pathlib import Path
import statistics
import time
from urllib.request import Request, urlopen

PROVIDERS = {
    "openai": ("https://api.openai.com/v1/chat/completions", "gpt-6-luna", "OPENAI_API_KEY", "max_completion_tokens"),
    "deepseek": ("https://api.deepseek.com/chat/completions", "deepseek-flash", "DEEPSEEK_API_KEY", "max_tokens"),
}


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


def body(payload, provider):
    _, model, _, token_parameter = PROVIDERS[provider]
    a = payload["analysis"]
    data = {"game": {"initial": a["initial"], "moves": a["moves"]}, "analysis": references(a["results"]),
            "perspective": payload["perspective"], "profile": payload["profile"], "style": payload["style"],
            "history": payload["history"], "question": payload.get("question", "対局を振り返ってください")}
    prompt = (Path(__file__).resolve().parents[1] / "src/coach-prompt.txt").read_text()
    return {"model": model, "messages": [{"role": "system", "content": prompt}, {"role": "user", "content": json.dumps(data, ensure_ascii=False, separators=(",", ":"))}],
            "stream": False, "reasoning_effort": "none", "response_format": {"type": "json_object"}, token_parameter: 2000}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=PROVIDERS)
    parser.add_argument("--request-file", type=Path)
    parser.add_argument("--output", type=Path, help="匿名化した応答も含め0600で保存。既存ファイルは上書きしない")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--input-usd-per-million", type=float)
    parser.add_argument("--cached-usd-per-million", type=float)
    parser.add_argument("--output-usd-per-million", type=float)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        sample = {"analysis": {"initial": "startpos", "moves": [], "results": [{"ply": 0, "score": None, "candidates": [], "mate": None}]},
                  "perspective": "observer", "profile": {"practice": [], "goal": ""}, "style": {"focus": "総合", "detail": "ふつう"}, "history": []}
        assert body(sample, "openai")["max_completion_tokens"] == 2000
        assert body(sample, "deepseek")["max_tokens"] == 2000
        assert references(sample["analysis"]["results"])[0]["id"] == "0:position"
        assert body(sample, "openai")["messages"][0]["content"]
        print("比較スクリプトの自己検査: 成功（ネットワーク未使用）")
        return
    if not args.provider or not args.request_file or not args.output or not 1 <= args.runs <= 20:
        parser.error("provider、request-file、output と runs=1〜20 が必要です")
    endpoint, model, key_name, _ = PROVIDERS[args.provider]
    api_key = os.environ.get(key_name)
    if not api_key:
        parser.error(key_name + " を環境変数に設定してください（実行はしていません）")
    if args.output.exists():
        parser.error("出力ファイルは新しいパスを指定してください")
    payload = json.loads(args.request_file.read_text())
    request_body = json.dumps(body(payload, args.provider), ensure_ascii=False).encode()
    records = []
    for _ in range(args.runs):
        start = time.monotonic()
        request = Request(endpoint, method="POST", data=request_body, headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json", "User-Agent": "kifumate-measurement/1.0"})
        with urlopen(request, timeout=45) as response:
            raw = response.read(131073)
            assert len(raw) <= 131072, "応答上限を超えました"
            data = json.loads(raw)
        seconds = time.monotonic() - start
        usage = data.get("usage", {})
        input_tokens, output_tokens = usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0)
        cached = usage.get("prompt_cache_hit_tokens", usage.get("prompt_tokens_details", {}).get("cached_tokens", 0))
        cost = None
        if all(x is not None for x in (args.input_usd_per_million, args.cached_usd_per_million, args.output_usd_per_million)):
            cost = ((input_tokens - cached) * args.input_usd_per_million + cached * args.cached_usd_per_million + output_tokens * args.output_usd_per_million) / 1_000_000
        record = {"seconds": round(seconds, 3), "usage": usage, "estimatedUSD": cost, "response": data}
        records.append(record)
        print(json.dumps({k: v for k, v in record.items() if k != "response"}), flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(args.output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump({"model": model, "records": records}, output, ensure_ascii=False, indent=2)
    print(json.dumps({"model": model, "medianSeconds": round(statistics.median(r["seconds"] for r in records), 3), "runs": len(records)}))


if __name__ == "__main__":
    main()
