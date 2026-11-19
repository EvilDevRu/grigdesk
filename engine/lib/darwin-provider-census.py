#!/usr/bin/env python3
"""Добавляет только проверенные provider SID к снимку сессии раннера."""

import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path


sys.dont_write_bytecode = True
PORT = importlib.util.spec_from_file_location(
    "darwin_profile_channel", Path(__file__).with_name("darwin-profile-channel.py"),
)
if PORT is None or PORT.loader is None:
    raise RuntimeError("не доступен Darwin process port")
port = importlib.util.module_from_spec(PORT)
PORT.loader.exec_module(port)
NAME = re.compile(r"t([1-9][0-9]{0,18})\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json")


def provider_members(row, census):
    """Повторный PID лидера не доказывает принадлежность старой сессии."""
    child = row["child"]
    if child is None:
        raise ValueError("held provider пока не закреплён")
    if not (child["pid"] == child["sid"] == child["pgid"] != row["runner"]["sid"]):
        raise ValueError("сессия provider совпала с раннером")
    if any(item["pid"] == child["pid"] and (item["starttime"] != child["starttime"] or item["sid"] != child["sid"])
           for item in census):
        raise ValueError("чужой владелец в сессии provider")
    members = [item for item in census if item["sid"] == child["sid"]]
    if any(int(item["starttime"]) < int(child["starttime"]) for item in members):
        raise ValueError("не доказаны участники provider SID")
    return members


def main():
    root, helper, sid_raw, started, requirement = sys.argv[1:]
    sid = int(sid_raw)
    census = json.loads(subprocess.check_output([helper, "uid-census"], timeout=3))
    if not isinstance(census, list) or any(row["pid"] == sid and row["starttime"] != started for row in census):
        raise ValueError("сессия раннера сменилась")
    rows = [row for row in census if row["sid"] == sid]
    if requirement == "yes" and rows and not any(row["pid"] == sid and row["pgid"] == sid for row in rows):
        raise ValueError("не найден точный лидер сессии")
    directory = Path(root) / "external-provider-processes"
    if os.path.lexists(directory):
        port.begin.owned_directory(directory)
        boot = port.boot_id(helper)
        for file in directory.iterdir():
            if file.name.startswith("."):
                continue
            match = NAME.fullmatch(file.name)
            record = port.begin.read_proof(file)
            if not match or record is None or record.get("task") != match[1]:
                raise ValueError("повреждена запись provider")
            if record["runner"]["sid"] == sid and record["boot"] == boot:
                if record["runner"]["pid"] != sid or record["runner"]["starttime"] != started:
                    raise ValueError("provider относится к другому запуску")
                rows.extend(provider_members(record, census))
    if len({row["pid"] for row in rows}) != len(rows):
        raise ValueError("provider PID связан с двумя сессиями")
    print(json.dumps(rows, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        print("provider session ownership unknown", file=sys.stderr)
        sys.exit(78)
