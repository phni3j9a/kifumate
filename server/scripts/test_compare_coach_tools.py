import tempfile
import unittest
from pathlib import Path

from compare_coach_tools import Halt, answer, body, bridge_program, budget_event, dumps, locked_ledger, usage_and_cost
from compare_coach import ledger_total

CASE = {'name': 'fake', 'payload': {'analysis': {'initial': 'startpos', 'moves': [], 'results': [{'ply': 0, 'score': None, 'candidates': [], 'mate': None}]},
                                   'perspective': 'sente', 'profile': {'practice': [], 'goal': ''}, 'style': {'focus': '総合', 'detail': 'かんたん'}}}
DRAFT = {'sections': [{'kind': 'facts', 'title': '開始局面', 'text': '開始局面を確認します。', 'refs': ['0:position']}]}


def synthetic(provider, turn):
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
            budget_event(ledger, 'x', 'reserved', 2.99)
            with self.assertRaisesRegex(Halt, 'budget'):
                budget_event(ledger, 'y', 'reserved', .02)
            budget_event(ledger, 'x', 'settled', .02)
            budget_event(ledger, 'y', 'reserved', 2.97)
            with locked_ledger(ledger) as (_, events):
                self.assertAlmostEqual(ledger_total(events), 2.99)

    def test_provider_costs_include_reasoning_and_cache(self):
        usage, cost = usage_and_cost(synthetic('terra', 1), 'terra')
        self.assertEqual(usage, {'input': 100, 'output': 50, 'cacheRead': 20, 'cacheWrite': 30, 'reasoning': 10})
        self.assertAlmostEqual(cost, (50 + 20 * .05 + 30 * 1.25 + 50 * 5) / 1e6)
        _, cost = usage_and_cost(synthetic('deepseek', 1), 'deepseek')
        self.assertAlmostEqual(cost, (80 * .30 + 20 * .006 + 50 * 1.2) / 1e6)
        self.assertEqual(body('deepseek', [], False, 70)['reasoning_effort'], 'max')
        self.assertEqual(body('terra', [], False, 70)['reasoning']['effort'], 'high')

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
