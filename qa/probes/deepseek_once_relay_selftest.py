"""Pure fixtures and loopback/fake TLS transport only; no provider/auth access."""
import concurrent.futures
import copy
import http.client
import importlib.util
import json
from pathlib import Path
import sqlite3
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import deepseek_once_relay as relay_module


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.snapshot = relay_module.synthetic_provider()
        self.history = [{'role': 'user', 'text': 'Import notice.'},
                        {'role': 'user', 'text': 'marker M; decision WAL'},
                        {'role': 'assistant', 'text': 'Confirmed marker M; decision WAL'}]
        self.prompt = 'Recall both.'
        self.serial = 0
        self.relays = []

    def tearDown(self):
        for relay in self.relays:
            if not relay.stop_event.is_set():
                relay.close()
        for path in self.root.rglob('*'):
            if path.is_file() and path.suffix != '.sqlite':
                self.assertNotIn(self.snapshot._credential.encode(), path.read_bytes())
                for relay in self.relays:
                    self.assertNotIn(relay.client_token.encode(), path.read_bytes())
        self.temp.cleanup()

    def contract(self, protocol='chat'):
        self.serial += 1
        directory = self.root / str(self.serial)
        directory.mkdir(mode=0o700)
        path = directory / 'contract.json'
        contract = {'schemaVersion': 1, 'protocol': protocol, 'model': relay_module.MODEL,
                    'stream': True, 'tools': 'none', 'sessionId': 'qa_session',
                    'providerFingerprint': self.snapshot.fingerprint, 'history': self.history,
                    'prompt': self.prompt, 'claudeNoticeNewline': protocol == 'anthropic'}
        relay_module.private_json(path, contract)
        return path, contract

    def start(self, protocol='chat', factory=None, path=None, **kwargs):
        path = path or self.contract(protocol)[0]
        relay = relay_module.start_relay(path, self.snapshot, offline=True,
                                        _connection_factory=factory, **kwargs)
        self.relays.append(relay)
        return relay

    def body(self, protocol='chat'):
        messages = [{'role': item['role'], 'content': item['text']}
                    for item in self.history + [{'role': 'user', 'text': self.prompt}]]
        if protocol == 'anthropic':
            messages[:2] = [{'role': 'user', 'content': [
                {'type': 'text', 'text': self.history[0]['text'] + '\n'},
                {'type': 'text', 'text': self.history[1]['text']}]}]
        return {'model': relay_module.MODEL, 'stream': True,
                'input' if protocol == 'responses' else 'messages': messages}

    def call(self, relay, body=None, route=None, token=None):
        connection = http.client.HTTPConnection('127.0.0.1', relay.server.server_port, timeout=6)
        raw = json.dumps(body or self.body(relay.contract['protocol'])).encode()
        try:
            connection.request('POST', route or relay.route, body=raw,
                headers={'Authorization': 'Bearer ' + (token or relay.client_token),
                         'User-Agent': 'native-fixture', 'Content-Type': 'application/json'})
            response = connection.getresponse()
            result = response.status, response.read(), dict(response.getheaders())
            return result
        except (OSError, http.client.HTTPException):
            return None, b'', {}
        finally:
            connection.close()

    def factory(self, calls, status=200, response=b'{}', entered=None, release=None, hold=None):
        closed = threading.Event()
        class Socket:
            def settimeout(self, _): pass
            def shutdown(self, _): closed.set()
            def close(self): closed.set()
        class Response:
            def __init__(self): self.status = status
            def getheader(self, *_): return 'text/event-stream'
            def read(self, _):
                if hold is not None:
                    hold.set()
                    assert closed.wait(5)
                    raise ConnectionResetError()
                return response
        class Connection:
            def __init__(self, host, port, **kwargs):
                assert host == 'api.deepseek.com' and port == 443
                self.sock = None
            def connect(self):
                if entered:
                    entered.set()
                    assert release.wait(6)
                self.sock = Socket()
            def request(self, method, route, body, headers):
                assert self.auto_open == 0
                calls.append((method, route, body, headers))
            def getresponse(self):
                self.sock = None  # HTTPResponse can take ownership of socket.
                return Response()
            def close(self): pass
        return Connection

    def test_three_protocols_preserve_wire_and_real_auth_only_upstream(self):
        for protocol, upstream in [('anthropic', '/anthropic/v1/messages'), ('chat', '/chat/completions'), ('responses', '/responses')]:
            calls = []
            relay = self.start(protocol, self.factory(calls))
            self.assertEqual(self.call(relay)[0], 200)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][1], upstream)
            self.assertEqual(calls[0][2], json.dumps(self.body(protocol)).encode())
            self.assertEqual(calls[0][3]['Authorization'], 'Bearer ' + self.snapshot._credential)
            self.assertNotIn(relay.client_token, json.dumps(calls[0][3]))
            self.assertEqual(self.call(relay)[0], 409)
            self.assertTrue(relay.summary()['tokenConsumed'])

    def test_body_negative_cases_all_protocols(self):
        count = 0
        for protocol in relay_module.ROUTES:
            _, contract = self.contract(protocol)
            valid = self.body(protocol)
            relay_module.validate_envelope(valid, contract)
            relay_module.validate_body(valid, contract)
            for mutation in ('model', 'stream', 'tools', 'previous_response_id', 'role', 'text', 'prompt', 'order', 'hidden'):
                body = copy.deepcopy(valid)
                messages = body['input' if protocol == 'responses' else 'messages']
                if mutation == 'model': body['model'] = 'other'
                elif mutation == 'stream': body['stream'] = False
                elif mutation == 'tools': body['tools'] = [{'name': 'Bash'}]
                elif mutation == 'previous_response_id': body['previous_response_id'] = 'previous'
                elif mutation == 'role': messages[-2]['role'] = 'user'
                elif mutation == 'text': messages[-2]['content'] += ' altered'
                elif mutation == 'prompt': messages[-1]['content'] = 'Other prompt'
                elif mutation == 'order': messages[-1], messages[-2] = messages[-2], messages[-1]
                elif mutation == 'hidden': messages.insert(-1, {'role': 'user', 'content': 'hidden'})
                with self.assertRaises(AssertionError):
                    relay_module.validate_envelope(body, contract)
                    relay_module.validate_body(body, contract)
                count += 1
        self.assertEqual(count, 27)

    def test_route_auth_reject_before_consuming_token(self):
        relay = self.start()
        for kwargs in ({'route': relay.route.replace('qa_session', 'other')}, {'token': 'wrong'},
                       {'route': relay.route + '?extra=1'}):
            self.assertEqual(self.call(relay, **kwargs)[0], 409)
        self.assertFalse(relay.summary()['tokenConsumed'])

    def test_restart_concurrency_and_exclusive_token(self):
        path, _ = self.contract()
        calls = []
        relays = [self.start(path=path, factory=self.factory(calls)) for _ in range(4)]
        with concurrent.futures.ThreadPoolExecutor() as pool:
            statuses = [result[0] for result in pool.map(self.call, relays)]
        self.assertEqual(statuses.count(200), 1)
        self.assertEqual(statuses.count(409), 3)
        self.assertEqual(len(calls), 1)
        for relay in relays: relay.close()
        restarted = self.start(path=path, factory=self.factory(calls))
        self.assertEqual(self.call(restarted)[0], 409)
        self.assertEqual(len(calls), 1)

    def test_errors_redirect_and_incomplete_stream_never_retry(self):
        for status, response in [(401, b'{}'), (429, b'{}'), (500, b'{}'), (307, b''),
                                 (200, b'event: message_start\ndata: {}\n\n')]:
            calls = []
            relay = self.start(factory=self.factory(calls, status, response))
            result = self.call(relay)
            self.assertEqual(result[0], 502 if status == 307 else status)
            self.assertNotIn('Location', result[2])
            self.assertEqual(self.call(relay)[0], 409)
            self.assertEqual(len(calls), 1)

    def test_late_connect_cancelled_and_token_retained(self):
        entered, release = threading.Event(), threading.Event()
        calls = []
        relay = self.start(factory=self.factory(calls, entered=entered, release=release))
        caller = threading.Thread(target=self.call, args=(relay,)); caller.start()
        self.assertTrue(entered.wait(3))
        closing = threading.Thread(target=relay.close); closing.start()
        self.assertTrue(relay.stop_event.wait(2)); release.set()
        caller.join(5); closing.join(5)
        self.assertFalse(caller.is_alive()); self.assertFalse(closing.is_alive())
        self.assertEqual(calls, []); self.assertTrue(relay.summary()['tokenConsumed'])

    def test_httpresponse_socket_closed_on_cancel(self):
        reading = threading.Event(); calls = []
        relay = self.start(factory=self.factory(calls, hold=reading))
        caller = threading.Thread(target=self.call, args=(relay,)); caller.start()
        self.assertTrue(reading.wait(3)); relay.close(); caller.join(5)
        self.assertFalse(caller.is_alive()); self.assertEqual(len(calls), 1)
        self.assertEqual(relay.summary()['activeSockets'], 0)

    def test_slow_request_body_cancel_closes_client_and_handler(self):
        relay = self.start()
        client = socket.create_connection(('127.0.0.1', relay.server.server_port), timeout=3)
        try:
            client.sendall((f'POST {relay.route} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx').encode())
            deadline = time.monotonic() + 3
            while not relay.summary()['activeClients'] and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertEqual(relay.summary()['activeClients'], 1)
            started = time.monotonic(); relay.close()
            self.assertLess(time.monotonic() - started, 2)
            self.assertEqual(relay.summary()['activeHandlers'], 0)
            self.assertEqual(relay.summary()['activeClients'], 0)
            self.assertFalse(relay.summary()['tokenConsumed'])
        finally:
            client.close()

    def test_client_arriving_after_stop_cannot_register_or_dispatch(self):
        relay = self.start()
        relay.stop_event.set()
        client = socket.create_connection(('127.0.0.1', relay.server.server_port), timeout=3)
        try:
            client.sendall(b'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx')
            try:
                self.assertEqual(client.recv(1), b'')
            except ConnectionResetError:
                pass
            relay.close()
            self.assertEqual(relay.summary()['activeHandlers'], 0)
            self.assertEqual(relay.summary()['activeClients'], 0)
            self.assertFalse(relay.summary()['tokenConsumed'])
        finally:
            client.close()

    def test_provider_snapshot_no_secrets_and_selection_change(self):
        dbpath = self.root / 'synthetic.sqlite'
        env = {'ANTHROPIC_BASE_URL': relay_module.ENDPOINT, 'ANTHROPIC_AUTH_TOKEN': 'synthetic-private-key',
               **{k: relay_module.MODEL for k in ('ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL')}}
        with sqlite3.connect(dbpath) as db:
            db.execute('CREATE TABLE providers(id TEXT,name TEXT,settings_config TEXT,is_current INTEGER,app_type TEXT)')
            db.execute('INSERT INTO providers VALUES(?,?,?,?,?)', ('id','DeepSeek',json.dumps({'env':env}),1,'claude'))
        snapshot = relay_module.load_current_provider(dbpath)
        self.assertNotIn('synthetic-private-key', repr(snapshot) + json.dumps(snapshot.safe_metadata()))
        with sqlite3.connect(dbpath) as db: db.execute("UPDATE providers SET name='Other'")
        with self.assertRaisesRegex(RuntimeError, '^Current DeepSeek provider preflight rejected$'):
            relay_module.load_current_provider(dbpath)

    def test_provider_drift_after_admission_prevents_dispatch(self):
        calls = []; relay = self.start(factory=self.factory(calls))
        with patch.object(relay, 'recheck_provider', side_effect=[None, AssertionError('drift')]):
            self.assertEqual(self.call(relay)[0], 409)
        self.assertEqual(calls, []); self.assertTrue(relay.summary()['tokenConsumed'])

    def test_claude_thinking_only_records_and_exact_final_text(self):
        spec = importlib.util.spec_from_file_location('claude_once_test', Path(__file__).with_name('deepseek-claude-native-once.py'))
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        def record(parts):
            return {'type': 'assistant', 'message': {'role': 'assistant', 'content': parts}}
        thinking = record([{'type': 'thinking', 'thinking': 'Synthetic internal fixture.'}])
        final = record([{'type': 'text', 'text': 'Exact answer.'}])
        audit = module.validate_assistant_records([thinking, final], 'Exact answer.')
        self.assertEqual(audit['thinkingOnlyRecords'], 1)
        invalid = [
            [record([{'type': 'text', 'text': ''}]), final],
            [record([{'type': 'tool_use', 'name': 'Bash'}]), final],
            [record([{'type': 'unknown'}]), final],
            [thinking, record([{'type': 'text', 'text': 'Changed answer.'}])],
            [thinking, final, final],
            [record([{'type': 'thinking'}]), final],
        ]
        for rows in invalid:
            with self.assertRaises(AssertionError):
                module.validate_assistant_records(rows, 'Exact answer.')


if __name__ == '__main__':
    unittest.main()
