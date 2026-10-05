"""Synthetic Responses frames and loopback-only guard tests; no provider/native CLI."""
import copy
from email.message import Message
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from deepseek_codex_guard import (CodexRelay, MODEL, POLICY, REFERENCE, TOOLS_SHA,
    REFERENCE_155, canonical, make_projection, strict_json, synthetic_sse, synthetic_transport, validate_request, validate_sse)
from deepseek_once_relay import OnceRelay, private_json, synthetic_provider, validate_envelope

spec = importlib.util.spec_from_file_location('codex_once', Path(__file__).with_name('deepseek-codex-native-once.py'))
runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)


def fixture(version='0.146.1'):
    body = strict_json((REFERENCE if version == '0.146.1' else REFERENCE_155).read_bytes())
    history = [{'role': m['role'], 'text': m['content'][0]['text']} for m in body['input'][:3]]
    projection = {'expectedInput': [{k: v for k, v in m.items() if k != 'id'} for m in body['input']],
                  'instructions': body['instructions'], 'tools': body['tools']}
    turn = strict_json(body['client_metadata']['x-codex-turn-metadata'])
    turn['turn_started_at_unix_ms'] = int(time.time() * 1000)
    body['client_metadata']['x-codex-turn-metadata'] = json.dumps(turn)
    contract = {'schemaVersion': 1, 'protocol': 'responses', 'model': MODEL, 'stream': True,
                'tools': POLICY, 'toolsSha256': TOOLS_SHA, 'sessionId': body['prompt_cache_key'],
                'providerFingerprint': synthetic_provider().fingerprint, 'history': history,
                'prompt': body['input'][-1]['content'][0]['text'], 'projection': projection, 'startedAt': time.time(),
                'codexVersion': version}
    return body, contract


def frames(raw):
    return [json.loads(f.split('data: ', 1)[1]) for f in raw.decode().strip().split('\n\n')]


def pack(events):
    return ''.join('data: ' + json.dumps(x) + '\n\n' for x in events).encode()


class Tests(unittest.TestCase):
    def test_latest_profile_metadata_is_exact_and_legacy_stays_separate(self):
        body, contract = fixture('0.155.1')
        validate_request(body, contract)
        with self.assertRaises(AssertionError): validate_request(body, dict(contract, codexVersion='0.146.1'))
        with self.assertRaises(AssertionError): validate_request(body, dict(contract, codexVersion='0.155.2'))
        for field, value in [('agent_name', '/other'), ('root_turn_id', 'changed'),
                             ('sandbox_mode', 'workspace-write'), ('auto_review_enabled', True),
                             ('auto_review_enabled', 0), ('node_repl_disabled', 0),
                             ('node_repl_auto_review_required', 0), ('window_number', False),
                             ('window_number', 1), ('context_window_id', 'invalid'),
                             ('unexpected', False)]:
            bad = copy.deepcopy(body)
            metadata = strict_json(bad['client_metadata']['x-codex-turn-metadata'])
            metadata[field] = value
            bad['client_metadata']['x-codex-turn-metadata'] = json.dumps(metadata)
            with self.assertRaises(AssertionError): validate_request(bad, contract)
        for field in ('root_turn_id', 'unexpected'):
            bad = copy.deepcopy(body); bad['client_metadata'][field] = 'invalid'
            with self.assertRaises(AssertionError): validate_request(bad, contract)
        bad = copy.deepcopy(body); bad['parallel_tool_calls'] = False
        with self.assertRaises(AssertionError): validate_request(bad, contract)

    def test_cli_turn_identity_reply_and_no_tool_execution(self):
        events = [{'type': 'thread.started', 'thread_id': 'sid'}, {'type': 'turn.started'},
                  {'type': 'item.completed', 'item': {'id': 'x', 'type': 'agent_message', 'text': 'reply'}},
                  {'type': 'turn.completed', 'usage': {'input_tokens': 10, 'output_tokens': 2}}]
        def encode(items): return b'\n'.join(json.dumps(x).encode() for x in items)
        self.assertTrue(runner.audit_cli_output(encode(events), 'sid', 'reply')['singleNativeTurnCompleted'])
        for kind in ('command_execution', 'mcp_tool_call', 'view_image', 'unknown'):
            bad = copy.deepcopy(events); bad[2]['item']['type'] = kind
            with self.assertRaises(AssertionError): runner.audit_cli_output(encode(bad), 'sid', 'reply')
        with self.assertRaises(AssertionError): runner.audit_cli_output(encode(events), 'other', 'reply')
        with self.assertRaises(AssertionError): runner.audit_cli_output(encode(events), 'sid', 'changed')

    def test_exact_projection_and_default_none_unchanged(self):
        body, contract = fixture()
        validate_envelope(body, contract); validate_request(body, contract)
        with self.assertRaises(AssertionError): validate_envelope(body, dict(contract, tools='none'))
        for policy in ('other', 'codex-fixed-function'):
            with self.assertRaises(AssertionError): validate_envelope(body, dict(contract, tools=policy))
        for protocol in ('chat', 'anthropic'):
            with self.assertRaises(AssertionError): validate_envelope(body, dict(contract, protocol=protocol))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'contract.json'; private_json(path, contract)
            with self.assertRaises(AssertionError):
                OnceRelay(path, synthetic_provider(), offline=True, validator=validate_request)

    def test_all_body_parts_and_definition_drift_rejected(self):
        body, contract = fixture(); bads = []
        for i, message in enumerate(body['input']):
            for j in range(len(message['content'])):
                x = copy.deepcopy(body); x['input'][i]['content'][j]['text'] += ' lost'; bads.append(x)
            x = copy.deepcopy(body); x['input'][i]['role'] = 'system'; bads.append(x)
        for key, value in [('tools', []), ('tool_choice', 'none'), ('model', 'other'),
                           ('instructions', 'changed'), ('previous_response_id', 'old')]:
            x = copy.deepcopy(body); x[key] = value; bads.append(x)
        x = copy.deepcopy(body); x['tools'][0]['parameters']['properties']['path']['type'] = 'number'; bads.append(x)
        x = copy.deepcopy(body); x['tools'].append({'type': 'namespace', 'name': 'multi_agent_v1'}); bads.append(x)
        x = copy.deepcopy(body); x['client_metadata']['session_id'] = 'wrong'; bads.append(x)
        for x in bads:
            with self.assertRaises((AssertionError, KeyError)): validate_request(x, contract)

    def test_duplicate_json_and_nonfinite_rejected(self):
        for raw in ('{"model":1,"model":2}', '{"x":NaN}'):
            with self.assertRaises(AssertionError): strict_json(raw)

    def test_sse_success_raw_unchanged(self):
        raw = synthetic_sse('marker M; complete WAL decision')
        original = bytes(raw); proof = validate_sse(raw)
        self.assertEqual(raw, original); self.assertEqual(proof['answer'], 'marker M; complete WAL decision')
        self.assertEqual(proof['toolCalls'], 0)

    def test_response_schema_echo_is_exact_metadata_only(self):
        clean = frames(synthetic_sse('safe'))
        tools = strict_json(REFERENCE.read_bytes())['tools']
        for event in clean:
            if 'response' in event:
                event['response']['tools'] = copy.deepcopy(tools)
                event['response']['text'] = {'format': {'type': 'text'}, 'verbosity': None}
        raw = pack(clean); original = bytes(raw)
        self.assertEqual(validate_sse(raw)['answer'], 'safe'); self.assertEqual(raw, original)
        for change in ('name', 'schema', 'extra_tool', 'extra_schema', 'format', 'verbosity', 'extra_format'):
            bad = copy.deepcopy(clean); response = bad[0]['response']
            if change == 'name': response['tools'][0]['name'] = 'other'
            if change == 'schema': response['tools'][0]['parameters']['properties']['path']['type'] = 'number'
            if change == 'extra_tool': response['tools'].append(copy.deepcopy(tools[0]))
            if change == 'extra_schema': response['tools'][0]['parameters']['extra'] = True
            if change == 'format': response['text']['format']['type'] = 'json_schema'
            if change == 'verbosity': response['text']['verbosity'] = 'high'
            if change == 'extra_format': response['text']['format']['extra'] = 'unreviewed'
            with self.assertRaises(AssertionError): validate_sse(pack(bad))
        for location in ('added_item', 'done_item', 'response_output', 'delta', 'nested_content'):
            bad = copy.deepcopy(clean); call = copy.deepcopy(tools[0])
            if location == 'added_item': bad[1]['item'] = call
            if location == 'done_item': bad[-2]['item'] = call
            if location == 'response_output': bad[-1]['response']['output'].append(call)
            if location == 'delta': bad[2]['extra'] = call
            if location == 'nested_content': bad[-1]['response']['output'][0]['content'].append(call)
            with self.assertRaises(AssertionError): validate_sse(pack(bad))
        bad = copy.deepcopy(clean)
        bad[2]['response'] = {'tools': tools, 'text': {'format': {'type': 'text'}, 'verbosity': None}}
        with self.assertRaises(AssertionError): validate_sse(pack(bad))

    def test_sse_tools_anywhere_and_unknown_events_rejected(self):
        clean = frames(synthetic_sse('safe'))
        for kind in ('function_call', 'custom_tool_call', 'tool_call', 'web_search_call', 'computer_call'):
            for place in ('delta', 'added', 'done', 'nested'):
                x = copy.deepcopy(clean)
                if place == 'delta': x.insert(2, {'type': 'response.' + kind + '_arguments.delta', 'delta': '{}'})
                if place == 'added': x[1]['item'] = {'type': kind, 'name': 'view_image', 'arguments': '{}'}
                if place == 'done': x[-2]['item'] = {'type': kind, 'name': 'view_image', 'arguments': '{}'}
                if place == 'nested': x[-1]['response']['output'][0]['content'].append({'type': kind})
                with self.assertRaises(AssertionError): validate_sse(pack(x))

    def test_sse_error_incomplete_truncated_and_inconsistent_rejected(self):
        raw = synthetic_sse('safe'); clean = frames(raw); bads = [raw[:-1], raw + b'\xff\n\n', pack(clean[:-1])]
        for kind in ('response.failed', 'response.incomplete', 'error', 'response.unknown'):
            x = copy.deepcopy(clean); x[-1]['type'] = kind; bads.append(pack(x))
        for change in ('status', 'error', 'text', 'duplicate', 'aftercomplete', 'delta', 'model'):
            x = copy.deepcopy(clean)
            if change == 'status': x[-1]['response']['status'] = 'incomplete'
            if change == 'error': x[-1]['response']['error'] = {'message': 'failure'}
            if change == 'text': x[-1]['response']['output'][0]['content'][0]['text'] = 'changed'
            if change == 'duplicate': x.insert(-1, copy.deepcopy(x[-2]))
            if change == 'aftercomplete': x.append(copy.deepcopy(x[2]))
            if change == 'delta': x[2]['delta'] = 'wrong'
            if change == 'model': x[-1]['response']['model'] = 'different-model'
            bads.append(pack(x))
        for bad in bads:
            with self.assertRaises((AssertionError, UnicodeError)): validate_sse(bad)

    def test_durable_one_dispatch_and_response_not_rewritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'contract.json'; body, contract = fixture(); private_json(path, contract)
            response = synthetic_sse('reply'); request = json.dumps(body).encode()
            relay = CodexRelay(path, synthetic_provider(), offline=True, _connection_factory=synthetic_transport(response)).start()
            headers = Message(); headers['Authorization'] = 'Bearer ' + relay.client_token
            try:
                relay.admit(relay.route, headers, request)
                status, _, actual = relay.forward(request, headers)
                self.assertEqual((status, actual), (200, response))
                with self.assertRaises(FileExistsError): relay.admit(relay.route, headers, request)
                self.assertEqual(relay.summary()['dispatchAttempts'], 1)
            finally: relay.close()
            reopened = CodexRelay(path, synthetic_provider(), offline=True, _connection_factory=synthetic_transport(response)).start()
            headers.replace_header('Authorization', 'Bearer ' + reopened.client_token)
            try:
                with self.assertRaises(FileExistsError): reopened.admit(reopened.route, headers, request)
            finally: reopened.close()

    def test_invalid_response_never_delivered_to_http_client(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'contract.json'; body, contract = fixture(); private_json(path, contract)
            bad = frames(synthetic_sse('reply')); bad.insert(2, {'type': 'response.function_call_arguments.delta', 'delta': '{}'})
            relay = CodexRelay(path, synthetic_provider(), offline=True, _connection_factory=synthetic_transport(pack(bad))).start()
            import http.client
            conn = http.client.HTTPConnection('127.0.0.1', relay.server.server_port, timeout=3)
            try:
                conn.request('POST', relay.route, body=json.dumps(body), headers={'Authorization': 'Bearer ' + relay.client_token})
                response = conn.getresponse(); content = response.read()
                self.assertEqual(response.status, 409); self.assertNotIn(b'function_call', content)
                self.assertEqual(relay.summary()['dispatchAttempts'], 1)
            finally: conn.close(); relay.close()

    def test_cancel_during_partial_upstream_never_returns_sse(self):
        with tempfile.TemporaryDirectory() as directory:
            body, contract = fixture(); path = Path(directory) / 'contract.json'; private_json(path, contract)
            entered, closed = threading.Event(), threading.Event()
            class Sock:
                def settimeout(self, _): pass
                def shutdown(self, _): closed.set()
                def close(self): closed.set()
            class Response:
                status = 200
                def getheader(self, *_): return 'text/event-stream'
                def read(self, _): entered.set(); closed.wait(3); raise OSError('cancelled partial SSE')
            class Connection:
                def __init__(self, *_a, **_k): self.sock = None
                def connect(self): self.sock = Sock()
                def request(self, *_a, **_k): pass
                def getresponse(self): return Response()
                def close(self): pass
            relay = CodexRelay(path, synthetic_provider(), offline=True, _connection_factory=Connection).start()
            import http.client
            received = []
            def client():
                c = http.client.HTTPConnection('127.0.0.1', relay.server.server_port, timeout=5)
                try:
                    c.request('POST', relay.route, json.dumps(body), {'Authorization': 'Bearer ' + relay.client_token})
                    response = c.getresponse(); received.append((response.status, response.read()))
                except (OSError, http.client.HTTPException): pass
                finally: c.close()
            worker = threading.Thread(target=client); worker.start()
            self.assertTrue(entered.wait(3)); relay.close(); worker.join(4)
            self.assertFalse(worker.is_alive()); self.assertFalse(any(status == 200 for status, _ in received))
            self.assertEqual(relay.summary()['activeHandlers'], 0)

    def test_late_cancel_preserved_and_fake_cli_output_bound_cleanup(self):
        cancellation = runner.Cancellation()
        cancellation.receive(signal.SIGTERM, None); cancellation.receive(signal.SIGINT, None)
        with self.assertRaises(InterruptedError): cancellation.checkpoint()
        self.assertEqual(cancellation.signals, [signal.SIGTERM, signal.SIGINT])
        class Relay:
            def summary(self): return {'blocked': 0}
        with tempfile.TemporaryDirectory() as directory:
            result = {}; cancellation = runner.Cancellation()
            with patch.object(runner, 'LIMIT', 1024):
                with self.assertRaises(AssertionError):
                    runner.run_cli([sys.executable, '-c', 'import os,time;os.write(1,b"x"*2048);time.sleep(10)'],
                        {'PATH': '/usr/bin:/bin'}, Path(directory), '', cancellation, Relay(), result)
            self.assertTrue(result['ownedProcessGroupGone'])


if __name__ == '__main__': unittest.main()
