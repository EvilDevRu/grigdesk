#!/usr/bin/env python3
"""Открывает и восстанавливает канал профиля из закреплённого описания."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import select
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


PORT = importlib.util.spec_from_file_location(
    "darwin_transaction_begin", Path(__file__).with_name("darwin-transaction-begin.py"),
)
if PORT is None or PORT.loader is None:
    raise RuntimeError("порт checked writer недоступен")
begin = importlib.util.module_from_spec(PORT)
PORT.loader.exec_module(begin)

CHANNEL = re.compile(r"c_[a-f0-9]{32}")
ATTEMPT = re.compile(r"a_[a-f0-9]{32}")
BOOT = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")
RUN_KEY = re.compile(r"[A-Z][A-Z0-9_]{0,127}")
VISIT = re.compile(r"(?:nv|b)_[a-f0-9]{32,64}")
READY_LIMIT = 4096
DEADLINE = 8


def strict_json(raw: bytes):
    def fields(pairs):
        value = dict(pairs)
        if len(value) != len(pairs):
            raise ValueError("дублирующее поле протокола канала")
        return value

    return json.loads(raw, object_pairs_hook=fields)


def sealed_path(file: Path, root: Path, *, executable: bool) -> str:
    if not file.is_absolute() or file.resolve(strict=True) != file or not file.is_relative_to(root):
        raise ValueError("исполняемый файл вне закреплённого профиля или runtime")
    fd = os.open(file, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid not in {0, os.geteuid()} or info.st_nlink != 1 \
                or info.st_mode & 0o022 or executable and not info.st_mode & 0o100:
            raise ValueError("недоверенный вид программы канала")
        digest = hashlib.file_digest(source, "sha256").hexdigest()
        if begin.guard.evidence(info) != begin.guard.evidence(file.lstat()):
            raise ValueError("программа изменилась при чтении")
    return digest


def decode_argv(value: object, roots: tuple[Path, ...]) -> dict:
    if not isinstance(value, list) or not 1 <= len(value) <= 64 or not all(
        isinstance(arg, str) and len(arg) <= 4096 and not any(char in arg for char in "\0\r\n") for arg in value
    ):
        raise ValueError("невалидный argv канала")
    file = Path(value[0])
    root = next((item for item in roots if file.is_relative_to(item)), None)
    if root is None:
        raise ValueError("команда канала вне доверенной поставки")
    return {"argv": value, "sha256": sealed_path(file, root, executable=True)}


def process_identity(helper: str, pid: int) -> dict | None:
    result = subprocess.run([helper, "identity", str(pid)], capture_output=True, timeout=3, check=False)
    if result.returncode == 3:
        return None
    if result.returncode:
        raise ValueError("Darwin не подтвердил процесс канала")
    row = json.loads(result.stdout)
    if row["pid"] != pid or row["uid"] != os.geteuid() or not re.fullmatch(r"[0-9]+", row["starttime"]):
        raise ValueError("процесс канала подменён")
    return {key: row[key] for key in ("pid", "uid", "ppid", "starttime", "pgid", "sid")}


def boot_id(helper: str) -> str:
    value = subprocess.check_output([helper, "boot-id"], timeout=3, text=True).strip().lower()
    if not BOOT.fullmatch(value):
        raise ValueError("неизвестная загрузка Darwin")
    return value


def empty_session(helper: str, broker: dict, boot: str) -> bool:
    if boot_id(helper) != boot:
        return True
    for _ in range(2):
        census = json.loads(subprocess.check_output([helper, "uid-census"], timeout=3))
        if not isinstance(census, list) or any(row["sid"] == broker["sid"] for row in census):
            return False
    return True


def fd_context(value: dict):
    stream = tempfile.TemporaryFile("w+b")
    stream.write(begin.encoded(value) + b"\n")
    stream.seek(0)
    return stream


def private_resource(path: Path, identity: list[int]) -> bool:
    try:
        observed = begin.owned_directory(path)
    except FileNotFoundError:
        return False
    if stat.S_IMODE(observed.st_mode) != 0o700 or [observed.st_dev, observed.st_ino] != identity:
        raise ValueError("заменён каталог интерфейса профиля")
    return True


def context(record: dict) -> dict:
    return {key: record[key] for key in ("format", "channel", "task", "attempt", "stage", "visit", "txid", "resource")}


def protocol_env(scope) -> dict:
    env = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "FACTORY_HOME")
           if key in os.environ}
    env["GRIGDESK_PROFILE_CONTEXT_FD"] = str(scope.fileno())
    return env


def checked_ready(descriptor: int, process: subprocess.Popen, handle: str, channel: str) -> None:
    raw = bytearray()
    until = time.monotonic() + DEADLINE
    while b"\n" not in raw:
        remaining = until - time.monotonic()
        if remaining <= 0 or process.poll() is not None or not select.select([descriptor], [], [], min(remaining, 0.1))[0]:
            if remaining > 0 and process.poll() is None:
                continue
            raise ValueError("брокер не подтвердил готовность канала")
        chunk = os.read(descriptor, READY_LIMIT + 1 - len(raw))
        raw.extend(chunk)
        if not chunk or len(raw) > READY_LIMIT:
            raise ValueError("готовность канала не получена")
    if not raw.endswith(b"\n") or raw.count(b"\n") != 1 \
            or strict_json(raw) != {"version": 1, "channelId": channel} \
            or process_identity(handle, process.pid) is None:
        raise ValueError("ready не соответствует exact каналу")


def spawn_broker(directory: Path, record: dict, helper: str, launcher: str) -> None:
    resource = Path(record["resource"]["path"])
    command = record["broker"]["argv"]
    permits = os.pipe()
    readiness = os.pipe()
    log = os.open(directory / "broker.log", os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with fd_context(context(record)) as scope, os.fdopen(log, "wb") as output:
        env = {**protocol_env(scope), "GRIGDESK_PROFILE_READY_FD": str(readiness[1])}
        process = None
        try:
            process = subprocess.Popen([launcher, "--permit-fd", str(permits[0]), "--", *command],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=output, cwd=resource, env=env,
                pass_fds=(permits[0], readiness[1], scope.fileno()))
            os.close(permits[0])
            os.close(readiness[1])
            until = time.monotonic() + 3
            broker = None
            while time.monotonic() < until and process.poll() is None:
                broker = process_identity(helper, process.pid)
                if broker and broker["pid"] == broker["sid"] == broker["pgid"] and broker["ppid"] == os.getpid():
                    break
                time.sleep(0.02)
            else:
                raise ValueError("held broker не создал собственную сессию")
            permit = {"format": 1, "channel": record["channel"], "phase": "may-have-run", "process": broker}
            begin.guard.publish_immutable(directory, "broker.json", begin.encoded(permit))
            if os.write(permits[1], b"\x01") != 1:
                raise ValueError("не выдан permit брокеру")
            checked_ready(readiness[0], process, helper, record["channel"])
            if not private_resource(resource, record["resource"]["identity"]) \
                    or process_identity(helper, process.pid) != broker:
                raise ValueError("готовый канал сменил поколение")
        finally:
            for fd in (*permits, *readiness):
                try:
                    os.close(fd)
                except OSError:
                    pass


def channel_root(control: Path, task: str, *, initialize: bool = False) -> Path:
    base = control / "profile-channels"
    if initialize and not os.path.lexists(base):
        base.mkdir(mode=0o700)
        begin.guard.sync_directory(base)
        begin.guard.sync_directory(control)
    begin.owned_directory(base)
    root = base / ("t" + task)
    if initialize and not os.path.lexists(root):
        root.mkdir(mode=0o700)
    begin.owned_directory(root)
    if initialize:
        begin.guard.sync_directory(root)
        begin.guard.sync_directory(base)
    return root


def unfinished_channel(root: Path, task: str, *, sync_closed: bool = True) -> dict | None:
    pending = []
    for directory in root.iterdir():
        if directory.name == "active.json" or directory.name.startswith(".checkpoint."):
            continue
        if not CHANNEL.fullmatch(directory.name):
            raise ValueError("лишняя запись профиля")
        begin.owned_directory(directory)
        intent = begin.read_proof(directory / "intent.json", limit=65536)
        closed = begin.read_proof(directory / "closed.json")
        confirmed = begin.read_proof(directory / "closed-confirmed.json")
        if intent is None:
            if closed is not None or confirmed is not None or os.path.lexists(directory / "broker.json"):
                raise ValueError("канал без исходного intent")
            continue
        digest = hashlib.sha256(begin.encoded(intent)).hexdigest()
        if intent.get("channel") != directory.name or intent.get("task") != task or not ATTEMPT.fullmatch(intent["attempt"]):
            raise ValueError("история канала другой попытки")
        common = {"format": 1, "channel": intent["channel"], "intentSHA256": digest}
        if confirmed is None:
            pending.append({**common, "task": task, "attempt": intent["attempt"]})
        else:
            if closed is None or closed.get("phase") != "closed" or closed.get("channel") != intent["channel"] \
                    or closed.get("intentSHA256") != digest or confirmed != {
                        **common, "closedSHA256": hashlib.sha256(begin.encoded(closed)).hexdigest(),
                    }:
                raise ValueError("повреждено подтверждение закрытия канала")
            if sync_closed:
                begin.guard.publish_immutable(directory, "closed-confirmed.json", begin.encoded(confirmed))
    if len(pending) > 1:
        raise ValueError("несколько незакрытых каналов профиля")
    return pending[0] if pending else None


def open_channel(control: Path, task: str, attempt: str, stage: str, visit: str, txid: str,
                 owner: str, profile: Path, helper: str, launcher: str) -> None:
    if not RUN_KEY.fullmatch(stage) or not VISIT.fullmatch(visit) \
            or txid and (not begin.TXID.fullmatch(txid) or "a_" + begin.TXID.fullmatch(txid)[1] != attempt) \
            or not owner.isdecimal():
        raise ValueError("канал требует exact контекст попытки")
    raw = sys.stdin.buffer.read(32769)
    descriptor = strict_json(raw)
    if len(raw) > 32768 or set(descriptor) != {"version", "brokerArgv", "closeArgv"} or descriptor["version"] != 1:
        raise ValueError("неизвестная версия ABI канала")
    root = channel_root(control, task, initialize=True)
    if os.path.lexists(root / "active.json") or unfinished_channel(root, task) is not None:
        raise ValueError("предыдущий канал ещё не подтверждён")
    roots = (profile.parent, Path(__file__).resolve(strict=True).parents[1])
    broker = decode_argv(descriptor["brokerArgv"], roots)
    close = decode_argv(descriptor["closeArgv"], roots)
    profile_hash = sealed_path(profile, profile.parent, executable=False)
    opener = process_identity(helper, int(owner))
    if opener is None:
        raise ValueError("потерян процесс владельца канала")
    channel = "c_" + uuid.uuid4().hex
    directory = root / channel
    directory.mkdir(mode=0o700)
    resource = Path(tempfile.mkdtemp(prefix="gd-profile-", dir="/private/tmp"))
    actual = begin.owned_directory(resource)
    begin.guard.sync_directory(resource)
    begin.guard.sync_directory(resource.parent)
    record = {"format": 1, "task": task, "attempt": attempt, "stage": stage, "visit": visit, "txid": txid or None,
              "channel": channel, "boot": boot_id(helper), "owner": opener, "profile": profile_hash,
              "broker": broker, "close": close,
              "resource": {"path": str(resource), "identity": [actual.st_dev, actual.st_ino]}}
    begin.guard.publish_immutable(directory, "intent.json", begin.encoded(record))
    begin.guard.publish_immutable(root, "active.json", begin.encoded(
        {"format": 1, "task": task, "attempt": attempt, "channel": channel,
         "intentSHA256": hashlib.sha256(begin.encoded(record)).hexdigest()}))
    spawn_broker(directory, record, helper, launcher)
    print(resource)


def close_channel(control: Path, task: str, attempt: str, profile: Path, helper: str, rc: int) -> int:
    try:
        root = channel_root(control, task)
    except FileNotFoundError:
        return 0
    active_file = root / "active.json"
    active = begin.read_proof(active_file)
    if active is None:
        active = unfinished_channel(root, task)
        if active is None:
            begin.guard.sync_directory(root)
            return 0
        directory = root / active["channel"]
        if active.get("attempt") != attempt or os.path.lexists(directory / "broker.json"):
            raise ValueError("невозможно восстановить указатель канала")
        begin.guard.publish_immutable(root, "active.json", begin.encoded(active))
    if active.get("task") != task or active.get("attempt") != attempt or not CHANNEL.fullmatch(active["channel"]):
        raise ValueError("active channel относится к другой попытке")
    directory = root / active["channel"]
    begin.owned_directory(directory)
    record = begin.read_proof(directory / "intent.json", limit=65536)
    if record is None or [record.get(key) for key in ("task", "attempt", "channel")] != [task, attempt, active["channel"]] \
            or hashlib.sha256(begin.encoded(record)).hexdigest() != active["intentSHA256"] \
            or record["profile"] != sealed_path(profile, profile.parent, executable=False):
        raise ValueError("сохранённые входы канала изменились")
    roots = (profile.parent, Path(__file__).resolve(strict=True).parents[1])
    if any(decode_argv(record[name]["argv"], roots) != record[name] for name in ("close", "broker")):
        raise ValueError("поставка программы канала изменилась")
    broker_record = begin.read_proof(directory / "broker.json")
    if broker_record is not None and (broker_record.get("channel") != record["channel"]
                                      or broker_record.get("phase") != "may-have-run"):
        raise ValueError("не совпадает permit канала")
    broker = broker_record["process"] if broker_record is not None else None
    observed = process_identity(helper, broker["pid"]) if broker and boot_id(helper) == record["boot"] else None
    if observed and any(observed[key] != broker[key] for key in ("pid", "uid", "sid", "pgid", "starttime")):
        raise ValueError("регистрация указывает на иное поколение broker")
    resource = Path(record["resource"]["path"])
    identity = record["resource"]["identity"]
    if resource.parent != Path("/private/tmp") or not resource.name.startswith("gd-profile-"):
        raise ValueError("канал вне разрешённого runtime")
    previous = begin.read_proof(directory / "closed.json")
    if previous is None:
        close_rc = 0
        if private_resource(resource, identity):
            extra = {"rc": rc, "broker": observed, "permit": broker_record["phase"] if broker_record else "not-released"}
            with fd_context({**context(record), **extra}) as scope:
                result = subprocess.run(record["close"]["argv"], cwd=resource, env=protocol_env(scope),
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, pass_fds=(scope.fileno(),),
                    timeout=DEADLINE, check=False)
            close_rc = result.returncode
        if broker is not None and not empty_session(helper, broker, record["boot"]):
            raise ValueError("дочерняя сессия канала ещё существует")
        if private_resource(resource, identity):
            resource.rmdir()
        begin.guard.sync_directory(resource.parent)
        previous = {"format": 1, "channel": record["channel"], "intentSHA256": active["intentSHA256"],
                    "phase": "closed", "closeRC": close_rc}
    if set(previous) != {"format", "channel", "intentSHA256", "phase", "closeRC"} \
            or previous["channel"] != record["channel"] or previous["intentSHA256"] != active["intentSHA256"] \
            or previous["phase"] != "closed" or not isinstance(previous["closeRC"], int) \
            or private_resource(resource, identity) or (broker and not empty_session(helper, broker, record["boot"])):
        raise ValueError("closure proof канала не подтверждён")
    begin.guard.publish_immutable(directory, "closed.json", begin.encoded(previous))
    confirmed = {"format": 1, "channel": record["channel"], "intentSHA256": active["intentSHA256"],
                 "closedSHA256": hashlib.sha256(begin.encoded(previous)).hexdigest()}
    begin.guard.publish_immutable(directory, "closed-confirmed.json", begin.encoded(confirmed))
    if begin.read_proof(active_file) != active:
        raise ValueError("изменился active указатель канала")
    active_file.unlink()
    begin.guard.sync_directory(root)
    return 75 if previous["closeRC"] else 0


def main() -> int:
    action, control_text, task, attempt, profile_text, helper, *args = sys.argv[1:]
    if not begin.TASK.fullmatch(task) or not ATTEMPT.fullmatch(attempt):
        raise ValueError("невалидная попытка канала")
    control, profile = Path(control_text), Path(profile_text)
    begin.owned_directory(control)
    if action == "check" and not args:
        try:
            root = channel_root(control, task)
        except FileNotFoundError:
            return 0
        active = begin.read_proof(root / "active.json")
        pending = unfinished_channel(root, task, sync_closed=False)
        if active is not None or pending is not None:
            return 75
        return 0
    if action == "open" and len(args) == 5:
        open_channel(control, task, attempt, *args[:4], profile, helper, args[4])
        return 0
    if action == "close" and len(args) == 1 and args[0].isdecimal():
        return close_channel(control, task, attempt, profile, helper, int(args[0]))
    raise ValueError("неизвестный переход канала")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.SubprocessError):
        print("FACTORY_ERROR=release_task_cleanup_required", file=sys.stderr)
        sys.exit(78)
