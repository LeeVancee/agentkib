"""Bounded PTY adapter for the isolated native Codex shared-server probe only."""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 180, 0, 0))


def own_terminal():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)


child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave,
                         preexec_fn=own_terminal)
os.close(slave)
cancelled = False


def cancel(_sig, _frame):
    global cancelled
    cancelled = True


for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(sig, cancel)

deadline = time.monotonic() + 75
total = 0
try:
    while not cancelled and time.monotonic() < deadline:
        readers = [master]
        if not sys.stdin.closed:
            readers.append(sys.stdin.fileno())
        ready, _, _ = select.select(readers, [], [], 0.1)
        if master in ready:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
            if not chunk:
                break
            total += len(chunk)
            if total > 4 * 1024 * 1024:
                raise RuntimeError("Native TUI output budget exceeded")
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
            if b"\x1b[6n" in chunk:
                os.write(master, b"\x1b[1;1R")
            if b"\x1b]11;?" in chunk:
                os.write(master, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
        if sys.stdin.fileno() in ready:
            chunk = os.read(sys.stdin.fileno(), 65536)
            if not chunk:
                break
            os.write(master, chunk)
        if child.poll() is not None:
            break
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=3)
    os.close(master)
