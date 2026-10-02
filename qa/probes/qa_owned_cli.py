"""Bounded owned-process cleanup for isolated QA config; never reads credentials."""
import os
import signal
import subprocess
import time


def run_owned_cli(args, *, env, cwd, config, original, modified, prompt, stdout, stderr, result, should_stop,
                  timeout=150):
    previous = {}
    child = None
    signals = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
    starting = True
    cleaning = False
    cancellation = None
    cancellation_signals = []

    def cancel(signum, _frame):
        nonlocal cancellation
        cancellation_signals.append(signum)
        if cancellation is None:
            cancellation = signum
        if not starting and not cleaning:
            raise SystemExit(128 + signum)

    for signum in signals:
        previous[signum] = signal.signal(signum, cancel)
    try:
        config.write_bytes(modified)
        if cancellation is not None:
            raise SystemExit(128 + cancellation)
        child = subprocess.Popen(args, env=env, cwd=cwd, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr,
                                 start_new_session=True)
        result['ownedCliPid'] = child.pid
        starting = False
        if cancellation is not None:
            raise SystemExit(128 + cancellation)
        child.stdin.write(prompt.encode()); child.stdin.close()
        deadline = time.monotonic() + timeout
        while child.poll() is None and time.monotonic() < deadline:
            if should_stop():
                result['stoppedAfterBlockedExtraAttempt'] = True
                break
            try:
                child.wait(timeout=0.1)
            except subprocess.TimeoutExpired:
                pass
    finally:
        # Preserve even the first cancellation arriving during successful cleanup.
        # Further signals defer to the same bounded cleanup rather than interrupt it.
        cleaning = True
        try:
            try:
                if child is not None:
                    def stop_group(signum):
                        try:
                            os.killpg(child.pid, signum)
                        except ProcessLookupError:
                            pass
                    stop_group(signal.SIGTERM)
                    try:
                        child.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        stop_group(signal.SIGKILL)
                        child.wait(timeout=3)
                    # A CLI may fork a descendant and exit before its descendant.
                    stop_group(signal.SIGKILL)
                    result['cliExitCode'] = child.returncode
                    result['ownedCliCleanupCompleted'] = True
                else:
                    result['cliExitCode'] = None
            finally:
                # Even process-exit races or an uninterruptible child must not skip
                # restoring our isolated config; external edits stay preserved.
                if config.read_bytes() == modified:
                    config.write_bytes(original)
                    result['isolatedConfigRestored'] = True
                else:
                    result['isolatedConfigRestored'] = False
                    result['configExternalChange'] = 'Preserved external change; original backup retained'
        finally:
            result['cancellationSignals'] = list(cancellation_signals)
            for signum, handler in previous.items():
                signal.signal(signum, handler)
    if cancellation is not None:
        raise SystemExit(128 + cancellation)
