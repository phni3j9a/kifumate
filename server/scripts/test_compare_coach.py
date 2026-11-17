"""比較の費用計算・予算予約・匿名化した送信契約をネットワークなしで検査。"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build_coach_cases import cases_from
from compare_coach import append_event, body, cost_usd, cost_usage, ledger_total, main, references, reserve_usd, save


class ComparisonTest(unittest.TestCase):
    def test_request_matches_worker_contract(self):
        payload = {"analysis": {"initial": "startpos", "moves": [], "results": [{"ply": 0, "score": None, "candidates": [], "mate": None}]},
                   "perspective": "observer", "profile": {"practice": [], "goal": ""}, "style": {"focus": "総合", "detail": "ふつう"}, "history": [], "proof": "送らない", "requestId": "送らない"}
        for provider, parameter in [("openai", "max_completion_tokens"), ("deepseek", "max_tokens")]:
            request = body(payload, provider)
            self.assertEqual(request[parameter], 2000)
            self.assertEqual(request["reasoning_effort"], "none")
            self.assertTrue(request["messages"][0]["content"])
            data = json.loads(request["messages"][1]["content"])
            self.assertEqual(set(data), {"game", "analysis", "perspective", "profile", "style", "history", "question"})
            self.assertEqual(data["analysis"], references(payload["analysis"]["results"]))
            self.assertEqual(data["analysis"][0]["id"], "0:position")
        self.assertEqual(body(payload, "openai", "旧プロンプト")["messages"][0]["content"], "旧プロンプト")

    def test_max_reasoning_and_output_reservation(self):
        payload = {"analysis": {"initial": "startpos", "moves": [], "results": []},
                   "perspective": "observer", "profile": {}, "style": {}, "history": []}
        prices = (0.1, 0.01, 0.5, 0.125)
        for provider, parameter in [("openai", "max_completion_tokens"), ("deepseek", "max_tokens")]:
            request = body(payload, provider, reasoning_effort="max", max_tokens=32768)
            self.assertEqual(request["reasoning_effort"], "max")
            self.assertEqual(request[parameter], 32768)
            self.assertEqual(request["response_format"], {"type": "json_object"})
            smaller = {**request, parameter: 2000}
            input_delta = len(json.dumps(request, ensure_ascii=False).encode()) - len(json.dumps(smaller, ensure_ascii=False).encode())
            self.assertAlmostEqual(reserve_usd(request, prices) - reserve_usd(smaller, prices),
                                   ((32768 - 2000) * prices[2] + input_delta * max(prices[0], prices[1], prices[3])) / 1_000_000)
        # 推論はcompletion_tokensの内数なので、無料扱いも二重加算もしない。
        self.assertEqual(cost_usd({"prompt_tokens": 0, "completion_tokens": 1000,
                                  "completion_tokens_details": {"reasoning_tokens": 900}}, prices), 0.0005)

    def test_responses_api_preserves_input_and_costs_reasoning(self):
        payload = {"analysis": {"initial": "startpos", "moves": [], "results": []},
                   "perspective": "observer", "profile": {}, "style": {}, "history": []}
        request = body(payload, "openai", reasoning_effort="max", max_tokens=65536, api="responses")
        self.assertEqual(request["input"], body(payload, "openai")["messages"])
        self.assertEqual(request["reasoning"], {"effort": "max"})
        self.assertEqual(request["max_output_tokens"], 65536)
        self.assertEqual(request["text"]["format"], {"type": "json_object"})
        self.assertNotIn("messages", request)
        prices = (0.1, 0.01, 0.5, 0.125)
        response = {"usage": {"input_tokens": 1000, "input_tokens_details": {"cached_tokens": 400, "cache_write_tokens": 100},
                              "output_tokens": 200, "output_tokens_details": {"reasoning_tokens": 190}}}
        self.assertAlmostEqual(cost_usd(cost_usage(response, "responses"), prices), 0.0001665)
        self.assertGreater(reserve_usd(request, prices), 65536 * 0.5 / 1_000_000)
        with self.assertRaises(KeyError):
            cost_usage({"usage": {"input_tokens": 1000}}, "responses")

    def test_responses_success_persists_raw_output_and_settles_ledger(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            request, output, ledger = root / "request.json", root / "result.json", root / "budget.jsonl"
            request.write_text(json.dumps({"analysis": {"initial": "startpos", "moves": [], "results": []},
                                           "perspective": "observer", "profile": {}, "style": {}, "history": []}))
            response = {"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": "{}"}]}],
                        "usage": {"input_tokens": 100, "input_tokens_details": {"cache_write_tokens": 80},
                                  "output_tokens": 20, "output_tokens_details": {"reasoning_tokens": 15}}}
            args = ["compare_coach.py", "--provider", "openai", "--openai-api", "responses", "--reasoning-effort", "max",
                    "--request-file", str(request), "--runs", "1", "--output", str(output), "--budget-file", str(ledger),
                    "--input-usd-per-million", "0.1", "--cached-usd-per-million", "0.01",
                    "--output-usd-per-million", "0.5", "--cache-write-usd-per-million", "0.125"]
            with patch.dict("os.environ", {"OPENAI_API_KEY": "test-only-not-a-real-key"}), patch("sys.argv", args), patch("compare_coach.build_opener") as network:
                network.return_value.open.return_value.__enter__.return_value.read.return_value = json.dumps(response).encode()
                main()
            persisted = json.loads(output.read_text())
            self.assertEqual(persisted["api"], "responses")
            self.assertEqual(persisted["records"][0]["response"], response)
            self.assertEqual(network.return_value.open.call_args.args[0].full_url, "https://api.openai.com/v1/responses")
            self.assertAlmostEqual(ledger_total([json.loads(line) for line in ledger.read_text().splitlines()]), 0.000022)

    def test_rebuilt_cases_preserve_positions_and_anonymize(self):
        source = {"initial": "startpos", "moves": ["7g7f"] * 85, "sfens": ["任意の開始局面"] * 86,
                  "results": [{"ply": n, "score": {"kind": "cp", "value": 0}, "candidates": [], "mate": None} for n in range(86)]}
        source["results"][74]["score"] = {"kind": "mate", "value": 9, "winner": "sente"}
        source["results"][80]["mate"] = {"pv": ["7g7f"]}
        declaration = {"initial": "入玉局面", "moves": [], "results": [
            {"ply": 0, "score": {"kind": "declaration", "value": None, "winner": "sente"}, "candidates": [], "mate": None}]}
        cases = cases_from([source, source, declaration])
        self.assertEqual(len(cases), 8)
        self.assertEqual(len(cases[0]["payload"]["analysis"]["results"]), 7)
        for index in (4, 5):
            sliced = cases[index]["payload"]["analysis"]
            self.assertEqual(sliced["moves"], [])
            self.assertEqual(sliced["initial"], "任意の開始局面")
            self.assertEqual(sliced["results"][0]["ply"], 0)
        self.assertEqual(source["results"][80]["ply"], 80)
        self.assertEqual(len(cases[-1]["payload"]["history"]), 2)
        self.assertNotIn("sfens", cases[0]["payload"]["analysis"])
        source["results"][80]["mate"] = None
        with self.assertRaises(AssertionError):
            cases_from([source, source, declaration])

    def test_cost_includes_cache_and_rejects_missing_usage(self):
        prices = (0.1, 0.01, 0.5, 0.125)
        self.assertAlmostEqual(cost_usd({"prompt_tokens": 1000, "completion_tokens": 200, "prompt_tokens_details": {"cached_tokens": 400, "cache_write_tokens": 100}}, prices), 0.0001665)
        self.assertAlmostEqual(cost_usd({"prompt_tokens": 1000, "completion_tokens": 200, "prompt_cache_hit_tokens": 400}, prices), 0.000164)
        with self.assertRaises(KeyError):
            cost_usd({}, prices)
        for usage in [{"prompt_tokens": -1, "completion_tokens": 1}, {"prompt_tokens": 1, "completion_tokens": 1, "prompt_cache_hit_tokens": 2}]:
            with self.assertRaises(ValueError):
                cost_usd(usage, prices)

    def test_reservation_and_settlement_share_budget(self):
        prices = (0.1, 0.01, 0.5, 0.125)
        reserved = reserve_usd({"messages": [{"content": "日本語"}]}, prices)
        self.assertGreater(reserved, 2000 * prices[2] / 1_000_000)
        events = [{"id": "openai", "usd": reserved}, {"id": "deepseek", "usd": 0.2}]
        self.assertAlmostEqual(ledger_total(events), reserved + 0.2)
        events.append({"id": "openai", "usd": 0.01})
        self.assertAlmostEqual(ledger_total(events), 0.21)
        self.assertGreater(ledger_total(events) + reserved, 0.21)  # 次の予約を含めて上限と比較する。

    def test_budget_stops_before_network_and_failure_keeps_reservation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            request = root / "request.json"
            request.write_text(json.dumps({"analysis": {"initial": "startpos", "moves": [], "results": []},
                                           "perspective": "observer", "profile": {}, "style": {}, "history": []}))
            ledger = root / "budget.jsonl"
            output = root / "result.json"
            args = ["compare_coach.py", "--provider", "openai", "--request-file", str(request), "--runs", "1", "--output", str(output),
                    "--budget-file", str(ledger), "--input-usd-per-million", "0.1", "--cached-usd-per-million", "0.01", "--output-usd-per-million", "0.5", "--cache-write-usd-per-million", "0.125"]
            with patch.dict("os.environ", {"OPENAI_API_KEY": "test-only-not-a-real-key"}), patch("sys.argv", args + ["--budget-usd", "0.000001"]), patch("compare_coach.build_opener") as network:
                with self.assertRaisesRegex(SystemExit, "予算"):
                    main()
                network.assert_not_called()
            output.unlink()
            with patch.dict("os.environ", {"OPENAI_API_KEY": "test-only-not-a-real-key"}), patch("sys.argv", args), patch("compare_coach.build_opener") as network:
                network.return_value.open.side_effect = TimeoutError("保存しない内部情報")
                with self.assertRaisesRegex(SystemExit, "呼び出し失敗"):
                    main()
            persisted = json.loads(output.read_text())
            self.assertEqual(persisted["records"][0]["error"], "TimeoutError")
            self.assertNotIn("test-only-not-a-real-key", output.read_text())
            self.assertNotIn("保存しない内部情報", output.read_text())
            events = [json.loads(line) for line in ledger.read_text().splitlines()]
            self.assertGreater(ledger_total(events), 0)
            self.assertEqual(events[-1]["state"], "reserved")

    def test_success_saves_usage_and_settles_shared_ledger(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            request = root / "request.json"
            request.write_text(json.dumps({"analysis": {"initial": "startpos", "moves": [], "results": []},
                                           "perspective": "observer", "profile": {}, "style": {}, "history": []}))
            output, ledger = root / "result.json", root / "budget.jsonl"
            usage = {"prompt_tokens": 100, "completion_tokens": 20, "completion_tokens_details": {"reasoning_tokens": 15}, "prompt_tokens_details": {"cache_write_tokens": 80}}
            args = ["compare_coach.py", "--provider", "openai", "--request-file", str(request), "--runs", "1", "--output", str(output),
                    "--budget-file", str(ledger), "--input-usd-per-million", "0.1", "--cached-usd-per-million", "0.01", "--output-usd-per-million", "0.5", "--cache-write-usd-per-million", "0.125"]
            args += ["--reasoning-effort", "max", "--max-tokens", "32768", "--timeout", "300"]
            with patch.dict("os.environ", {"OPENAI_API_KEY": "test-only-not-a-real-key"}), patch("sys.argv", args), patch("compare_coach.build_opener") as network:
                network.return_value.open.return_value.__enter__.return_value.read.return_value = json.dumps({"usage": usage, "choices": [], "headers": "保存しない"}).encode()
                main()
            persisted = json.loads(output.read_text())
            self.assertEqual(persisted["records"][0]["response"]["usage"], usage)
            self.assertNotIn("headers", persisted["records"][0]["response"])
            events = [json.loads(line) for line in ledger.read_text().splitlines()]
            self.assertEqual([e["state"] for e in events], ["reserved", "settled"])
            self.assertAlmostEqual(ledger_total(events), 0.000022)
            self.assertAlmostEqual(persisted["records"][0]["estimatedUSD"], ledger_total(events))
            self.assertEqual(persisted["reasoningEffort"], "max")
            self.assertEqual(persisted["maxTokens"], 32768)
            self.assertEqual(persisted["timeoutSeconds"], 300)
            self.assertEqual(network.return_value.open.call_args.kwargs["timeout"], 300)
            sent = json.loads(network.return_value.open.call_args.args[0].data)
            self.assertEqual(sent["reasoning_effort"], "max")
            self.assertEqual(sent["max_completion_tokens"], 32768)

    def test_results_and_ledger_persist_without_headers(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "result.json"
            save(path, {"records": [{"estimatedUSD": 0.1}]})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text())["records"][0]["estimatedUSD"], 0.1)
            with (Path(folder) / "budget.jsonl").open("w+") as ledger:
                append_event(ledger, {"id": "attempt", "usd": 0.1})
                ledger.seek(0)
                self.assertEqual(json.loads(ledger.read())["usd"], 0.1)


if __name__ == "__main__":
    unittest.main()
