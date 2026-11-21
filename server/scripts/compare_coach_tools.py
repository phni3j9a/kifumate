#!/usr/bin/env python3
"""Issue #54 / #67 のローカル比較。運用中のWorker・エンジンには接続しない。"""
import argparse
from contextlib import contextmanager
from datetime import date
import fcntl
from hashlib import sha256
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
LOCAL = SERVER / '.local/coach-neon'
PROMPT = SERVER / 'src/coach-tools-prompt.txt'
PRICE_DATES = {'deepseek': '2026-11-20', 'terra': '2026-11-21', 'neon': '2026-11-21'}
BUDGET = 5
LIMIT = 30
SECONDS = 600
PROVIDERS = {
    'deepseek': ('https://api.deepseek.com/chat/completions', 'deepseek-flash', 'DEEPSEEK_API_KEY', (.30, .006, 1.20, .30)),
    'terra': ('https://api.openai.com/v1/responses', 'gpt-6.1-terra', 'OPENAI_API_KEY', (1, .05, 5, 1.25)),
    'neon': ('https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:generateContent',
             'gemini-4-neon', 'GEMINI_API_KEY', (3, .15, 15, 0)),
}
FORCE_USD = {'deepseek': .09, 'terra': .15, 'neon': .45}
EARLY_STOP_USD = {'deepseek': .12, 'terra': .20, 'neon': .60}
GEMINI_ERROR_TYPES = {'INVALID_ARGUMENT', 'FAILED_PRECONDITION', 'PERMISSION_DENIED', 'NOT_FOUND',
                      'RESOURCE_EXHAUSTED', 'UNAUTHENTICATED', 'INTERNAL', 'UNAVAILABLE', 'DEADLINE_EXCEEDED',
                      'CANCELLED', 'ABORTED', 'UNKNOWN', 'ALREADY_EXISTS', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'DATA_LOSS'}
NEON_JSON_MODE = 'application/json'
OUTPUT_LIMITS = {'deepseek': (6500, 8000), 'terra': (4200, 5400), 'neon': (12000, 16000)}


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
    outgoing = (body['generationConfig']['maxOutputTokens'] if 'generationConfig' in body
                else body.get('max_tokens', body.get('max_output_tokens')))
    return (incoming * max(prices[0], prices[3]) + outgoing * prices[2]) / 1e6


def usage_and_cost(data, provider):
    if provider == 'neon':
        u = data['usageMetadata']
        prompt, tool_prompt = u['promptTokenCount'], u.get('toolUsePromptTokenCount', 0)
        candidates, reasoning = u.get('candidatesTokenCount', 0), u.get('thoughtsTokenCount', 0)
        if any(type(n) is not int or n < 0 for n in (prompt, tool_prompt, candidates, reasoning)):
            raise ValueError('invalid_usage')
        incoming, outgoing = prompt + tool_prompt, candidates + reasoning
        if u['totalTokenCount'] != incoming + outgoing:
            raise ValueError('invalid_usage_total')
        cached, cached_write = u.get('cachedContentTokenCount', 0), 0
    elif provider == 'terra':
        u = data['usage']
        details = u.get('input_tokens_details') or {}
        incoming, outgoing = u['input_tokens'], u['output_tokens']
        cached = details.get('cached_tokens', 0)
        cached_write = details.get('cache_write_tokens')
        if cached_write is None and any(k in details for k in ('cache_write_30m_tokens', 'cache_write_12h_tokens')):
            cached_write = details.get('cache_write_30m_tokens', 0) + details.get('cache_write_12h_tokens', 0)
        reasoning = (u.get('output_tokens_details') or {}).get('reasoning_tokens')
    else:
        u = data['usage']
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


def gemini_user(text):
    return {'role': 'user', 'parts': [{'text': text}]}


def body(provider, history, final, max_tokens):
    if provider == 'neon':
        return {'systemInstruction': {'parts': [{'text': history[0]['content']}]},
                'contents': [gemini_user(history[1]['content']), *history[2:]],
                'generationConfig': {'thinkingConfig': {'thinkingLevel': 'HIGH'}, 'maxOutputTokens': max_tokens,
                                     'responseMimeType': NEON_JSON_MODE},
                'tools': [{'functionDeclarations': [{'name': t['name'], 'description': t['description'],
                                                      'parametersJsonSchema': t['parameters']} for t in TOOLS]}],
                'toolConfig': {'functionCallingConfig': {'mode': 'NONE' if final else 'AUTO'}}}
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
    if provider == 'neon':
        candidates = data.get('candidates') or []
        if not candidates:
            return [], None, (data.get('promptFeedback') or {}).get('blockReason', 'NO_CANDIDATE')
        candidate = candidates[0]
        content = candidate.get('content') or {}
        parts = content.get('parts') or []
        finish = candidate.get('finishReason', 'FINISH_REASON_UNSPECIFIED')
        text = ''.join(p['text'] for p in parts if 'text' in p and not p.get('thought'))
        # MAX_TOKENS の直後に INVALID_ARGUMENT が出たため、不完全な出力は再送しない。
        if finish != 'STOP' or not parts:
            return [], text, finish
        history.append(content)
        calls = [(t.get('id'), t['name'], dumps(t.get('args', {}))) for p in parts if (t := p.get('functionCall'))]
        return calls, text, finish
    if provider == 'deepseek':
        choice = data['choices'][0]
        m = choice['message']
        history.append(m)
        return [(t['id'], t['function']['name'], t['function']['arguments']) for t in m.get('tool_calls') or []], m.get('content'), choice['finish_reason']
    items = data['output']
    history.extend(items)
    text = ''.join(t['text'] for m in items if m['type'] == 'message' for t in m['content'] if t['type'] == 'output_text')
    return [(t['call_id'], t['name'], t['arguments']) for t in items if t['type'] == 'function_call'], text, data['status']


def tool_message(provider, ident, name, result):
    if provider == 'neon':
        response = {'name': name, 'response': json.loads(result)}
        if ident is not None:
            response['id'] = ident
        return {'functionResponse': response}
    if provider == 'deepseek':
        return {'role': 'tool', 'tool_call_id': ident, 'content': result}
    return {'type': 'function_call_output', 'call_id': ident, 'output': result}


def http(provider, key, request_body, timeout):
    auth = {'x-goog-api-key': key} if provider == 'neon' else {'Authorization': 'Bearer ' + key}
    request = Request(PROVIDERS[provider][0], method='POST', data=dumps(request_body).encode(),
                      headers={**auth, 'Content-Type': 'application/json'})
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
    facts = build_facts(game, include_mate_replies=True)
    profile = payload['profile']
    user = {'視点': facts['視点'], '終局': facts['終局'], '対局手数': len(game['moves']), '要所': light_keys(facts),
            'profile': {'practice': [prose(p) for p in profile.get('practice', [])], 'goal': prose(profile.get('goal', ''))},
            'style': payload['style'], 'question': prose(payload.get('question') or '対局を振り返ってください')}
    return game, facts, [{'role': 'system', 'content': PROMPT.read_text()}, {'role': 'user', 'content': dumps(user)}]


def answer(case, run, provider, bridge, send, ledger, *, tool_limit=LIMIT, deadline=SECONDS):
    start = time.monotonic()
    game, facts, history = prepare(case['payload'], bridge)
    record = {'case': case['name'], 'run': run, 'turns': [], 'calls': [], 'estimatedUSD': 0}
    evidence = []
    force = False
    forced_attempt = False

    def inspect(value):
        return bridge('draft', draft=value, facts=facts, results=game['results'], evidence=evidence)

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
            max_tokens = OUTPUT_LIMITS[provider][1 if final else 0]
            request_body = body(provider, history, final, max_tokens)
            if final and not forced_attempt:
                instruction = '道具調査はここまでです。確認できた事実だけで最終のJSON回答を書いてください。'
                if provider == 'neon':
                    request_body['contents'].append(gemini_user(instruction))
                else:
                    request_body['messages' if provider == 'deepseek' else 'input'].append({'role': 'user', 'content': instruction})
            reserved = upper(request_body, PROVIDERS[provider][3])
            ident = str(uuid.uuid4())
            budget_event(ledger, ident, 'reserved', reserved)
            turn = {'turn': len(record['turns']) + 1, 'reservedUSD': reserved, 'finalOnly': final, 'maxOutputTokens': max_tokens}
            record['turns'].append(turn)
            signal.setitimer(signal.ITIMER_REAL, remaining)
            try:
                data = send(request_body, remaining)
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
            u, usd = usage_and_cost(data, provider)
            budget_event(ledger, ident, 'settled', usd)
            record['estimatedUSD'] += usd
            turn.update(usage=u, estimatedUSD=usd, model=data.get('modelVersion' if provider == 'neon' else 'model'))
            calls, text, finish = unpack(provider, data, history)
            turn['finish'] = finish
            if usd > reserved:
                raise Halt('reservation_exceeded')
            if not calls and finish in ('stop', 'completed', 'STOP'):
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
                force = True
                forced_attempt = provider != 'neon'
                continue
            responses = []
            for ident, name, raw in calls:
                if len(record['calls']) >= tool_limit or time.monotonic() - start >= deadline - 90:
                    responses.append(tool_message(provider, ident, name, dumps({'エラー': '調査上限。既に確認した資料のみで回答してください'})))
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
                encoded = dumps(result)
                if len(encoded.encode()) > 24000:
                    encoded = dumps({'エラー': '結果が大きすぎます。対象を絞って確認してください'})
                if args is not None and 'エラー' not in json.loads(encoded):
                    evidence.append({'name': name, 'args': args, 'result': result})
                record['calls'].append({'name': name, 'args': args, 'resultBytes': len(encoded.encode()), 'error': json.loads(encoded).get('エラー')})
                responses.append(tool_message(provider, ident, name, encoded))
            if provider == 'neon':
                history.append({'role': 'user', 'parts': responses})
            else:
                history.extend(responses)
            if record['estimatedUSD'] > FORCE_USD[provider]:
                force = True
    except HTTPError as e:
        record['error'] = 'HTTPError'
        record['httpStatus'] = e.code
        try:
            message = json.loads(e.read(65536)).get('error', {})
            code = message.get('status') if provider == 'neon' else message.get('code') or message.get('type')
            if isinstance(code, str) and code in (GEMINI_ERROR_TYPES if provider == 'neon' else
                                                  {'model_not_found', 'insufficient_quota', 'invalid_request_error', 'invalid_api_key', 'rate_limit_exceeded'}):
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
    parser.add_argument('--start-run', type=int, choices=(1, 2), default=1, help='反復番号の開始値（2回目のみの別実行用）')
    parser.add_argument('--case', action='append')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        import unittest
        suite = unittest.defaultTestLoader.discover(str(Path(__file__).parent), pattern='test_compare_coach_tools.py')
        raise SystemExit(not unittest.TextTestRunner().run(suite).wasSuccessful())
    if args.start_run + args.runs > 3:
        parser.error('--start-run 2 には --runs 1 が必要です')
    if not args.provider or not args.output or not (key := os.environ.get(PROVIDERS[args.provider][2])):
        parser.error('provider、--outputとAPIキー環境変数が必要です')
    if args.output.resolve().parent != LOCAL.resolve() or args.output.name == 'budget.jsonl':
        parser.error('出力は server/.local/coach-neon/ 内の新規ファイルに限定します')
    price_date = PRICE_DATES[args.provider]
    if date.today().isoformat() != price_date:
        parser.error('料金確認日と単価を再確認してください')
    cases = [c for c in json.loads(args.cases.read_text()) if not args.case or c['name'] in args.case]
    if not cases:
        parser.error('対象の比較ケースがありません')
    os.umask(0o077)
    LOCAL.mkdir(parents=True, exist_ok=True)
    result = {'provider': args.provider, 'model': PROVIDERS[args.provider][1], 'priceDate': price_date,
              'pricesPerMillion': PROVIDERS[args.provider][3], 'promptSHA256': sha256(PROMPT.read_bytes()).hexdigest(), 'records': []}
    if args.provider == 'neon':
        # https://aistudio.google.com/docs/structured-output?generate-content=true#structured-outputs-with-tools
        result['jsonMode'] = {'responseMimeType': NEON_JSON_MODE, 'withFunctionCalling': 'supported (preview)'}
        result['outputLimitReason'] = '初回比較のNeonで調査4200中4197、最終5400中5397を思考に使いMAX_TOKENSとなったため。'
    with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
        json.dump(result, f)
    signal.signal(signal.SIGALRM, timed_out)
    with tempfile.TemporaryDirectory() as temp:
        bridge = bridge_program(temp)
        for run in range(args.start_run, args.start_run + args.runs):
            for case in cases:
                rec = answer(case, run, args.provider, bridge, lambda b, t: http(args.provider, key, b, t), LOCAL / 'budget.jsonl')
                result['records'].append(rec)
                save(args.output, result)
                print(dumps({k: rec[k] for k in ('case', 'run', 'seconds', 'estimatedUSD', 'error', 'httpStatus', 'httpErrorType') if k in rec}), flush=True)
                if rec.get('error') in ('budget', 'reservation_exceeded', 'HTTPError') or rec.get('error') and 'usage' not in (rec['turns'][-1] if rec['turns'] else {}):
                    raise SystemExit('計測を停止しました。台帳の未精算予約を維持します。')
                if len(result['records']) <= 2 and rec['estimatedUSD'] > EARLY_STOP_USD[args.provider]:
                    raise SystemExit('初期の回答単価が想定を超えたため計測を停止しました。')


if __name__ == '__main__':
    main()
