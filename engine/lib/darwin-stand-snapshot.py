#!/usr/bin/env python3
"""Закрепляет read-only bytes восстановления для копирующего hook стенда."""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import re
import sys
from pathlib import Path


PORT = importlib.util.spec_from_file_location(
    "darwin_transaction_begin", Path(__file__).with_name("darwin-transaction-begin.py"),
)
if PORT is None or PORT.loader is None:
    raise RuntimeError("порт snapshot недоступен")
begin = importlib.util.module_from_spec(PORT)
PORT.loader.exec_module(begin)


def decode_path(value: str) -> str:
    text = os.fsdecode(base64.b64decode(value, validate=True))
    if not text or any(char in text for char in "\0\r\n\t"):
        raise ValueError("некорректное имя scoped файла")
    return text


def stamp_index(record: dict | None) -> tuple | None:
    if record is None:
        return None
    status = record["stat"]
    return (status[0], *status[2:6], record["sha256"])


def verify_indexes(transaction: Path) -> None:
    _, _, raw = begin.stable_file(transaction / "indexes.darwin.json", keep=True, limit=None)
    for repo in json.loads(raw)["repositories"]:
        index = begin.guard.git_location(repo["root"], "--git-path", "index")
        if index != repo["index"]:
            raise ValueError("Git index больше не принадлежит исходному workspace")
        for file, baseline in repo["files"].items():
            if stamp_index(begin.guard.capture_index(file)) != stamp_index(baseline):
                raise ValueError("реальный Git index отличается от восстановленного baseline")


def stand_file(transaction: Path, files: Path, line: str) -> tuple[str, dict]:
    absolute64, root64, relative64, kind, mode, digest, target64, backup = line.split("\t")
    absolute = decode_path(absolute64)
    root = Path(decode_path(root64))
    relative = Path(decode_path(relative64))
    if not root.is_absolute() or root.resolve(strict=True) != root or relative.is_absolute() \
            or ".." in relative.parts or root / relative != Path(absolute):
        raise ValueError("изменена привязка путей scope")
    evidence = {"repo": str(root), "relative": str(relative), "type": kind}
    if kind == "missing" and (mode, digest, target64, backup) == ("-", "-", "-", "-"):
        return absolute, evidence
    if not re.fullmatch(r"[0-7]{1,4}", mode) or not begin.DIGEST.fullmatch(digest):
        raise ValueError("нет метаданных объекта scope")
    evidence.update({"mode": mode, "sha256": digest})
    if kind == "symlink" and backup == "-":
        target = base64.b64decode(target64, validate=True)
        if hashlib.sha256(target).hexdigest() != digest:
            raise ValueError("изменилась ссылка в baseline")
        evidence["targetBase64"] = target64
    elif kind == "file" and target64 == "-" and backup == "backups/" + hashlib.sha256(os.fsencode(absolute)).hexdigest() + ".data":
        _, actual, data = begin.stable_file(transaction / backup, keep=True, limit=None, sync=True)
        if actual != digest:
            raise ValueError("исходные bytes восстановления не совпадают с baseline")
        name = digest + ".data"
        begin.guard.publish_immutable(files, name, data, mode=0o400)
        evidence["source"] = "files/" + name
    else:
        raise ValueError("тип файла не поддерживается snapshot")
    return absolute, evidence


def create_snapshot(transaction: Path, task: str) -> None:
    root = transaction / "stand-snapshot"
    files = root / "files"
    for directory in (root, files):
        if not os.path.lexists(directory):
            directory.mkdir(mode=0o700)
        begin.owned_directory(directory)
        begin.guard.sync_directory(directory)
        begin.guard.sync_directory(directory.parent)
    _, baseline, _ = begin.stable_file(transaction / "baseline.tsv")
    _, scope_sha, scope = begin.stable_file(transaction / "scope.list", keep=True, limit=None)
    _, _, raw = begin.stable_file(transaction / "files.tsv", keep=True, limit=None)
    entries = [stand_file(transaction, files, line) for line in os.fsdecode(raw).splitlines()]
    if [absolute for absolute, _ in entries] != os.fsdecode(scope).splitlines():
        raise ValueError("опись файлов не соответствует точному scope")
    effect = [entry for _, entry in entries]
    effect_hash = hashlib.sha256(begin.encoded({"files": effect})).hexdigest()
    manifest = {"version": 1, "task": task, "txid": transaction.name, "baselineSHA256": baseline,
                "scopeSHA256": scope_sha, "appliedSHA256": effect_hash, "files": effect}
    data = begin.encoded(manifest)
    begin.guard.publish_immutable(root, "manifest.json", data, mode=0o400)
    print(hashlib.sha256(data).hexdigest(), effect_hash, sep="\t")


def main() -> None:
    action, transaction_raw, *args = sys.argv[1:]
    transaction = Path(transaction_raw)
    begin.owned_directory(transaction)
    if action == "verify-indexes" and not args:
        verify_indexes(transaction)
    elif action == "snapshot" and len(args) == 1 and begin.TASK.fullmatch(args[0]) \
            and begin.TXID.fullmatch(transaction.name):
        create_snapshot(transaction, args[0])
    else:
        raise ValueError("неизвестная операция восстановления стенда")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError):
        print("FACTORY_ERROR=release_task_cleanup_required", file=sys.stderr)
        sys.exit(78)
