"""Offline-only exact projection for pinned OpenClaw 2026.9.6 synthetic QA.

This is not a live authorization adapter. The wire body is sent unchanged to a
loopback mock; canonicalization is only used by the existing one-shot mock guard.
"""
import copy
import json
import re
import time
from datetime import datetime, timezone, timedelta
from cpa_once_relay import OnceRelay, MODEL


def projected(body, contract, now=None):
    assert contract['offlineOpenClawVersion'] == '2026.9.6'
    history = contract['history']
    assert [m['role'] for m in history] == ['user', 'user', 'assistant']
    messages = [m for m in body['messages'] if m['role'] != 'system']
    assert len(messages) == 3 and [m['role'] for m in messages] == ['user', 'assistant', 'user']
    first = messages[0]['content']
    assert first == [
        {'type': 'text', 'text': contract['historicalEnvelope'] + history[0]['text']},
        {'type': 'text', 'text': history[1]['text']},
        {'type': 'text', 'text': contract['runtimeLine']},
    ]
    assert messages[1]['content'] == history[2]['text']
    current = messages[2]['content']
    assert isinstance(current, str)
    match = re.fullmatch(r'\[([A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2}) GMT\+8\] (.*)', current, re.S)
    assert match and match[2] == contract['prompt']
    stamp = datetime.strptime(match[1], '%a %Y-%m-%d %H:%M').replace(tzinfo=timezone(timedelta(hours=8)))
    assert stamp.strftime('%a %Y-%m-%d %H:%M') == match[1]
    assert contract['startedAt'] - 60 <= stamp.timestamp() <= (now or time.time())
    result = copy.deepcopy(body)
    result['messages'] = [{'role': m['role'], 'content': m['text']} for m in history] + [{'role': 'user', 'content': contract['prompt']}]
    return result


class OpenClawMockRelay(OnceRelay):
    def __init__(self, contract_path, credential):
        super().__init__(contract_path, credential, offline=True)
        assert self.upstream.port != 8317  # never the user's real CPA listener
        assert self.contract['runtimeLine'] == (
            f"Runtime: agent=main | session=agent:main:agentkib:{self.contract['sessionId']} | "
            f"sessionId={self.contract['sessionId']} | host=MacBook Pro | os=macOS 27.0.1 (arm64) | "
            f"node=v26.9.0 | active_node=unknown | model=agentkib-cpa/{MODEL} | default_model=agentkib-cpa/{MODEL}"
        )

    def admit(self, route, headers, raw):
        body = projected(json.loads(raw), self.contract)
        # Parent guard persists a canonical projection hash; retain the precise
        # independent transport bytes as well. Handler forwards original raw.
        super().admit(route, headers, json.dumps(body).encode())
        (self.path.parent / 'reviewed-wire-request.json').write_bytes(raw)


def self_test(case):
    from pathlib import Path
    root = Path(case)
    contract = json.loads((root/'contract.json').read_text())
    body = json.loads((root/'reviewed-wire-request.json').read_text())
    assert projected(body, contract)['messages'] == [
        {'role': m['role'], 'content': m['text']} for m in contract['history']
    ] + [{'role': 'user', 'content': contract['prompt']}]
    tests = []
    for index in range(3):
        wrong = copy.deepcopy(body)
        messages = [m for m in wrong['messages'] if m['role'] != 'system']
        messages[0]['content'][index]['text'] += ' changed'
        tests.append(wrong)
    for index in (1, 2):
        wrong = copy.deepcopy(body)
        messages = [m for m in wrong['messages'] if m['role'] != 'system']
        messages[index]['content'] += ' changed'
        tests.append(wrong)
    for timestamp in ('[Wed 2000-01-01 20:00 GMT+8] ', '[Wed 2099-01-01 20:00 GMT+8] '):
        wrong = copy.deepcopy(body)
        wrong['messages'][-1]['content'] = timestamp + contract['prompt']
        tests.append(wrong)
    wrong = copy.deepcopy(body); wrong['messages'][-1]['role'] = 'assistant'; tests.append(wrong)
    wrong = copy.deepcopy(body); wrong['messages'].append({'role': 'user', 'content': 'extra'}); tests.append(wrong)
    for wrong in tests:
        try:
            projected(wrong, contract)
        except AssertionError:
            continue
        raise AssertionError('Invalid native projection admitted')
    return {'negativeProjectionCases': len(tests), 'passed': True, 'networkRequests': 0}


if __name__ == '__main__':
    import sys
    print(json.dumps(self_test(sys.argv[1])))
