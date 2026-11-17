#!/usr/bin/env python3
"""stagingの署名付き精密解析とAIコーチを検証する。実LLMの比較には使わない。"""
import argparse
import json
import os
from pathlib import Path
import time
import uuid
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def call(url, token, method="GET", data=None):
    request = Request(url, method=method, headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", "User-Agent": "kifumate-measurement/1.0"},
                      data=None if data is None else json.dumps(data).encode())
    try:
        with urlopen(request, timeout=90) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw)
        except ValueError:
            raise RuntimeError(f"HTTP {error.code}: JSONではない応答です。接続先の拒否やUser-Agentを確認してください") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--token-file", type=Path, default=Path(".local/coach-device.json"))
    parser.add_argument("--expect", choices=["fake", "unavailable"], required=True)
    parser.add_argument("--request-file", type=Path, default=Path(".local/coach-request.json"))
    args = parser.parse_args()
    token = json.loads(args.token_file.read_text())["token"]
    status, initial_quota = call(args.url + "/v1/coach", token)
    assert status == 200 and initial_quota["paid"], (status, initial_quota)
    if args.request_file.exists():
        payload = json.loads(args.request_file.read_text())
    else:
        sample = json.loads((Path(__file__).resolve().parents[2] / "mock/data/sample-game.json").read_text())
        analysis = {"initial": "startpos", "moves": [p["move"]["usi"] for p in sample["positions"][1:7]], "mode": "precise"}
        status, job = call(args.url + "/v1/jobs", token, "POST", analysis)
        assert status in (200, 202), (status, job)
        deadline = time.monotonic() + 300
        while True:
            status, job = call(args.url + "/v1/jobs/" + job["id"], token)
            assert status == 200 and job["status"] not in ("failed", "cancelled"), job
            if job["status"] == "completed":
                break
            assert time.monotonic() < deadline, "解析待機が上限を超えました"
            time.sleep(2)
        assert job["coachProof"], "署名鍵を設定してから新規の精密解析を行ってください"
        payload = {"analysis": {**analysis, "results": job["results"]}, "proof": job["coachProof"], "perspective": "sente",
                   "profile": {"practice": ["四間飛車"], "goal": "終盤に強くなる"},
                   "style": {"focus": "総合", "detail": "ふつう"}, "history": []}
        args.request_file.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(args.request_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(payload, output, ensure_ascii=False)
    before = initial_quota["quota"]["used"]
    request_id = str(uuid.uuid4())
    started = time.monotonic()
    status, answer = call(args.url + "/v1/coach", token, "POST", {**payload, "requestId": request_id})
    seconds = round(time.monotonic() - started, 3)
    if args.expect == "fake":
        assert status == 200 and answer["sections"], (status, answer)
        assert answer["quota"]["used"] == before + 1
        status, chat = call(args.url + "/v1/coach", token, "POST", {**payload, "requestId": str(uuid.uuid4()), "question": "次に何を練習したらいい？", "history": [{"role": "assistant", "content": answer["sections"][0]["text"]}]})
        assert status == 200 and chat["quota"]["used"] == before + 2, (status, chat)
        status, duplicate = call(args.url + "/v1/coach", token, "POST", {**payload, "requestId": request_id})
        assert status == 409 and duplicate["error"] == "request_exists"
    else:
        assert status == 503 and answer["error"] == "provider_unavailable", (status, answer)
    bad = json.loads(json.dumps(payload))
    bad["analysis"]["results"][0]["score"] = None
    status, tamper = call(args.url + "/v1/coach", token, "POST", {**bad, "requestId": str(uuid.uuid4())})
    assert status == 400 and tamper["error"] == "invalid_proof", (status, tamper)
    cancel_id = str(uuid.uuid4())
    assert call(args.url + "/v1/coach/" + cancel_id, token, "DELETE")[0] == 200
    status, cancelled = call(args.url + "/v1/coach", token, "POST", {**payload, "requestId": cancel_id})
    assert status == 409 and cancelled["error"] == "request_exists"
    _, quota = call(args.url + "/v1/coach", token)
    assert quota["quota"]["used"] == before + (2 if args.expect == "fake" else 0)
    assert quota["quota"]["reserved"] == 0
    print(json.dumps({"provider": args.expect, "seconds": seconds, "positions": len(payload["analysis"]["results"]), "proof": True,
                      "tamperRejected": True, "cancelledUncounted": True, "quota": quota["quota"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
