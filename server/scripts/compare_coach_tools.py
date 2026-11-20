#!/usr/bin/env python3
"""Issue #54 のローカル比較。運用中のWorker・エンジンには接続しない。"""
import argparse
from contextlib import contextmanager
from datetime import date
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import uuid
from urllib.error import HTTPError
from urllib.request import Request, build_opener

import cshogi
from compare_coach import NoRedirect, append_event, ledger_total, prose, save
from coach_facts import build_facts
from coach_tools import call, light_keys

SERVER = Path(__file__).resolve().parents[1]
LOCAL = SERVER / '.local/coach-tools'
PROMPT = SERVER / 'src/coach-tools-prompt.txt'
PRICE_DATE = '2026-11-20'
BUDGET = 3
LIMIT = 30
SECONDS = 600
PROVIDERS = {
    'deepseek': ('https://api.deepseek.com/chat/completions', 'deepseek-flash', 'DEEPSEEK_API_KEY', (.30, .006, 1.20, .30)),
    'terra': ('https://api.openai.com/v1/responses', 'gpt-6.1-terra', 'OPENAI_API_KEY', (1, .05, 5, 1.25)),
}


def dumps(x):
    return json.dumps(x, ensure_ascii=False, separators=(',', ':'))


TOOLS = json.loads((SERVER / 'container/coach_tools_schema.json').read_text())


class Halt(Exception):
    pass


@contextmanager
def locked_ledger(path):
    with os.fdopen(os.open(path, os.O_CREAT | os.O_RDWR | os.O_APPEND, 0o600), 'a+') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        handle.seek(0)
        yield handle, [json.loads(line) for line in handle]


def budget_event(path, ident, state, amount):
    with locked_ledger(path) as (ledger, events):
        total = ledger_total(events)
        if state == 'reserved' and total + amount > BUDGET:
            raise Halt('budget')
        append_event(ledger, {'id': ident, 'state': state, 'usd': amount})


def upper(body, prices):
    # バイト数はトークン数より安全側。Terra標準料金の長文閾値も超えないようにする。
    incoming = len(dumps(body).encode()) + 4096
    if incoming > 256000:
        raise Halt('context_limit')
    return (incoming * max(prices[0], prices[3]) + body.get('max_tokens', body.get('max_output_tokens')) * prices[2]) / 1e6


def usage_and_cost(data, provider):
    u = data['usage']
    if provider == 'terra':
        details = u.get('input_tokens_details') or {}
        incoming, outgoing = u['input_tokens'], u['output_tokens']
        cached = details.get('cached_tokens', 0)
        cached_write = details.get('cache_write_tokens')
        if cached_write is None and any(k in details for k in ('cache_write_30m_tokens', 'cache_write_12h_tokens')):
            cached_write = details.get('cache_write_30m_tokens', 0) + details.get('cache_write_12h_tokens', 0)
        reasoning = (u.get('output_tokens_details') or {}).get('reasoning_tokens')
    else:
        incoming, outgoing = u['prompt_tokens'], u['completion_tokens']
        cached, cached_write = u.get('prompt_cache_hit_tokens', 0), 0
        reasoning = (u.get('completion_tokens_details') or {}).get('reasoning_tokens')
    # 内訳なしでは書込有無を断定しない。未読込み分を全て高い書込単価として精算。
    written = incoming - cached if cached_write is None else cached_write
    if any(type(n) is not int or n < 0 for n in (incoming, outgoing, cached, written)) or cached + written > incoming:
        raise ValueError('invalid_usage')
    normal, hit, output, write = PROVIDERS[provider][3]
    usd = ((incoming - cached - written) * normal + cached * hit + outgoing * output + written * write) / 1e6
    return {'input': incoming, 'cacheRead': cached, 'cacheWrite': cached_write, 'output': outgoing, 'reasoning': reasoning}, usd


def body(provider, history, final, max_tokens):
    model = PROVIDERS[provider][1]
    tools = [{'type': 'function', **tool, 'strict': False} for tool in TOOLS]
    choice = 'none' if final else 'auto'
    if provider == 'terra':
        return {'model': model, 'input': history[:], 'store': False, 'include': ['reasoning.encrypted_content'],
                'service_tier': 'default', 'reasoning': {'effort': 'high'}, 'max_output_tokens': max_tokens,
                'text': {'format': {'type': 'json_object'}}, 'tools': tools, 'tool_choice': choice}
    return {'model': model, 'messages': history[:], 'reasoning_effort': 'max', 'thinking': {'type': 'enabled'},
            'response_format': {'type': 'json_object'}, 'max_tokens': max_tokens,
            'tools': [{'type': 'function', 'function': {k: t[k] for k in ('name', 'description', 'parameters')}} for t in tools], 'tool_choice': choice}


def unpack(provider, data, history):
    if provider == 'deepseek':
        choice = data['choices'][0]
        m = choice['message']
        history.append(m)
        return [(t['id'], t['function']['name'], t['function']['arguments']) for t in m.get('tool_calls') or []], m.get('content'), choice['finish_reason']
    items = data['output']
    history.extend(items)
    text = ''.join(t['text'] for m in items if m['type'] == 'message' for t in m['content'] if t['type'] == 'output_text')
    return [(t['call_id'], t['name'], t['arguments']) for t in items if t['type'] == 'function_call'], text, data['status']


def tool_message(provider, ident, result):
    if provider == 'deepseek':
        return {'role': 'tool', 'tool_call_id': ident, 'content': result}
    return {'type': 'function_call_output', 'call_id': ident, 'output': result}


def http(provider, key, request_body, timeout):
    request = Request(PROVIDERS[provider][0], method='POST', data=dumps(request_body).encode(),
                      headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    with build_opener(NoRedirect).open(request, timeout=timeout) as response:
        raw = response.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024:
            raise ValueError('response_too_large')
        return json.loads(raw)


def timed_out(*_):
    raise Halt('deadline')


def bridge_program(directory):
    binary = Path(directory) / 'coach-tools.cjs'
    subprocess.run([SERVER / 'node_modules/.bin/esbuild', SERVER / 'scripts/coach_tools_bridge.ts', '--bundle', '--platform=node',
                    '--loader:.txt=text', '--log-level=error', f'--outfile={binary}'], check=True)
    def bridge(task, **data):
        result = subprocess.run(['node', binary], input=dumps({'task': task, **data}), capture_output=True, text=True, check=True, timeout=8)
        return json.loads(result.stdout)
    return bridge


def prepare(payload, bridge):
    game = {**payload['analysis'], 'perspective': payload['perspective'], 'question': payload.get('question')}
    game['tags'] = bridge('classify', initial=cshogi.STARTING_SFEN if game['initial'] == 'startpos' else game['initial'], moves=game['moves'])
    facts = build_facts(game)
    profile = payload['profile']
    user = {'視点': facts['視点'], '終局': facts['終局'], '対局手数': len(game['moves']), '要所': light_keys(facts),
            'profile': {'practice': [prose(p) for p in profile.get('practice', [])], 'goal': prose(profile.get('goal', ''))},
            'style': payload['style'], 'question': prose(payload.get('question') or '対局を振り返ってください')}
    return game, facts, [{'role': 'system', 'content': PROMPT.read_text()}, {'role': 'user', 'content': dumps(user)}]


def add_evidence(name, result, pos, game, facts):
    if 'エラー' in result:
        return
    refs = []
    if name == 'saved_analysis':
        refs = result['候補と詰み証明']
    if name == 'play_line':
        refs = [result['参照']]
    if name == 'position' and not pos.get('moves'):
        id_ = result['本譜の参照']
        existing = next((r for r in facts['参照'] if r['id'] == id_), None)
        if existing is None:
            # 既存チェックは形勢も読むため、局面の内容のみ追加して他の照合を退化させない。
            existing = call(game, 'saved_analysis', {'position': pos}, facts=facts)
            existing.pop('候補と詰み証明', None)
            refs = [existing] if 'id' in existing else []
        existing['局面'] = result['盤面']
    for ref in refs:
        facts['参照'][:] = [r for r in facts['参照'] if r['id'] != ref['id']] + [ref]


def answer(case, run, provider, bridge, send, ledger, *, tool_limit=LIMIT, deadline=SECONDS):
    start = time.monotonic()
    game, facts, history = prepare(case['payload'], bridge)
    record = {'case': case['name'], 'run': run, 'turns': [], 'calls': [], 'estimatedUSD': 0}
    force = False
    forced_attempt = False

    def inspect(value):
        return bridge('draft', draft=value, facts=facts, results=game['results'])

    def draft(raw):
        try:
            return inspect(json.loads(raw))
        except (ValueError, TypeError):
            return {'accepted': False, 'issues': [{'code': 'invalid_json'}]}

    try:
        while True:
            remaining = deadline - (time.monotonic() - start)
            if remaining <= 0:
                raise Halt('deadline')
            final = force or len(record['calls']) >= tool_limit or remaining < 120
            max_tokens = (6500 if provider == 'deepseek' else 4200) if not final else (8000 if provider == 'deepseek' else 5400)
            request_body = body(provider, history, final, max_tokens)
            if final and not forced_attempt:
                request_body['messages' if provider == 'deepseek' else 'input'].append({'role': 'user', 'content': '道具調査はここまでです。確認できた事実だけで最終のJSON回答を書いてください。'})
            reserved = upper(request_body, PROVIDERS[provider][3])
            ident = str(uuid.uuid4())
            budget_event(ledger, ident, 'reserved', reserved)
            turn = {'turn': len(record['turns']) + 1, 'reservedUSD': reserved, 'finalOnly': final}
            record['turns'].append(turn)
            signal.setitimer(signal.ITIMER_REAL, remaining)
            try:
                data = send(request_body, remaining)
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
            u, usd = usage_and_cost(data, provider)
            budget_event(ledger, ident, 'settled', usd)
            record['estimatedUSD'] += usd
            turn.update(usage=u, estimatedUSD=usd, model=data.get('model'))
            if usd > reserved:
                raise Halt('reservation_exceeded')
            calls, text, finish = unpack(provider, data, history)
            turn['finish'] = finish
            if not calls and finish in ('stop', 'completed'):
                record['text'] = text
                record['validation'] = draft(text)
                if record['validation']['accepted']:
                    value = json.loads(text)
                    if isinstance(value.get('claims'), list):
                        record['selfCheck'] = call(game, 'check_claims', {'claims': value['claims']}, facts=facts)
                break
            if final:
                record['text'] = text
                raise Halt('final_incomplete')
            if not calls:
                force = forced_attempt = True
                continue
            for ident, name, raw in calls:
                if len(record['calls']) >= tool_limit or time.monotonic() - start >= deadline - 90:
                    history.append(tool_message(provider, ident, dumps({'エラー': '調査上限。既に確認した資料のみで回答してください'})))
                    turn['skippedCalls'] = turn.get('skippedCalls', 0) + 1
                    force = True
                    continue
                try:
                    args = json.loads(raw)
                    if not isinstance(args, dict) or len(raw.encode()) > 16000:
                        raise ValueError()
                except (ValueError, TypeError):
                    args, result = None, {'エラー': '道具の引数が不正'}
                else:
                    result = call(game, name, args, facts=facts, draft=draft)
                    add_evidence(name, result, args.get('position'), game, facts)
                encoded = dumps(result)
                if len(encoded.encode()) > 24000:
                    encoded = dumps({'エラー': '結果が大きすぎます。対象を絞って確認してください'})
                record['calls'].append({'name': name, 'args': args, 'resultBytes': len(encoded.encode()), 'error': json.loads(encoded).get('エラー')})
                history.append(tool_message(provider, ident, encoded))
            if record['estimatedUSD'] > (.15 if provider == 'terra' else .09):
                force = True
    except HTTPError as e:
        record['error'] = 'HTTPError'
        record['httpStatus'] = e.code
        try:
            message = json.loads(e.read(65536)).get('error', {})
            code = message.get('code') or message.get('type')
            if code in ('model_not_found', 'insufficient_quota', 'invalid_request_error', 'invalid_api_key', 'rate_limit_exceeded'):
                record['httpErrorType'] = code
        except (ValueError, TypeError, OSError, AttributeError):
            pass
        finally:
            e.close()
    except Halt as e:
        record['error'] = str(e)
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as e:
        record['error'] = type(e).__name__
    record['seconds'] = round(time.monotonic() - start, 3)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('provider', nargs='?', choices=PROVIDERS)
    parser.add_argument('--cases', type=Path, default=SERVER / '.local/coach-reasoning/cases.json')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--runs', type=int, choices=(1, 2), default=2)
    parser.add_argument('--case', action='append')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        import unittest
        suite = unittest.defaultTestLoader.discover(str(Path(__file__).parent), pattern='test_compare_coach_tools.py')
        raise SystemExit(not unittest.TextTestRunner().run(suite).wasSuccessful())
    if not args.provider or not args.output or not (key := os.environ.get(PROVIDERS[args.provider][2])):
        parser.error('provider、--outputとAPIキー環境変数が必要です')
    if args.output.resolve().parent != LOCAL.resolve() or args.output.name == 'budget.jsonl':
        parser.error('出力は server/.local/coach-tools/ 内の新規ファイルに限定します')
    if date.today().isoformat() != PRICE_DATE:
        parser.error('料金確認日と単価を再確認してください')
    cases = [c for c in json.loads(args.cases.read_text()) if not args.case or c['name'] in args.case]
    if not cases:
        parser.error('対象の比較ケースがありません')
    os.umask(0o077)
    LOCAL.mkdir(parents=True, exist_ok=True)
    result = {'provider': args.provider, 'model': PROVIDERS[args.provider][1], 'priceDate': PRICE_DATE,
              'pricesPerMillion': PROVIDERS[args.provider][3], 'records': []}
    with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
        json.dump(result, f)
    signal.signal(signal.SIGALRM, timed_out)
    with tempfile.TemporaryDirectory() as temp:
        bridge = bridge_program(temp)
        for run in range(1, args.runs + 1):
            for case in cases:
                rec = answer(case, run, args.provider, bridge, lambda b, t: http(args.provider, key, b, t), LOCAL / 'budget.jsonl')
                result['records'].append(rec)
                save(args.output, result)
                print(dumps({k: rec[k] for k in ('case', 'run', 'seconds', 'estimatedUSD', 'error', 'httpStatus') if k in rec}), flush=True)
                if rec.get('error') in ('budget', 'reservation_exceeded', 'HTTPError') or rec.get('error') and 'usage' not in (rec['turns'][-1] if rec['turns'] else {}):
                    raise SystemExit('計測を停止しました。台帳の未精算予約を維持します。')
                if len(result['records']) <= 2 and rec['estimatedUSD'] > (.20 if args.provider == 'terra' else .12):
                    raise SystemExit('初期の回答単価が想定を超えたため計測を停止しました。')


if __name__ == '__main__':
    main()
