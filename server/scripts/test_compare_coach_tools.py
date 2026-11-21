import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

from compare_coach_tools import Halt, TOOLS, answer, body, bridge_program, budget_event, dumps, http, locked_ledger, unpack, upper, usage_and_cost
from compare_coach import ledger_total

CASE = {'name': 'fake', 'payload': {'analysis': {'initial': 'startpos', 'moves': [], 'results': [{'ply': 0, 'score': None, 'candidates': [], 'mate': None}]},
                                   'perspective': 'sente', 'profile': {'practice': [], 'goal': ''}, 'style': {'focus': '総合', 'detail': 'かんたん'}}}
DRAFT = {'sections': [{'kind': 'facts', 'title': '開始局面', 'text': '開始局面を確認します。', 'refs': ['0:position']}]}


def synthetic(provider, turn):
    if provider == 'neon':
        usage = {'promptTokenCount': 100, 'cachedContentTokenCount': 20, 'toolUsePromptTokenCount': 5,
                 'candidatesTokenCount': 40, 'thoughtsTokenCount': 10, 'totalTokenCount': 155}
        parts = [{'text': 'not part of the answer', 'thought': True}]
        if turn == 3:
            parts.extend([{'text': dumps(DRAFT)[:15]}, {'text': dumps(DRAFT)[15:], 'thoughtSignature': 'opaque3'}])
        else:
            for i in range(turn):
                fn = {'name': 'knowledge', 'args': {'query': '入玉'}, 'id': f'c{turn}-{i}'}
                parts.append({'functionCall': fn, 'thoughtSignature': f'opaque{turn}'} if i == 0 else {'functionCall': fn})
        return {'usageMetadata': usage, 'candidates': [{'content': {'role': 'model', 'parts': parts}, 'finishReason': 'STOP'}],
                'modelVersion': 'gemini-4-neon'}
    if provider == 'terra':
        usage = {'input_tokens': 100, 'output_tokens': 50, 'input_tokens_details': {'cached_tokens': 20, 'cache_write_tokens': 30},
                 'output_tokens_details': {'reasoning_tokens': 10}}
        out = [{'type': 'reasoning', 'id': f'r{turn}', 'encrypted_content': f'encrypted{turn}', 'summary': []}]
        if turn == 3:
            out.append({'type': 'message', 'content': [{'type': 'output_text', 'text': dumps(DRAFT)}]})
        else:
            out.extend({'type': 'function_call', 'name': 'knowledge', 'call_id': f'c{turn}-{i}', 'arguments': '{"query":"入玉"}'} for i in range(turn))
        return {'usage': usage, 'output': out, 'status': 'completed'}
    usage = {'prompt_tokens': 100, 'completion_tokens': 50, 'prompt_cache_hit_tokens': 20, 'completion_tokens_details': {'reasoning_tokens': 9}}
    m = {'role': 'assistant', 'reasoning_content': f'reasoned{turn}', 'content': dumps(DRAFT) if turn == 3 else None}
    if turn < 3:
        m['tool_calls'] = [{'id': f'c{turn}-{i}', 'function': {'name': 'knowledge', 'arguments': '{"query":"入玉"}'}} for i in range(turn)]
    return {'usage': usage, 'choices': [{'message': m, 'finish_reason': 'stop' if turn == 3 else 'tool_calls'}]}


class LoopTests(unittest.TestCase):
    def test_both_protocols_full_replay_and_forced_final(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / 'budget.jsonl'
            bridge = bridge_program(tmp)
            for p in ('deepseek', 'terra'):
                requests = []
                def send(req, timeout):
                    self.assertGreater(timeout, 0)
                    requests.append(req)
                    return synthetic(p, len(requests))
                out = answer(CASE, 1, p, bridge, send, ledger, tool_limit=2)
                self.assertTrue(out['validation']['accepted'], out)
                self.assertEqual(len(out['calls']), 2)
                self.assertEqual(out['turns'][1]['skippedCalls'], 1)
                self.assertEqual(requests[2]['tool_choice'], 'none')
                if p == 'terra':
                    self.assertFalse(requests[0]['store'])
                    self.assertEqual([i['encrypted_content'] for i in requests[2]['input'] if i.get('type') == 'reasoning'], ['encrypted1', 'encrypted2'])
                    self.assertEqual([i['call_id'] for i in requests[2]['input'] if i.get('type') == 'function_call_output'], ['c1-0', 'c2-0', 'c2-1'])
                else:
                    self.assertEqual([i['reasoning_content'] for i in requests[2]['messages'] if i.get('role') == 'assistant'], ['reasoned1', 'reasoned2'])
            with locked_ledger(ledger) as (_, events):
                self.assertEqual([e['state'] for e in events].count('settled'), 6)
                self.assertGreater(ledger_total(events), 0)
            self.assertEqual(ledger.stat().st_mode & 0o777, 0o600)

    def test_budget_failure_keeps_the_reservation(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / 'budget.jsonl'
            budget_event(ledger, 'x', 'reserved', 4.99)
            with self.assertRaisesRegex(Halt, 'budget'):
                budget_event(ledger, 'y', 'reserved', .02)
            budget_event(ledger, 'x', 'settled', .02)
            budget_event(ledger, 'y', 'reserved', 4.97)
            with locked_ledger(ledger) as (_, events):
                self.assertAlmostEqual(ledger_total(events), 4.99)

    def test_provider_costs_include_reasoning_and_cache(self):
        usage, cost = usage_and_cost(synthetic('terra', 1), 'terra')
        self.assertEqual(usage, {'input': 100, 'output': 50, 'cacheRead': 20, 'cacheWrite': 30, 'reasoning': 10})
        self.assertAlmostEqual(cost, (50 + 20 * .05 + 30 * 1.25 + 50 * 5) / 1e6)
        _, cost = usage_and_cost(synthetic('deepseek', 1), 'deepseek')
        self.assertAlmostEqual(cost, (80 * .30 + 20 * .006 + 50 * 1.2) / 1e6)
        self.assertEqual(body('deepseek', [], False, 70)['reasoning_effort'], 'max')
        self.assertEqual(body('terra', [], False, 70)['reasoning']['effort'], 'high')

    def test_neon_body_and_auth(self):
        history = [{'role': 'system', 'content': 'system'}, {'role': 'user', 'content': '相談'}]
        req = body('neon', history, False, 70)
        self.assertEqual(req['systemInstruction'], {'parts': [{'text': 'system'}]})
        self.assertEqual(req['contents'], [{'role': 'user', 'parts': [{'text': '相談'}]}])
        self.assertEqual(req['generationConfig'], {'thinkingConfig': {'thinkingLevel': 'HIGH'}, 'maxOutputTokens': 70,
                                                   'responseMimeType': 'application/json'})
        declared = req['tools'][0]['functionDeclarations']
        self.assertEqual([t['parametersJsonSchema'] for t in declared], [t['parameters'] for t in TOOLS])
        self.assertEqual(req['toolConfig'], {'functionCallingConfig': {'mode': 'AUTO'}})
        with patch('compare_coach_tools.build_opener') as opener:
            opener.return_value.open.return_value.__enter__.return_value = io.BytesIO(b'{}')
            self.assertEqual(http('neon', 'fake-key', req, 1), {})
            sent = opener.return_value.open.call_args.args[0]
            self.assertEqual(sent.full_url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:generateContent')
            self.assertEqual(sent.get_header('X-goog-api-key'), 'fake-key')
            self.assertFalse(sent.has_header('Authorization'))

    def test_neon_replays_whole_contents_and_groups_parallel_results(self):
        requests = []
        responses = [synthetic('neon', turn) for turn in range(1, 4)]
        del responses[1]['candidates'][0]['content']['parts'][2]['functionCall']['id']
        def send(req, timeout):
            requests.append(req)
            return responses[len(requests) - 1]
        with tempfile.TemporaryDirectory() as tmp:
            out = answer(CASE, 1, 'neon', bridge_program(tmp), send, Path(tmp) / 'budget.jsonl', tool_limit=2)
        self.assertEqual(out['text'], dumps(DRAFT))
        self.assertTrue(out['validation']['accepted'], out)
        self.assertEqual([turn['finish'] for turn in out['turns']], ['STOP'] * 3)
        self.assertEqual(out['turns'][1]['skippedCalls'], 1)
        contents = requests[2]['contents']
        for i, response in zip((1, 3), responses):
            self.assertIs(contents[i], response['candidates'][0]['content'])
        self.assertEqual(contents[4]['role'], 'user')
        first, second = [p['functionResponse'] for p in contents[4]['parts']]
        self.assertEqual(first['id'], 'c2-0')
        self.assertEqual(first['name'], 'knowledge')
        self.assertIn('知識', first['response'])
        self.assertNotIn('id', second)
        self.assertIn('エラー', second['response'])
        self.assertEqual(requests[2]['toolConfig'], {'functionCallingConfig': {'mode': 'NONE'}})
        self.assertIn('最終のJSON回答', contents[5]['parts'][0]['text'])

    def test_neon_truncated_turn_is_billed_but_not_replayed_or_executed(self):
        requests = []
        responses = [synthetic('neon', turn) for turn in range(1, 4)]
        responses[1]['candidates'][0]['finishReason'] = 'MAX_TOKENS'
        def send(req, timeout):
            requests.append(req)
            return responses[len(requests) - 1]
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / 'budget.jsonl'
            out = answer(CASE, 1, 'neon', bridge_program(tmp), send, ledger)
            with locked_ledger(ledger) as (_, events):
                self.assertEqual([e['state'] for e in events], ['reserved', 'settled'] * 3)
                self.assertAlmostEqual(ledger_total(events), out['estimatedUSD'])
        self.assertTrue(out['validation']['accepted'], out)
        self.assertEqual(len(out['calls']), 1)
        self.assertEqual(out['turns'][1]['finish'], 'MAX_TOKENS')
        self.assertEqual([r['generationConfig']['maxOutputTokens'] for r in requests], [12000, 12000, 16000])
        self.assertEqual(requests[2]['toolConfig'], {'functionCallingConfig': {'mode': 'NONE'}})
        self.assertEqual(requests[2]['contents'][:-1], requests[1]['contents'])
        self.assertIn('最終のJSON回答', requests[2]['contents'][-1]['parts'][0]['text'])

    def test_neon_usage_and_finish_reasons(self):
        data = synthetic('neon', 1)
        usage, cost = usage_and_cost(data, 'neon')
        self.assertEqual(usage, {'input': 105, 'output': 50, 'cacheRead': 20, 'cacheWrite': 0, 'reasoning': 10})
        self.assertAlmostEqual(cost, (85 * 3 + 20 * .15 + (40 + 10) * 15) / 1e6)
        req = body('neon', [{'content': 'system'}, {'content': 'user'}], True, 70)
        self.assertAlmostEqual(upper(req, (3, .15, 15, 0)), ((len(dumps(req).encode()) + 4096) * 3 + 70 * 15) / 1e6)
        for finish in ('MAX_TOKENS', 'MALFORMED_FUNCTION_CALL'):
            self.assertEqual(unpack('neon', {'candidates': [{'finishReason': finish}]}, []), ([], '', finish))
        data['usageMetadata'] = {'promptTokenCount': 100, 'thoughtsTokenCount': 70, 'totalTokenCount': 170}
        self.assertEqual(usage_and_cost(data, 'neon')[0]['output'], 70)
        data['usageMetadata']['totalTokenCount'] = 99
        with self.assertRaisesRegex(ValueError, 'invalid_usage_total'):
            usage_and_cost(data, 'neon')

    def test_neon_http_error_records_only_kind_and_keeps_reservation(self):
        def send(req, timeout):
            payload = {'error': {'code': 429, 'status': 'RESOURCE_EXHAUSTED', 'message': 'not recorded'}}
            raise HTTPError(None, 429, 'not recorded', {}, io.BytesIO(dumps(payload).encode()))
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / 'budget.jsonl'
            out = answer(CASE, 1, 'neon', bridge_program(tmp), send, ledger)
            self.assertEqual((out['error'], out['httpStatus'], out['httpErrorType']), ('HTTPError', 429, 'RESOURCE_EXHAUSTED'))
            self.assertNotIn('not recorded', dumps(out))
            with locked_ledger(ledger) as (_, events):
                self.assertEqual([event['state'] for event in events], ['reserved'])

    def test_typescript_draft_uses_only_signed_references(self):
        from coach_facts import build_facts
        game = CASE['payload']['analysis']
        facts = build_facts({**game, 'perspective': 'sente'})
        line = {'id': '0:line:abc', '手数': 0, '仮の読み筋（実戦とは別）': [{'表記': '▲2六歩(27)'}]}
        facts['仮の手順'] = [line]
        draft = {'sections': [{**DRAFT['sections'][0], 'refs': [line['id']]}]}
        with tempfile.TemporaryDirectory() as tmp:
            out = bridge_program(tmp)('draft', draft=draft, facts=facts, results=game['results'])
        self.assertTrue(out['accepted'], out)

    def test_typescript_draft_checks_position_and_notation(self):
        from coach_facts import build_facts
        facts = build_facts({**CASE['payload']['analysis'], 'perspective': 'sente'})
        draft = {'sections': [{'kind': 'facts', 'title': '開始局面', 'text': 'あなたの玉が9三にいます。 ▲2六歩', 'refs': ['0:position']}]}
        with tempfile.TemporaryDirectory() as tmp:
            out = bridge_program(tmp)('draft', draft=draft, facts=facts, results=CASE['payload']['analysis']['results'])
        self.assertFalse(out['accepted'])
        self.assertIn({'section': 0, 'field': 'text', 'code': 'unknown_move'}, out['issues'])
        self.assertIn({'section': 0, 'field': 'text', 'code': 'contradicts'}, out['issues'])
