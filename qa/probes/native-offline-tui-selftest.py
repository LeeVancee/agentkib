"""Bounded lifecycle regression checks using only sandboxed local Python children.

Usage: python3 native-offline-tui-selftest.py NEW_EVIDENCE_DIRECTORY
No agent CLI, credentials, model, or network is used. Existing evidence is refused.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import threading
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('evidence_directory', type=Path)
    args = parser.parse_args()
    evidence = args.evidence_directory.resolve()
    os.umask(0o077)
    evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    runner_path = Path(__file__).with_name('native-offline-tui.py')
    source = runner_path.read_bytes()
    spec = importlib.util.spec_from_file_location('native_offline_tui', runner_path)
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(evidence), 'LANG': 'en_US.UTF-8'}
    summary = {'runnerSha256': hashlib.sha256(source).hexdigest(),
               'selftestSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               'networkDeniedByOSSandbox': True, 'cases': [], 'passed': False}

    def run(name, code, *arguments, needles=()):
        return runner.run_owned(runner.SANDBOX + [sys.executable, '-c', code, *arguments],
                                env, evidence, evidence / f'{name}.ansi',
                                timeout=5, needles=needles)

    def gone(record):
        assert record['ownedProcessGroupGone'], record
        assert not runner.group_exists(record['pid']), record

    try:
        # An exited leader must not hide a live descendant retaining the PTY.
        descendant_file = evidence / 'descendant.pid'
        record = run('leader-exits', '''
import os, signal, sys, time
from pathlib import Path
ready = Path(sys.argv[1])
pid = os.fork()
if pid == 0:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    ready.write_text(str(os.getpid()))
    print('DESCENDANT READY', flush=True)
    time.sleep(20)
    os._exit(0)
deadline = time.monotonic() + 3
while not ready.exists() and time.monotonic() < deadline:
    time.sleep(.01)
os._exit(0 if ready.exists() else 2)
''', str(descendant_file))
        assert descendant_file.exists(), 'Descendant never became ready'
        assert int(descendant_file.read_text()) != record['pid']
        assert record['stopReason'] == 'leader-exited', record
        assert record['exitCodeAfterCleanup'] == 0, record
        gone(record)
        summary['cases'].append({'name': 'leader-exits', 'passed': True})

        # A live producer exceeds the cap, so EOF cannot masquerade as bounding.
        record = run('output-cap', '''
import os, sys, time
remaining = int(sys.argv[1]) + 65536
while remaining:
    chunk = b'x' * min(65536, remaining)
    remaining -= os.write(1, chunk)
time.sleep(20)
''', str(runner.MAX_OUTPUT))
        assert record['stopReason'] == 'output-limit', record
        assert record['outputBytes'] == runner.MAX_OUTPUT, record
        assert (evidence / 'output-cap.ansi').stat().st_size == runner.MAX_OUTPUT
        gone(record)
        summary['cases'].append({'name': 'output-cap', 'passed': True})

        # First cancellation arrives only after the child observes cleanup TERM.
        # A second signal must neither replace the first nor interrupt reaping.
        cleaning = evidence / 'cleanup-started'
        stop_sender = threading.Event()
        sent = []
        sender_errors = []

        def send_during_cleanup():
            deadline = time.monotonic() + 5
            while not cleaning.exists():
                if stop_sender.wait(.01):
                    return
                if time.monotonic() >= deadline:
                    sender_errors.append('Child never observed cleanup SIGTERM')
                    return
            for sig in (signal.SIGTERM, signal.SIGINT):
                if stop_sender.is_set():
                    return
                os.kill(os.getpid(), sig)
                sent.append(int(sig))
                if stop_sender.wait(.15):
                    return

        sender = threading.Thread(target=send_during_cleanup)
        sender.start()
        interrupted = False
        try:
            run('cleanup-cancellation', '''
import signal, sys, time
from pathlib import Path
def on_term(signum, frame):
    Path(sys.argv[1]).write_text('cleanup SIGTERM received')
signal.signal(signal.SIGTERM, on_term)
print('READY FOR CLEANUP', flush=True)
time.sleep(20)
''', str(cleaning), needles=(b'READY FOR CLEANUP',))
        except InterruptedError:
            interrupted = True
        finally:
            stop_sender.set()
            sender.join(timeout=1)
        assert not sender.is_alive(), 'Signal sender did not stop'
        assert not sender_errors, sender_errors
        assert sent == [int(signal.SIGTERM), int(signal.SIGINT)], sent
        assert interrupted, 'Cleanup cancellation was swallowed'
        record = json.loads((evidence / 'cleanup-cancellation.json').read_text())
        assert record['cancellationSignal'] == int(signal.SIGTERM), record
        assert record['error'].startswith('InterruptedError:'), record
        assert record['exitCodeAfterCleanup'] == -signal.SIGKILL, record
        gone(record)
        summary['cases'].append({'name': 'cleanup-first-and-repeated-cancellation',
                                 'signalsSent': sent, 'passed': True})
        summary['passed'] = True
    except BaseException as exc:
        summary['error'] = f'{type(exc).__name__}: {exc}'
        raise
    finally:
        (evidence / 'result.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
