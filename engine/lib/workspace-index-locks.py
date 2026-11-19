#!/usr/bin/env python3
"""Владеет Git index.lock от проверки TX до восстановления последнего файла."""

from __future__ import annotations

import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path


LOCKS = "index-restore-locks.json"
GUARD_FILE = Path(__file__).with_name("workspace-guard-darwin.py")
GUARD = importlib.util.spec_from_file_location("workspace_guard_darwin", GUARD_FILE)
if GUARD is None or GUARD.loader is None:
    raise RuntimeError("Git guard недоступен")
guard = importlib.util.module_from_spec(GUARD)
GUARD.loader.exec_module(guard)


@contextmanager
def opened_parent(directory: Path):
    """Удерживает тот же физический каталог для проверки, rename и unlink."""
    if directory.resolve(strict=True) != directory:
        raise ValueError("нефизический parent Git index")
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        named = directory.lstat()
        if not stat.S_ISDIR(opened.st_mode) or opened.st_uid != os.geteuid() \
                or (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
            raise ValueError("изменился parent Git index")
        yield fd
    finally:
        os.close(fd)


def read_record(file: Path, mode: int) -> dict | None:
    """Nofollow читает ровно одну private metadata, ENOENT допускается отдельно."""
    try:
        fd = os.open(file, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as source:
        status = os.fstat(fd)
        if not stat.S_ISREG(status.st_mode) or status.st_uid != os.geteuid() or status.st_nlink != 1 \
                or stat.S_IMODE(status.st_mode) != mode or status.st_size > 1024 * 1024:
            raise ValueError("невалидное состояние index locks")
        data = source.read(1024 * 1024 + 1)
        found = file.lstat()
        if len(data) != status.st_size or (status.st_dev, status.st_ino) != (found.st_dev, found.st_ino):
            raise ValueError("владелец index lock сменился")
    value = json.loads(data)
    if not isinstance(value, dict) or value.get("format") != 1:
        raise ValueError("неизвестное состояние index locks")
    return value


def write_record(transaction: Path, value: dict) -> None:
    """Синхронизирует доказательство нашего inode до no-replace rename."""
    with opened_parent(transaction) as parent:
        descriptor, file = tempfile.mkstemp(prefix=".restore-locks.", dir=transaction)
        temporary = Path(file)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(value, output, ensure_ascii=True)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary.name, LOCKS, src_dir_fd=parent, dst_dir_fd=parent)
            os.fsync(parent)
        finally:
            temporary.unlink(missing_ok=True)


def owner_identity(pid: int) -> dict | None:
    """Доказанная смерть отличается от отказа чтения и недоступного helper."""
    if pid <= 1:
        raise ValueError("невалидный PID владельца index lock")
    helper = Path(os.environ.get("FACTORY_DARWIN_PROCESS_HELPER", ""))
    if not helper.is_absolute() or helper.resolve(strict=True) != helper:
        raise ValueError("неподтверждённый native helper")
    options = {
        "stdin": subprocess.DEVNULL, "stdout": subprocess.PIPE, "stderr": subprocess.DEVNULL,
        "check": False, "env": {}, "timeout": 3,
    }
    identity = subprocess.run([helper, "identity", str(pid)], **options)
    if identity.returncode == 3:
        return None
    identity.check_returncode()
    process = json.loads(identity.stdout)
    boot = subprocess.run([helper, "boot-id"], **options)
    boot.check_returncode()
    boot_id = boot.stdout.decode("ascii").strip().lower()
    if process["pid"] != pid or process["uid"] != os.geteuid() \
            or not re.fullmatch(r"[0-9]{7,26}", process["starttime"]) \
            or not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", boot_id):
        raise ValueError("неполная identity владельца index lock")
    return {"pid": pid, "starttime": process["starttime"], "bootId": boot_id}


def exact_stat(fd: int, name: str, recorded: dict) -> bool:
    """Отличает inode нашей записи от любого чужого Git lock."""
    try:
        found = os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return False
    return stat.S_ISREG(found.st_mode) and found.st_uid == os.geteuid() and found.st_nlink == 1 \
        and stat.S_IMODE(found.st_mode) == 0o600 and [found.st_dev, found.st_ino] == recorded["identity"]


def retire(transaction: Path, saved: dict, indexes: list[Path]) -> None:
    """Снимает только наши temp/lock inode и подтверждает sync каждого родителя."""
    expected = {str(index) for index in indexes}
    for record in reversed(saved["locks"]):
        index = Path(record["index"])
        temporary = record["temporary"]
        if str(index) not in expected or re.fullmatch(r"\.grigdesk-index-lock-[0-9a-f]{32}", temporary) is None:
            raise ValueError("посторонняя запись Git lock")
        with opened_parent(index.parent) as parent:
            for name in (temporary, index.name + ".lock"):
                if exact_stat(parent, name, record):
                    os.unlink(name, dir_fd=parent)
            os.fsync(parent)
    with opened_parent(transaction) as parent:
        os.unlink(LOCKS, dir_fd=parent)
        os.fsync(parent)


def acquire(transaction: Path, owner: dict, indexes: list[Path], previous: dict | None) -> None:
    """Берёт все реальные index locks в одном порядке до workspace write."""
    if previous is not None:
        recorded = previous["owner"]
        observed = owner_identity(recorded["pid"]) if recorded["bootId"] == owner["bootId"] else None
        if observed == recorded:
            raise ValueError("прошлый владелец index locks жив")
        retire(transaction, previous, indexes)
    claim = {"format": 1, "transaction": transaction.name, "owner": owner, "locks": []}
    write_record(transaction, claim)
    for index in indexes:
        with opened_parent(index.parent) as parent:
            temporary = ".grigdesk-index-lock-" + uuid.uuid4().hex
            mode = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW
            fd = os.open(temporary, mode, 0o600, dir_fd=parent)
            with os.fdopen(fd, "wb") as temp:
                status = os.fstat(fd)
                os.fsync(temp.fileno())
            record = {
                "index": str(index), "temporary": temporary, "identity": [status.st_dev, status.st_ino],
            }
            claim["locks"].append(record)
            os.fsync(parent)
            write_record(transaction, claim)
            guard.rename_exclusive(parent, temporary, index.name + ".lock")
            os.fsync(parent)
            if not exact_stat(parent, index.name + ".lock", record):
                raise ValueError("Git lock изменился после публикации")


def same_contents(current: dict | None, baseline: dict | None) -> bool:
    """Восстановленный индекс может иметь свой inode, но сохраняет исходное состояние."""
    if current is None or baseline is None:
        return current is baseline
    actual = current["stat"]
    original = baseline["stat"]
    return actual[0] == original[0] and actual[2:6] == original[2:6] and current["sha256"] == baseline["sha256"]


def attest_restore(transaction: Path, baseline: dict, checkpoint: str, claim: dict):
    """Перед любой записью проверяет все реальные Git locks и обе разрешённые версии index."""
    if re.fullmatch(r"(?:0|[1-9][0-9]{0,17})", checkpoint) is None:
        raise ValueError("невалидное поколение восстановления")
    expected = None
    if checkpoint != "0":
        expected = read_record(transaction / f"indexes-expected-{checkpoint}.json", 0o600)
        if expected is None or expected.get("checkpoint") != checkpoint:
            raise ValueError("нет точного checkpoint Git index")
        workspace = guard.capture_index(str(transaction / f"checkpoint-{checkpoint}.tsv"))
        if workspace is None or workspace["sha256"] != expected.get("workspaceSHA256"):
            raise ValueError("не совпадает поколение workspace/index checkpoint")
    locks = {item["index"]: item for item in claim["locks"]}
    changes = []
    for repository in baseline["repositories"]:
        root = repository["root"]
        actual_index = guard.git_location(root, "--git-path", "index")
        index = Path(repository["index"])
        record = locks.get(str(index))
        if str(index) != actual_index or record is None:
            raise ValueError("физический index изменился со времени begin")
        with opened_parent(index.parent) as parent:
            if not exact_stat(parent, index.name + ".lock", record):
                raise ValueError("утрачен родной Git lock")
        original_files = repository["files"]
        if expected is None:
            if any(guard.capture_index(name) != version for name, version in original_files.items()):
                raise ValueError("первый допуск ещё не выдан, а реальный index изменился")
            continue
        expected_files = expected["repositories"][root]
        previous = guard.capture_index(str(index))
        if not same_contents(previous, original_files[str(index)]):
            if previous != expected_files.get(str(index)) or any(
                guard.capture_index(name) != version for name, version in expected_files.items()
            ):
                raise ValueError("текущий Git index изменён вне точного checkpoint")
        folder = transaction / "indexes" / repository["backup"]
        for source, version in sorted(original_files.items(), key=lambda row: row[0] == str(index)):
            target = Path(source)
            original = guard.capture_index(source)
            if target == index and previous != original:
                raise ValueError("реальный Git index изменился внутри proof")
            if target != index and original is not None and not same_contents(original, version):
                raise ValueError("чужая split-index база")
            if version is not None:
                backed = guard.capture_index(str(folder / target.name))
                if backed is None or backed["sha256"] != version["sha256"] or backed["stat"][5] != version["stat"][5]:
                    raise ValueError("повреждена резервная копия Git index")
            if not same_contents(original, version):
                changes.append((index, record, target, folder / target.name, original, version))
    return changes


def restore_entry(
    index: Path, lock: dict, target: Path, backup: Path, expected: dict | None, baseline: dict | None,
) -> None:
    """Публикует отдельный временный inode под прежним Git lock и синхронизирует parent."""
    with opened_parent(index.parent) as held:
        with opened_parent(target.parent) as parent:
            if not exact_stat(held, index.name + ".lock", lock) or guard.capture_index(str(target)) != expected:
                raise ValueError("изменён Git lock или реальный index")
            if baseline is None:
                if target != index:
                    raise ValueError("недопустимое удаление split base")
                os.unlink(target.name, dir_fd=parent)
                os.fsync(parent)
                return
            staging = target.parent / (".grigdesk-index-restore-" + uuid.uuid4().hex)
            try:
                backed = guard.capture_index(str(backup), staging)
                if backed is None or backed["sha256"] != baseline["sha256"]:
                    raise ValueError("изменилась резервная копия index")
                fd = os.open(staging.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
                try:
                    os.fchmod(fd, stat.S_IMODE(baseline["stat"][3]))
                    os.utime(fd, ns=(os.fstat(fd).st_atime_ns, baseline["stat"][5]))
                    if os.fstat(fd).st_mtime_ns != baseline["stat"][5]:
                        raise ValueError("неточный mtime восстановленного index")
                    os.fsync(fd)
                finally:
                    os.close(fd)
                if not exact_stat(held, index.name + ".lock", lock) or guard.capture_index(str(target)) != expected:
                    raise ValueError("реальный index изменился до atomic replace")
                if target == index:
                    os.replace(staging.name, target.name, src_dir_fd=parent, dst_dir_fd=parent)
                else:
                    guard.rename_exclusive(parent, staging.name, target.name)
                os.fsync(parent)
            finally:
                staging.unlink(missing_ok=True)


def main() -> None:
    """Shell владеет TX lock и передаёт свой точный PID между acquire/release."""
    action, raw, pid, *arguments = sys.argv[1:]
    transaction = Path(raw)
    if transaction.resolve(strict=True) != transaction or transaction.stat().st_mode & 0o077:
        raise ValueError("невалидная директория транзакции")
    baseline = read_record(transaction / "indexes.darwin.json", 0o400)
    if baseline is None:
        raise ValueError("baseline index отсутствует")
    indexes = sorted({Path(row["index"]) for row in baseline["repositories"]})
    if not indexes or any(not file.is_absolute() or file.name != "index" for file in indexes):
        raise ValueError("неопознанный Git index")
    owner = owner_identity(int(pid))
    if owner is None:
        raise ValueError("утрачен владелец восстановления")
    previous = read_record(transaction / LOCKS, 0o600)
    if previous is not None and previous.get("transaction") != transaction.name:
        raise ValueError("запись принадлежит другой транзакции")
    if action in {"verify", "restore"} and len(arguments) == 1:
        if previous is None or previous["owner"] != owner:
            raise ValueError("не закреплён владелец восстановления")
        changes = attest_restore(transaction, baseline, arguments[0], previous)
        if action == "restore":
            for change in changes:
                restore_entry(*change)
            if attest_restore(transaction, baseline, arguments[0], previous):
                raise ValueError("восстановление Git index не подтверждено")
        return
    if action in {"release", "retire-completed"} and not arguments:
        if previous is not None and previous["owner"] == owner:
            retire(transaction, previous, indexes)
        elif previous is not None and action == "retire-completed":
            recorded = previous["owner"]
            if recorded["bootId"] == owner["bootId"] and owner_identity(recorded["pid"]) == recorded:
                raise ValueError("владелец Git locks ещё жив")
            retire(transaction, previous, indexes)
        elif previous is not None:
            raise ValueError("снятие чужого Git lock запрещено")
        return
    if action != "acquire":
        raise ValueError("неизвестное действие Git lock")
    try:
        acquire(transaction, owner, indexes, previous)
    except (ValueError, OSError):
        current = read_record(transaction / LOCKS, 0o600)
        if current is not None and current["owner"] == owner:
            retire(transaction, current, indexes)
        raise


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print("instrumentation: не удалось подтвердить Git index lock", file=sys.stderr)
        sys.exit(75)
