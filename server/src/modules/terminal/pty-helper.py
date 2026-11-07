#!/usr/bin/env python3
"""PTY-мост без внешних Python-зависимостей.

stdin/stdout несут только сырые байты терминала, fd 3 — построчный JSON управления.
Так resize никогда не смешивается с вводом пользователя.
"""

import argparse
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def clamp(value, low, high):
    return min(high, max(low, int(value)))


def resize(master_fd, child_pid, cols, rows):
    cols = clamp(cols, 20, 500)
    rows = clamp(rows, 5, 200)
    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    try:
        foreground = os.tcgetpgrp(master_fd)
        if foreground > 0:
            os.killpg(foreground, signal.SIGWINCH)
    except OSError:
        try:
            os.killpg(child_pid, signal.SIGWINCH)
        except ProcessLookupError:
            pass


def session_groups(session_id):
    """Все process group Linux-сессии, включая фоновые jobs интерактивного shell."""
    groups = set()
    try:
        entries = os.listdir("/proc")
    except OSError:
        return groups
    for entry in entries:
        if not entry.isdigit():
            continue
        try:
            raw = open(f"/proc/{entry}/stat", "r", encoding="utf-8").read()
            # comm заключён в скобки и может содержать пробелы; после последней
            # скобки идут state, ppid, pgrp, session.
            fields = raw[raw.rfind(")") + 2:].split()
            pgrp = int(fields[2])
            session = int(fields[3])
            if session == session_id and pgrp > 0:
                groups.add(pgrp)
        except (OSError, ValueError, IndexError):
            continue
    return groups


def process_groups(master_fd, child_pid):
    groups = {child_pid}
    groups.update(session_groups(child_pid))
    try:
        foreground = os.tcgetpgrp(master_fd)
        if foreground > 0:
            groups.add(foreground)
    except OSError:
        pass
    return groups


def signal_groups(groups, sig):
    for group in groups:
        try:
            os.killpg(group, sig)
        except ProcessLookupError:
            pass


def wait_child(child_pid, timeout=0):
    until = time.monotonic() + timeout
    while True:
        try:
            done, status = os.waitpid(child_pid, os.WNOHANG)
        except ChildProcessError:
            return 0
        if done:
            return os.waitstatus_to_exitcode(status)
        if time.monotonic() >= until:
            return None
        time.sleep(0.03)


def terminate(master_fd, child_pid):
    groups = process_groups(master_fd, child_pid)
    signal_groups(groups, signal.SIGHUP)
    try:
        os.close(master_fd)
    except OSError:
        pass
    code = wait_child(child_pid, 0.35)
    # Shell мог уже завершиться, но его background job живёт в той же session
    # со своим pgrp. Ранний return здесь и был источником orphan.
    groups.update(session_groups(child_pid))
    signal_groups(groups, signal.SIGTERM)
    if code is None:
        code = wait_child(child_pid, 0.35)
    time.sleep(0.08)
    groups.update(session_groups(child_pid))
    signal_groups(groups, signal.SIGKILL)
    if code is None:
        code = wait_child(child_pid, 0.5)
    return code or 0


def write_stdout(data):
    view = memoryview(data)
    while view:
        written = os.write(1, view)
        view = view[written:]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cols", type=int, default=100)
    parser.add_argument("--rows", type=int, default=30)
    parser.add_argument("--shell", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--control-fd", type=int, default=3)
    args = parser.parse_args()

    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        os.chdir(args.cwd)
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLUMNS"] = str(clamp(args.cols, 20, 500))
        os.environ["LINES"] = str(clamp(args.rows, 5, 200))
        os.execl(args.shell, args.shell, "-l")

    resize(master_fd, child_pid, args.cols, args.rows)
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)
    signal.signal(signal.SIGINT, stop)

    watched = [master_fd, 0, args.control_fd]
    control = b""
    exit_code = None
    try:
        while not stopping:
            exit_code = wait_child(child_pid)
            if exit_code is not None:
                break
            ready, _, _ = select.select(watched, [], [], 0.2)
            for fd in ready:
                if fd == master_fd:
                    try:
                        data = os.read(master_fd, 65536)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            stopping = True
                            break
                        raise
                    if not data:
                        stopping = True
                        break
                    write_stdout(data)
                elif fd == 0:
                    data = os.read(0, 65536)
                    if data:
                        os.write(master_fd, data)
                    else:
                        watched.remove(0)
                else:
                    data = os.read(args.control_fd, 65536)
                    if not data:
                        stopping = True
                        break
                    control += data
                    while b"\n" in control:
                        line, control = control.split(b"\n", 1)
                        try:
                            message = json.loads(line.decode("utf-8"))
                        except (UnicodeDecodeError, json.JSONDecodeError):
                            continue
                        if message.get("t") == "resize":
                            resize(master_fd, child_pid, message.get("cols", 100), message.get("rows", 30))
                        elif message.get("t") == "close":
                            stopping = True
                            break
    except BrokenPipeError:
        stopping = True
    finally:
        if exit_code is None:
            exit_code = terminate(master_fd, child_pid)
        else:
            # `exit` завершает login-shell, но запущенный им background job может
            # остаться в той же session со своим pgrp. Чистим session и при
            # естественном выходе, сохраняя исходный exit code shell.
            natural_exit_code = exit_code
            terminate(master_fd, child_pid)
            exit_code = natural_exit_code
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
