"""Two bounded, offline native history views without model prompts or credentials.

Usage: python3 native-offline-tui.py EXISTING_CASE NEW_EVIDENCE_DIR
The evidence directory must not exist. Every native process and independent
readback/source export runs under macOS network-denying sandbox-exec. The
supervisor stays outside that sandbox so Darwin permits process-group checks.
"""
import argparse
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

SANDBOX = ['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network*)']
SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
PATH_KEYS = {'HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME', 'CURSOR_CONFIG_DIR',
             'HERMES_HOME', 'AGENTKIB_BENCHMARK_DATA_DIR', 'OPENCLAW_STATE_DIR',
             'OPENCLAW_CONFIG_PATH', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME',
             'XDG_STATE_HOME', 'XDG_CACHE_HOME'}
FLAG_KEYS = {'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_DEFAULT_PLUGINS',
             'OPENCODE_DISABLE_MODELS_FETCH', 'HERMES_STATE_DB_TEST_MODE'}
MAX_OUTPUT = 2 * 1024 * 1024


def isolated_environment(case):
    env = json.loads((case / 'environment.json').read_text())
    assert not set(env) - (PATH_KEYS | FLAG_KEYS | {'PATH', 'LANG'}), 'Unexpected environment key'
    assert {'HOME', 'PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'} <= set(env)
    for key in PATH_KEYS & set(env):
        assert Path(env[key]).resolve().is_relative_to(case), f'{key} escapes isolated case'
    env.update(TERM='xterm-256color', OPENAI_BASE_URL='http://127.0.0.1:9/v1',
               HTTPS_PROXY='http://127.0.0.1:9', HTTP_PROXY='http://127.0.0.1:9',
               ALL_PROXY='http://127.0.0.1:9')
    return env


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def group_exists(pgid):
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # Darwin can briefly report EPERM for an already empty process group.
        # Do not equate permission denial with absence without checking ps.
        snapshot = subprocess.run(['/bin/ps', '-axo', 'pgid='], check=True,
                                  capture_output=True, text=True, timeout=3,
                                  env={'PATH': '/usr/bin:/bin'})
        return str(pgid) in snapshot.stdout.split()


def cleanup(child):
    # Always address our session's group, even if the leader already exited.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        child.poll()  # Reap an exited leader before Darwin's group signal check.
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            child.poll()
            if group_exists(child.pid):
                raise
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            child.poll()
            if not group_exists(child.pid):
                break
            time.sleep(.05)
        if not group_exists(child.pid):
            break
    child.wait(timeout=1)
    return {'exitCodeAfterCleanup': child.returncode,
            'ownedProcessGroupGone': not group_exists(child.pid)}


def run_owned(command, env, cwd, output_path, *, timeout, needles=(), decline_setup=False):
    result = {'command': command, 'timeoutSeconds': timeout, 'outputLimitBytes': MAX_OUTPUT,
              'networkDeniedByOSSandbox': command[:len(SANDBOX)] == SANDBOX,
              'inputSent': [], 'noModelPromptSent': True}
    output = bytearray()
    child = None
    master = slave = None
    cancellation = None
    starting = True
    old_handlers = {}

    def cancel(signum, _frame):
        nonlocal cancellation
        if cancellation is None:
            cancellation = signum
        if not starting:
            raise InterruptedError(f'Cancelled by signal {signum}')

    def defer_cancel(signum, _frame):
        nonlocal cancellation
        if cancellation is None:
            cancellation = signum

    for sig in SIGNALS:
        old_handlers[sig] = signal.signal(sig, cancel)
    try:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 80, 200, 0, 0))
        child = subprocess.Popen(command, env=env, cwd=cwd, stdin=slave, stdout=slave,
                                 stderr=slave, start_new_session=True)
        result['pid'] = child.pid
        starting = False
        os.close(slave)
        slave = None
        if cancellation is not None:
            raise InterruptedError(f'Cancelled by signal {cancellation}')
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]:
                try:
                    chunk = os.read(master, min(65536, MAX_OUTPUT - len(output)))
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    chunk = b''
                if not chunk:
                    result['stopReason'] = 'pty-eof'
                    break
                output.extend(chunk)
                if decline_setup and not result['inputSent'] and b'Set up a provider now? [Y/n]:' in output:
                    os.write(master, b'n\n')
                    result['inputSent'].append('n\\n (decline provider setup)')
                if needles and all(needle in output for needle in needles):
                    result['stopReason'] = 'history-visible'
                    break
                if len(output) == MAX_OUTPUT:
                    result['stopReason'] = 'output-limit'
                    break
            elif child.poll() is not None:
                result['stopReason'] = 'leader-exited'
                break
        else:
            result['stopReason'] = 'timeout'
    except BaseException as exc:
        result['error'] = f'{type(exc).__name__}: {exc}'
        raise
    finally:
        for sig in SIGNALS:
            signal.signal(sig, defer_cancel)
        try:
            if child is not None:
                result.update(cleanup(child))
        finally:
            for fd in (master, slave):
                if fd is not None:
                    os.close(fd)
            result['outputBytes'] = len(output)
            result['needleMatches'] = [needle in output for needle in needles]
            result['cancellationSignal'] = cancellation
            if cancellation is not None:
                result.setdefault('error', f'InterruptedError: Cancelled by signal {cancellation}')
            output_path.write_bytes(output)
            save(output_path.with_suffix('.json'), result)
            for sig, handler in old_handlers.items():
                signal.signal(sig, handler)
    if cancellation is not None:
        raise InterruptedError(f'Cancelled by signal {cancellation}')
    return result


def main():
    runner_source = Path(__file__).read_bytes()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('case', type=Path)
    parser.add_argument('evidence_dir', type=Path)
    args = parser.parse_args()
    case = args.case.resolve()
    evidence = args.evidence_dir.resolve()
    env = isolated_environment(case)
    os.umask(0o077)
    evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    (evidence / 'runner.py').write_bytes(runner_source)
    result = json.loads((case / 'result.json').read_text())
    plan_file, = (case / 'data/continuations').rglob('plan.json')
    plan = json.loads(plan_file.read_text())
    target = result['target']
    assert target in {'hermes', 'opencode'}
    assert Path(plan['workspace']).resolve().is_relative_to(case)
    sid = result['operations'][0]['target_session_id']
    summary = {'case': str(case), 'evidenceDirectory': str(evidence), 'target': target,
               'runnerSha256': hashlib.sha256(runner_source).hexdigest(),
               'sessionId': sid, 'allNativeChildrenNetworkDenied': True,
               'supervisorOutsideSandboxForProcessInspection': True, 'runs': [], 'passed': False}
    save(evidence / 'environment.json', env)
    before_done = False

    def readback(name):
        destination = evidence / name
        destination.mkdir(mode=0o700)
        code = ('import sys; sys.path.insert(0, sys.argv[1]); '
                'from interop_native_readback import verify; '
                'verify(sys.argv[2], evidence_dir=sys.argv[3])')
        record = run_owned(SANDBOX + [sys.executable, '-c', code, str(Path(__file__).parent),
                           str(case), str(destination)], env, plan['workspace'],
                           evidence / f'{name}-verification.ansi', timeout=45)
        assert record['ownedProcessGroupGone'], 'Readback process group survived cleanup'
        assert record['exitCodeAfterCleanup'] == 0, f'{name} independent verification failed'
        return json.loads((destination / 'independent-verification.json').read_text())

    try:
        # Existing verifier covers receipts, identity, source snapshot/hash, exact
        # roles/order/full text and the target store's session cardinality.
        summary['before'] = readback('before')
        before_done = True
        version = run_owned(SANDBOX + [plan['executable'], '--version'], env, plan['workspace'],
                            evidence / 'version.ansi', timeout=15)
        summary['version'] = version
        assert version['ownedProcessGroupGone'], 'Version process group survived cleanup'
        assert version['exitCodeAfterCleanup'] == 0, 'Version command failed'
        reported = re.search(r'(?<!\d)(\d+\.\d+\.\d+)(?!\d)',
                             (evidence / 'version.ansi').read_text())
        pinned = {'hermes': '0.21.5', 'opencode': '1.18.32'}[target]
        summary['reportedVersion'] = reported.group(1) if reported else None
        assert summary['reportedVersion'] == plan['version'] == pinned, 'Pinned CLI version drift'
        native_args = (['--profile', 'default', '--resume', sid] if target == 'hermes'
                       else ['--session', sid])
        for run in range(2):
            record = run_owned(SANDBOX + [plan['executable'], *native_args], env,
                               plan['workspace'], evidence / f'tui-{run + 1}.ansi', timeout=25,
                               needles=(result['marker'].encode(), result['decision'].encode()),
                               decline_setup=target == 'hermes')
            record.update(run=run + 1, markerVisible=record['needleMatches'][0],
                          decisionVisible=record['needleMatches'][1])
            summary['runs'].append(record)
            assert record['ownedProcessGroupGone'], 'TUI process group survived cleanup'
            assert all(record['needleMatches']), f'Native history missing: {record["stopReason"]}'
        summary['passed'] = True
    except BaseException as exc:
        summary['error'] = f'{type(exc).__name__}: {exc}'
    finally:
        if before_done:
            try:
                summary['after'] = readback('after')
            except BaseException as exc:
                summary['passed'] = False
                summary['afterError'] = f'{type(exc).__name__}: {exc}'
        save(evidence / 'result.json', summary)
    print(json.dumps(summary))
    return 0 if summary['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
