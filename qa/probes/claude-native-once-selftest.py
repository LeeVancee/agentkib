"""Pure model-request guard tests; no CLI, config access, or network."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
import threading
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('claude_once', Path(__file__).with_name('claude-native-once.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class GuardTests(unittest.TestCase):
    def test_full_role_text_model_prompt_and_no_tools(self):
        expected = [('user', 'Import notice.'), ('user', 'Marker RANDOM; decision WAL.'), ('assistant', 'Confirmed WAL.')]
        body = {'model': 'claude-opus-5', 'tools': [], 'messages': [
            {'role': 'user', 'content': [{'type': 'text', 'text': 'Import notice.\n'}, {'type': 'text', 'text': 'Marker RANDOM; decision WAL.'}]},
            {'role': 'assistant', 'content': [{'type': 'text', 'text': 'Confirmed WAL.'}]},
            {'role': 'user', 'content': 'Quote history.'},
            {'role': 'system', 'content': 'Known native environment.'}]}
        def verify(candidate):
            return probe.validate_request(json.dumps(candidate).encode(), 'claude-opus-5', expected, 'Quote history.')
        self.assertEqual(verify(body), 'claude-opus-5')
        mutations = []
        candidate = copy.deepcopy(body); candidate['model'] = 'different'; mutations.append(candidate)
        candidate = copy.deepcopy(body); candidate['tools'] = [{'name': 'shell'}]; mutations.append(candidate)
        candidate = copy.deepcopy(body); candidate['messages'][0]['content'].pop(); mutations.append(candidate)
        candidate = copy.deepcopy(body); candidate['messages'][1]['role'] = 'user'; mutations.append(candidate)
        candidate = copy.deepcopy(body); candidate['messages'][0]['content'][1]['text'] += '\n'; mutations.append(candidate)
        candidate = copy.deepcopy(body); candidate['messages'][2]['content'] = 'Different prompt'; mutations.append(candidate)
        candidate = copy.deepcopy(body); candidate['messages'].insert(2, {'role': 'user', 'content': 'Extra hidden instruction'}); mutations.append(candidate)
        for index, candidate in enumerate(mutations):
            with self.subTest(index=index), self.assertRaises(RuntimeError):
                verify(candidate)

    def test_late_connect_cannot_dispatch_after_stop(self):
        entered, release = threading.Event(), threading.Event()
        stopping, gate, sockets = threading.Event(), threading.Lock(), set()
        state, errors = {'upstreamDispatches': 0}, []
        class Socket:
            def settimeout(self, timeout): pass
            def close(self): pass
        class Connection:
            sock = None
            def __init__(self, *args, **kwargs): pass
            def connect(self):
                entered.set(); release.wait(2); self.sock = Socket()
            def request(self, *args, **kwargs): raise AssertionError('Unexpected dispatch')
            def close(self): pass
        def forward():
            try: probe.forward_once('/v1/messages', b'{}', {}, stopping, gate, sockets, state)
            except Exception as error: errors.append(error)
        with patch.object(probe, 'HTTPConnection', Connection), patch.object(probe, 'check_window'):
            thread = threading.Thread(target=forward); thread.start()
            self.assertTrue(entered.wait(2))
            probe.stop_transport(stopping, gate, sockets)
            release.set(); thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(state['upstreamDispatches'], 0)
        self.assertIsInstance(errors[0], RuntimeError)

    def test_response_owned_socket_is_still_cancelled(self):
        reading, closed = threading.Event(), threading.Event()
        stopping, gate, sockets = threading.Event(), threading.Lock(), set()
        state, errors = {'upstreamDispatches': 0}, []
        class Socket:
            def settimeout(self, timeout): pass
            def shutdown(self, how): closed.set()
            def close(self): closed.set()
        class Response:
            status = 200
            def getheader(self, *args): return 'text/event-stream'
            def read(self, size):
                reading.set(); closed.wait(2); raise ConnectionResetError()
        class Connection:
            def __init__(self, *args, **kwargs): self.sock = None
            def connect(self): self.sock = Socket()
            def request(self, *args, **kwargs): pass
            def getresponse(self): self.sock = None; return Response()
            def close(self): pass
        def forward():
            try: probe.forward_once('/v1/messages', b'{}', {}, stopping, gate, sockets, state)
            except Exception as error: errors.append(error)
        with patch.object(probe, 'HTTPConnection', Connection), patch.object(probe, 'check_window'):
            thread = threading.Thread(target=forward); thread.start()
            self.assertTrue(reading.wait(2))
            probe.stop_transport(stopping, gate, sockets)
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertTrue(closed.is_set())
        self.assertEqual(state['upstreamDispatches'], 1)
        self.assertIsInstance(errors[0], ConnectionResetError)


if __name__ == '__main__':
    unittest.main()
