#!/usr/bin/env python3
"""Владеет короткой сессией чтения до permit, результата и отмены."""

from __future__ import annotations

import importlib.util
import json
import os
import signal
import subprocess
import sys
import time

from pathlib import Path


sys.dont_write_bytecode = True
PORT = importlib.util.spec_from_file_location(
    "darwin_profile_channel", Path(__file__).with_name("darwin-profile-channel.py"),
)
if PORT is None or PORT.loader is None:
    raise RuntimeError("недоступен Darwin process port")
port = importlib.util.module_from_spec(PORT)
PORT.loader.exec_module(port)

pending = 0


def interrupted(number, _frame):
    global pending
    if not pending:
        pending = number


def quiesce(helper: str, child: subprocess.Popen, root: dict | None) -> None:
    """До регистрации permit закрыт. После неё сигналы используют exact SID."""
    if root is None:
        child.wait(timeout=3)
        return
    ids = {"TERM": set(), "KILL": set()}
    until = time.monotonic() + 8
    empty = 0
    while time.monotonic() < until:
        child.poll()
        rows = json.loads(subprocess.check_output([helper, "uid-census"], timeout=2))
        if not isinstance(rows, list):
            raise ValueError("неполный census read session")
        leader = next((row for row in rows if row["pid"] == root["pid"]), None)
        if leader and leader["starttime"] != root["starttime"]:
            raise ValueError("изменилось поколение read session")
        members = [row for row in rows if row["sid"] == root["sid"]]
        empty = empty + 1 if not members and child.poll() is not None else 0
        if empty == 2:
            return
        name = "KILL" if time.monotonic() > until - 5 else "TERM"
        for row in members:
            identity = (row["pid"], row["starttime"], row["sid"], row["pgid"])
            if identity in ids[name]:
                continue
            result = subprocess.run([helper, "signal-stage-member", *map(str, identity), name],
                                    timeout=2, check=False)
            if result.returncode not in {0, 3}:
                raise ValueError("не доказан владелец процесса reader")
            ids[name].add(identity)
        time.sleep(0.05)
    raise ValueError("не закрыта сессия чтения")


def main() -> int:
    helper, launcher, *args = sys.argv[1:]
    context = bool(args and args[0] == "--host-context")
    if context:
        args.pop(0)
    if not args or any(not os.path.isabs(file) for file in (helper, launcher, args[0])):
        raise ValueError("нужны проверенные программы read session")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    permit, grant = os.pipe()
    child = None
    root = None
    try:
        child = subprocess.Popen([launcher, "--permit-fd", str(permit), "--", *args],
                                 stdin=subprocess.DEVNULL, pass_fds=(permit, 3) if context else (permit,))
        if context:
            os.close(3)
        until = time.monotonic() + 3
        while not pending and time.monotonic() < until and child.poll() is None:
            row = port.process_identity(helper, child.pid)
            if row and row["pid"] == row["sid"] == row["pgid"] and row["ppid"] == os.getpid():
                root = row
                break
            time.sleep(0.02)
        if root is None and not pending:
            raise ValueError("сессия чтения не зарегистрировалась")
        if not pending:
            os.write(grant, b"\x01")
        until = time.monotonic() + 70
        while not pending and time.monotonic() < until and child.poll() is None:
            time.sleep(0.05)
        result = 128 + pending if pending else child.poll()
        return 124 if result is None else result
    finally:
        os.close(permit)
        os.close(grant)
        if child is not None:
            quiesce(helper, child, root)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print("FACTORY_ERROR=release_activity_unknown", file=sys.stderr)
        sys.exit(78)
