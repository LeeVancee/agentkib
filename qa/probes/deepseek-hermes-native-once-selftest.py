"""No provider credentials or model/native-client requests; bounded local fixtures."""
import copy
import importlib.util
import json
import os
import signal
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('hermes_once', Path(__file__).with_name('deepseek-hermes-native-once.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
from deepseek_once_relay import validate_body, validate_envelope, MODEL


class Tests(unittest.TestCase):
    def setUp(self):
        self.rows = [{'role': 'user', 'content': 'marker M; decision WAL', 'blob': b'\x00\xff'},
                     {'role': 'assistant', 'content': 'Confirmed M and WAL', 'blob': None}]
        self.history = [{'role': row['role'], 'text': row['content']} for row in self.rows]

    def test_clean_rejects_old_suffix_changed_blob_and_extra_session(self):
        probe.assert_clean(self.rows, 1, self.history)
        for rows, count in [(self.rows + [{'role': 'user', 'content': 'old live'}], 1), (self.rows, 2)]:
            with self.assertRaises(AssertionError): probe.assert_clean(rows, count, self.history)
        after = copy.deepcopy(self.rows) + [{'role': 'user', 'content': probe.PROMPT}, {'role': 'assistant', 'content': 'reply'}]
        self.assertEqual(probe.assert_continuation(self.rows, after, 1, probe.PROMPT), 'reply')
        after[0]['blob'] = b'changed'
        with self.assertRaises(AssertionError): probe.assert_continuation(self.rows, after, 1, probe.PROMPT)

    def test_suffix_cannot_duplicate_prompt_or_call_tools(self):
        for suffix in [[], [{'role': 'user', 'content': 'different'}],
                       [{'role': 'user', 'content': probe.PROMPT}] * 2,
                       [{'role': 'user', 'content': probe.PROMPT}, {'role': 'tool', 'content': 'run'}],
                       [{'role': 'user', 'content': probe.PROMPT}, {'role': 'assistant', 'content': 'run', 'tool_calls': '[{}]'}]]:
            with self.assertRaises(AssertionError): probe.assert_continuation(self.rows, self.rows + suffix, 1, probe.PROMPT)

    def test_strict_chat_contract(self):
        contract = {'protocol': 'chat', 'model': MODEL, 'stream': True, 'tools': 'none',
                    'sessionId': 'fixture', 'history': self.history, 'prompt': probe.PROMPT}
        body = {'model': MODEL, 'stream': True, 'messages': [{'role': row['role'], 'content': row['text']}
                for row in self.history + [{'role': 'user', 'text': probe.PROMPT}]]}
        validate_envelope(body, contract); validate_body(body, contract)
        for index in range(3):
            changed = copy.deepcopy(body); changed['messages'][index]['content'] += ' changed'
            with self.assertRaises(AssertionError): validate_body(changed, contract)
        with self.assertRaises(AssertionError): validate_envelope(dict(body, tools=[{'type': 'function'}]), contract)
        with self.assertRaises(AssertionError): validate_envelope(dict(body, model='other'), contract)

    def test_override_has_no_credential_and_disables_recovery(self):
        cfg = json.loads(probe.override_config('http://127.0.0.1:1234/session/fixture/v1'))
        self.assertEqual(cfg['providers'][probe.PROVIDER]['key_env'], probe.KEY_ENV)
        self.assertEqual(cfg['agent'], {'api_max_retries': 1, 'auto_recovery_cycles': 0})
        self.assertEqual(cfg['toolsets'], []); self.assertEqual(cfg['platform_toolsets']['cli'], [])
        self.assertFalse(cfg['compression']['enabled']); self.assertFalse(cfg['memory']['memory_enabled'])
        self.assertEqual(cfg['model']['context_length'], 65536)

    def test_live_case_claim_survives_different_attempt_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            case = Path(directory)
            probe.claim_live_case(case, case / 'first', 'synthetic_session', 'plan-hash', 'provider-fingerprint')
            with self.assertRaises(FileExistsError):
                probe.claim_live_case(case, case / 'second', 'synthetic_session', 'plan-hash', 'provider-fingerprint')

    def test_pipe_redacts_split_tokens_before_disk(self):
        with tempfile.TemporaryDirectory() as directory:
            capture = probe.PrivateCapture()
            secret = b'synthetic-private-upstream'; token = b'synthetic-loopback-token'
            for chunk in [b'prefix synthetic-private-', b'upstream\nsynthetic-loopback-', b'token suffix']:
                os.write(capture.write_fd, chunk)
            path = Path(directory) / 'output'
            value = capture.finish(path, lambda raw: raw.replace(secret, b'[REDACTED]').replace(token, b'[REDACTED]'))
            self.assertEqual(value, b'prefix [REDACTED]\n[REDACTED] suffix')
            self.assertEqual(path.read_bytes(), value)

    def test_pipe_output_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            capture = probe.PrivateCapture(limit=4)
            os.write(capture.write_fd, b'0123456789')
            self.assertEqual(capture.finish(Path(directory) / 'out', lambda raw: raw), b'0123')
            self.assertTrue(capture.exceeded.is_set())

    def test_late_cancel_deferred_until_audit_and_forces_failure(self):
        guard = probe.DeferredCancellation()
        original = signal.getsignal(signal.SIGTERM)
        guard.install()
        try:
            # Mimic the helper restoring the supervisor handler on return.
            previous = signal.signal(signal.SIGTERM, lambda *_: None)
            signal.signal(signal.SIGTERM, previous)
            os.kill(os.getpid(), signal.SIGTERM)
            result = {'passed': True, 'realReplyPassed': True, 'syntheticMockReplyPassed': True}
            result['auditCompleted'] = True
            guard.finalize(result)
            self.assertTrue(result['auditCompleted'])
            self.assertEqual(result['supervisorCancellationSignals'], [signal.SIGTERM])
            self.assertFalse(result['passed']); self.assertFalse(result['realReplyPassed'])
            self.assertFalse(result['syntheticMockReplyPassed'])
            with self.assertRaises(SystemExit): guard.checkpoint()
        finally:
            guard.restore()
        self.assertEqual(signal.getsignal(signal.SIGTERM), original)

    def test_native_helper_cancel_also_forces_failure(self):
        result = {'passed': True, 'realReplyPassed': True, 'cancellationSignals': [signal.SIGTERM]}
        probe.DeferredCancellation().finalize(result)
        self.assertFalse(result['passed']); self.assertTrue(result['cancelled'])

    def test_native_reply_must_match_full_cli_text_and_no_extra_request(self):
        row = {'exit_code': 0, 'session_id': 'fixture', 'text': 'full exact reply'}
        summary = {'blocked': 0}
        self.assertTrue(probe.native_reply_matches([row], row['text'], 'fixture', summary))
        self.assertFalse(probe.native_reply_matches([dict(row, text='full exact reply plus drift')], row['text'], 'fixture', summary))
        self.assertFalse(probe.native_reply_matches([row], row['text'], 'fixture', {'blocked': 1}))
        self.assertFalse(probe.native_reply_matches([row, row], row['text'], 'fixture', summary))


if __name__ == '__main__': unittest.main()
