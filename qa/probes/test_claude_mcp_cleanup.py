"""Synthetic process-only regressions; never launches an Agent or model."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location('claude_mcp_offline', Path(__file__).with_name('claude-mcp-offline.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

FIXTURE = '''import json, os, pathlib, signal, sys, time
root = pathlib.Path(sys.argv[1])
pid = os.fork()
if pid == 0:
    os.setsid()
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    (root / 'descendant.json').write_text(json.dumps({'pid': os.getpid()}))
    time.sleep(60)
else:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while not (root / 'parent-exit').exists():
        time.sleep(0.01)
'''


def wait_for(condition, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.025)
    raise AssertionError('Synthetic process condition timed out')


def running(pid):
    return any(row['pid'] == pid and not row['status'].startswith('Z')
               for row in probe.OwnedProcesses.snapshot())


@unittest.skipUnless(sys.platform == 'darwin', 'macOS process observer')
class OwnedCleanupTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='agentkib-mcp-cleanup-')
        self.root = Path(self.directory.name)
        self.child = None
        self.descendant = None
        self.sentinel = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'],
                                         start_new_session=True)

    def tearDown(self):
        if self.child is not None:
            try:
                probe.stop_owned(self.child)
            except Exception:
                # Only exact PIDs from this synthetic fixture are eligible for fallback.
                for pid in (self.child.pid, self.descendant):
                    if pid is not None:
                        try:
                            os.kill(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                self.child.wait(timeout=3)
        self.sentinel.kill()
        self.sentinel.wait(timeout=3)
        self.directory.cleanup()

    def fixture(self):
        self.child = probe.spawn_owned([sys.executable, '-c', FIXTURE, str(self.root)],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        file = self.root / 'descendant.json'
        wait_for(lambda: file.exists() and file.stat().st_size > 0)
        self.descendant = json.loads(file.read_text())['pid']
        wait_for(lambda: self.descendant in self.child.owned_processes.identities)
        self.assertNotEqual(os.getpgid(self.descendant), os.getpgid(self.child.pid))
        self.assertTrue(running(self.descendant))

    def assert_clean(self):
        result = probe.stop_owned(self.child)
        self.assertTrue(result['allRecordedProcessesExited'])
        self.assertGreaterEqual(result['trackedProcessCount'], 2)
        self.assertIsNotNone(self.child.poll())
        self.assertFalse(running(self.descendant))
        self.assertIsNone(self.sentinel.poll(), 'Unrelated process must not be signaled')

    def test_sets_id_descendant_is_stopped_even_when_term_is_ignored(self):
        self.fixture()
        self.assert_clean()

    def test_recorded_descendant_is_stopped_after_parent_already_exited(self):
        self.fixture()
        (self.root / 'parent-exit').touch()
        self.child.wait(timeout=3)
        self.assertTrue(running(self.descendant))
        self.assert_clean()

    def test_unobserved_exited_parent_cannot_report_cleanup_success(self):
        child = subprocess.Popen([sys.executable, '-c', 'pass'], start_new_session=True)
        child.wait(timeout=3)
        with self.assertRaisesRegex(RuntimeError, 'before its identity could be recorded'):
            probe.stop_owned(child)


if __name__ == '__main__':
    unittest.main(verbosity=2)
