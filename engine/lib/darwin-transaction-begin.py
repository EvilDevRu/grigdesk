#!/usr/bin/env python3
"""Публикация входов TX с восстанавливаемой границей до допуска provider."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import stat
import sys
from pathlib import Path


PORT = importlib.util.spec_from_file_location(
    "workspace_guard_darwin", Path(__file__).with_name("workspace-guard-darwin.py"),
)
if PORT is None or PORT.loader is None:
    raise RuntimeError("Git guard недоступен")
guard = importlib.util.module_from_spec(PORT)
PORT.loader.exec_module(guard)

INPUTS = {"baseline.tsv", "roots.list", "scope.list", "files.tsv", "indexes.tsv",
          "indexes.darwin.json", "marker.b64", "isolation", "cursor.env"}
BACKUP = re.compile(r"[a-f0-9]{64}\.data")
SPLIT = re.compile(r"sharedindex\.(?:[a-f0-9]{40}|[a-f0-9]{64})")
DIGEST = re.compile(r"[a-f0-9]{64}")
TXID = re.compile(r"v2-([a-f0-9]{32})-s(?:0|[1-9][0-9]{0,17})")
TASK = re.compile(r"[1-9][0-9]{0,18}")


def encoded(value: dict) -> bytes:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("utf-8")


def owned_directory(directory: Path) -> os.stat_result:
    """Запрещает подмену компонента и каталог, доступный другому writer."""
    info = directory.lstat()
    if directory.resolve(strict=True) != directory or not stat.S_ISDIR(info.st_mode) \
            or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise ValueError("неподтверждённый каталог TX")
    return info


def stable_file(file: Path, *, sync: bool = False, keep: bool = False,
                limit: int | None = 16384) -> tuple[int, str, bytes]:
    """Проверяет один inode до и после чтения и синхронизирует его при публикации."""
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid() or before.st_nlink != 1 \
                or before.st_mode & 0o022 or keep and limit is not None and before.st_size > limit:
            raise ValueError("вход TX не является проверенным файлом")
        digest = hashlib.sha256()
        data = bytearray()
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
            if keep:
                data.extend(chunk)
                if limit is not None and len(data) > limit:
                    raise ValueError("состояние TX превышает предел")
        if sync:
            os.fsync(fd)
        named = file.lstat()
        if guard.evidence(before) != guard.evidence(named) or guard.evidence(named) != guard.evidence(os.fstat(fd)):
            raise ValueError("вход TX изменился во время чтения")
        return stat.S_IMODE(before.st_mode), digest.hexdigest(), bytes(data)


def backup_items(transaction: Path) -> tuple[list[Path], list[Path]]:
    """Рекурсивно допускает только имена, создаваемые авторами scope/index backup."""
    backups = transaction / "backups"
    indexes = transaction / "indexes"
    directories = [backups, indexes]
    files = []
    for directory in directories:
        owned_directory(directory)
    for file in sorted(backups.iterdir()):
        if BACKUP.fullmatch(file.name) is None:
            raise ValueError("лишний объект scope backup")
        files.append(file)
    for directory in sorted(indexes.iterdir()):
        if DIGEST.fullmatch(directory.name) is None:
            raise ValueError("лишний объект index backup")
        owned_directory(directory)
        directories.append(directory)
        for file in sorted(directory.iterdir()):
            if file.name != "index" and SPLIT.fullmatch(file.name) is None:
                raise ValueError("лишний файл index backup")
            files.append(file)
    return files, directories


def payload_proof(transaction: Path, *, initial: bool, sync: bool) -> tuple[str, str]:
    """Хеширует неизменяемые входы отдельно от изменяемого state.env."""
    owned_directory(transaction)
    backups, directories = backup_items(transaction)
    files = [transaction / name for name in sorted(INPUTS)] + backups
    fingerprint = hashlib.sha256()
    baseline = ""
    for file in files:
        mode, digest, _ = stable_file(file, sync=sync)
        relative = str(file.relative_to(transaction))
        if relative == "baseline.tsv":
            baseline = digest
        fingerprint.update(encoded({"name": relative, "mode": mode, "sha": digest}))
    _, state_hash, raw = stable_file(transaction / "state.env", sync=sync, keep=True)
    if initial:
        fields = raw.decode("utf-8").splitlines()
        if "STATE=active" not in fields or "CHECKPOINT=0" not in fields \
                or "INITIAL_EXPECTED_SHA256=" + baseline not in fields:
            raise ValueError("не совпадает начальное поколение TX")
    if sync:
        for directory in reversed(directories):
            guard.sync_directory(directory)
        guard.sync_directory(transaction)
    return fingerprint.hexdigest(), state_hash


def read_proof(file: Path, *, limit: int | None = 16384) -> dict | None:
    """Отсутствие отдельной публикации не заменяет отказ чтения или проверки."""
    try:
        mode, _, data = stable_file(file, keep=True, limit=limit)
    except FileNotFoundError:
        return None
    value = json.loads(data)
    if mode != 0o600 or not isinstance(value, dict) or value.get("format") != 1:
        raise ValueError("недоверенная begin-запись")
    return value


def proof_for_intent(task: str, txid: str, intent: dict) -> dict:
    return {
        "format": 1, "task": task, "txid": txid,
        "intentSHA256": hashlib.sha256(encoded(intent)).hexdigest(),
    }


def retirement_records(task: str, txid: str, intent: dict) -> tuple[dict, dict]:
    """Подтверждение связывает SHA intent и точной записи not_started."""
    unstarted = proof_for_intent(task, txid, intent)
    unstarted["state"] = "not_started"
    confirmed = proof_for_intent(task, txid, intent)
    confirmed["notStartedSHA256"] = hashlib.sha256(encoded(unstarted)).hexdigest()
    return unstarted, confirmed


def disposition(root: Path, task: str, txid: str, *, sync_retired: bool = False) -> str:
    """Read-only селектор отличает incomplete begin от доказанно снятого ID."""
    intent = read_proof(root / (txid + ".begin-intent.json"))
    commit = read_proof(root / (txid + ".begin-committed.json"))
    stopped = read_proof(root / (txid + ".not-started.json"))
    retired = read_proof(root / (txid + ".retirement-confirmed.json"))
    if intent is None:
        if any(value is not None for value in (commit, stopped, retired)):
            raise ValueError("запись TX без исходного intent")
        return "absent"
    if intent.get("task") != task or intent.get("txid") != txid:
        raise ValueError("begin-intent другой задачи")
    if commit is not None:
        if stopped is not None or retired is not None or commit != proof_for_intent(task, txid, intent):
            raise ValueError("конфликт цепочки begin/retirement")
        return "committed"
    if retired is not None:
        expected_stop, expected_retirement = retirement_records(task, txid, intent)
        if stopped != expected_stop or retired != expected_retirement:
            raise ValueError("несогласованное снятие begin-intent")
        target = root / txid
        if target.exists() or target.is_symlink():
            raise ValueError("переиспользован TX ID с retirement")
        pointer = root / "active.env"
        if pointer.exists() or pointer.is_symlink():
            _, _, raw = stable_file(pointer, keep=True)
            if raw == f"SCHEMA=1\nTRANSACTION_ID={txid}\n".encode():
                raise ValueError("переиспользован active pointer снятой TX")
        if sync_retired:
            guard.publish_immutable(root, txid + ".begin-intent.json", encoded(intent))
            guard.publish_immutable(root, txid + ".not-started.json", encoded(expected_stop))
            guard.publish_immutable(root, txid + ".retirement-confirmed.json", encoded(expected_retirement))
        return "retired"
    return "pending"


def pending_begin(root: Path, task: str, attempt: str, *, sync_retired: bool = False) -> dict | None:
    """Принимает только единственный незавершённый begin текущей попытки."""
    if re.fullmatch(r"a_[a-f0-9]{32}", attempt) is None:
        raise ValueError("неверная попытка begin")
    found = []
    for file in root.glob("*.begin-intent.json"):
        txid = file.name.removesuffix(".begin-intent.json")
        if TXID.fullmatch(txid) is None:
            raise ValueError("неизвестное имя begin-intent")
        phase = disposition(root, task, txid, sync_retired=sync_retired and TXID.fullmatch(txid)[1] == attempt[2:])
        if phase != "pending":
            continue
        entry = read_proof(file)
        if entry is None or entry.get("attempt") != attempt:
            raise ValueError("незавершённый begin другой попытки")
        temporary = entry.get("temporary", "")
        if not isinstance(temporary, str) or re.fullmatch(r"\.tx\.[a-zA-Z0-9]{6}", temporary) is None:
            raise ValueError("неопознанный temp TX")
        found.append(entry)
    if len(found) > 1:
        raise ValueError("несколько незавершённых begin")
    return found[0] if found else None


def retire_begin(root: Path, task: str, txid: str, current_snapshot: Path) -> None:
    """Снимает только свой подготовленный intent без создания TX или permit."""
    intent_name = txid + ".begin-intent.json"
    intent = read_proof(root / intent_name)
    if intent is None or disposition(root, task, txid) not in {"pending", "retired"} \
            or intent.get("dispatch") != "not-released":
        raise ValueError("невозможно снять begin")
    for path in (root / txid, root / "active.env"):
        if path.exists() or path.is_symlink():
            raise ValueError("TX уже опубликована")
    if any(root.glob(txid + ".dispatch*")):
        raise ValueError("сохранился dispatch этой TX")
    temporary_name = intent.get("temporary", "")
    if not isinstance(temporary_name, str) or re.fullmatch(r"\.tx\.[a-zA-Z0-9]{6}", temporary_name) is None:
        raise ValueError("неизвестная подготовленная папка TX")
    temporary = root / temporary_name
    verify_intent(intent, task, txid, temporary, initial=True, sync=False)
    _, baseline, _ = stable_file(temporary / "baseline.tsv")
    _, observed, _ = stable_file(current_snapshot)
    if observed != baseline:
        raise ValueError("baseline изменился до снятия begin")
    verify_initial_indexes(temporary)
    guard.publish_immutable(root, intent_name, encoded(intent))
    unstarted, confirmed = retirement_records(task, txid, intent)
    guard.publish_immutable(root, txid + ".not-started.json", encoded(unstarted))
    guard.publish_immutable(root, txid + ".retirement-confirmed.json", encoded(confirmed))


def verify_initial_indexes(transaction: Path) -> None:
    """Сверяет bytes, inode и metadata до первого допуска writer."""
    _, _, raw = stable_file(transaction / "indexes.darwin.json", keep=True, limit=None)
    manifest = json.loads(raw)
    for repository in manifest["repositories"]:
        for source, expected in repository["files"].items():
            if guard.capture_index(source) != expected:
                raise ValueError("реальный Git index отличается от начального поколения")


def resume_to_cursor(root: Path, task: str, txid: str, node: str, sequence: str) -> int:
    """Восстанавливает begin только для того же курсора до первого выпуска writer."""
    intent = read_proof(root / f"{txid}.begin-intent.json")
    if intent is None:
        return 3
    transaction = root / txid
    if not os.path.lexists(transaction):
        temporary = intent.get("temporary", "")
        if not re.fullmatch(r"\.tx\.[a-zA-Z0-9]{6}", temporary):
            raise ValueError("неизвестная подготовленная TX")
        transaction = root / temporary
    owned_directory(transaction)
    _, _, cursor = stable_file(transaction / "cursor.env", keep=True)
    if cursor != f"NODE={node}\nSEQUENCE={sequence}\n".encode():
        return 3
    if any(transaction.glob("dispatch-*.json")):
        return 3
    _, _, state = stable_file(transaction / "state.env", keep=True)
    if b"\nSTATE=active\nCHECKPOINT=0\n" not in state:
        return 3
    verify_intent(intent, task, txid, transaction, initial=True, sync=True)
    return 0 if begin(root, task, txid, None) else 78


def verify_commit(root: Path, task: str, txid: str, *, require_active_state: bool = False) -> None:
    """Committed проверяется отдельно от pending initial state и не заводит active заново."""
    tx = root / txid
    intent_name = txid + ".begin-intent.json"
    commit_name = txid + ".begin-committed.json"
    intent = read_proof(root / intent_name)
    committed = read_proof(root / commit_name)
    if intent is None or committed != proof_for_intent(task, txid, intent):
        raise ValueError("begin-committed отсутствует или относится к иной записи")
    verify_intent(intent, task, txid, tx, initial=False, sync=True)
    _, _state_sha, raw = stable_file(tx / "state.env", keep=True)
    fields = dict(line.split("=", 1) for line in raw.decode("utf-8").splitlines())
    current = fields.get("STATE")
    checkpoint = fields.get("CHECKPOINT", "")
    if current not in {"active", "cleaning", "completed", "stalled"} or fields.get("SCHEMA") != "1" \
            or require_active_state and current != "active" \
            or re.fullmatch(r"(?:0|[1-9][0-9]{0,17})", checkpoint) is None:
        raise ValueError("невозможно подтвердить текущее состояние TX")
    if checkpoint == "0":
        _, baseline, _ = stable_file(tx / "baseline.tsv")
        if fields.get("INITIAL_EXPECTED_SHA256") != baseline:
            raise ValueError("нарушено начальное поколение TX")
    else:
        expected = read_proof(tx / f"indexes-expected-{checkpoint}.json", limit=None)
        _, digest, _ = stable_file(tx / f"checkpoint-{checkpoint}.tsv", sync=True)
        if expected is None or expected.get("checkpoint") != checkpoint or expected.get("workspaceSHA256") != digest \
                or fields.get("CHECKPOINT_SHA256") != digest:
            raise ValueError("не совпадает актуальный checkpoint TX")
    if current != "completed" or (root / "active.env").exists() or (root / "active.env").is_symlink():
        _, _, pointer = stable_file(root / "active.env", keep=True, sync=True)
        if pointer != f"SCHEMA=1\nTRANSACTION_ID={txid}\n".encode():
            raise ValueError("утрачен exact active pointer")
    guard.publish_immutable(root, intent_name, encoded(intent))
    guard.publish_immutable(root, commit_name, encoded(committed))


def manual_stop(transaction: Path, task: str, action: str, snapshot: Path | None = None) -> int:
    """Причинное подтверждение оформляет явное ручное восстановление той же TX."""
    intent_name = "manual-stop-required.json"
    proof_name = "manual-stop-proof.json"
    confirmation_name = "manual-stop-confirmed.json"
    old = read_proof(transaction / intent_name)
    state = stable_file(transaction / "state.env", keep=True)[2].decode()
    fields = dict(line.split("=", 1) for line in state.splitlines())
    _, baseline, _ = stable_file(transaction / "baseline.tsv")
    common = {"format": 1, "task": task, "txid": transaction.name,
              "attempt": "a_" + TXID.fullmatch(transaction.name)[1], "baselineSHA256": baseline,
              "checkpoint": fields.get("CHECKPOINT", "")}
    if old is not None and any(old.get(key) != value for key, value in common.items()):
        raise ValueError("обязательный Stop относится к другому поколению")
    if action == "require":
        if fields.get("STATE") != "stalled" or snapshot is None or snapshot.parent != transaction:
            raise ValueError("нет режима ручной проверки TX")
        _, seen, contents = stable_file(snapshot, keep=True, sync=True, limit=None)
        if seen != baseline:
            raise ValueError("рабочее дерево не соответствует baseline")
        expected = {**common, "reason": fields.get("REASON", "")}
        if old is not None and old != expected:
            raise ValueError("изменилась причина ручной остановки")
        guard.publish_immutable(transaction, intent_name, encoded(expected))
        guard.publish_immutable(transaction, "manual-stop-final.tsv", contents)
        return 0
    if old is None:
        return 3
    proof = {**common, "requiredSHA256": hashlib.sha256(encoded(old)).hexdigest()}
    confirmed = {**common, "proofSHA256": hashlib.sha256(encoded(proof)).hexdigest()}
    if action == "confirm":
        if fields.get("STATE") != "completed" or stable_file(transaction / "manual-stop-final.tsv", sync=True)[1] != baseline:
            raise ValueError("manual completion не выбран в state")
        guard.publish_immutable(transaction, intent_name, encoded(old))
        guard.publish_immutable(transaction, proof_name, encoded(proof))
        guard.publish_immutable(transaction, confirmation_name, encoded(confirmed))
        return 0
    checked = read_proof(transaction / confirmation_name)
    if checked is None:
        return 0
    if checked != confirmed or read_proof(transaction / proof_name) != proof or fields.get("STATE") != "completed":
        raise ValueError("цепочка ручного Stop повреждена")
    return 3


def requires_explicit_stop(root: Path, task: str, attempt: str) -> bool:
    """Проверка не пишет и отличает здоровую открытую TX от обязательного Stop."""
    token = attempt.removeprefix("a_")
    if not re.fullmatch(r"[a-f0-9]{32}", token):
        raise ValueError("невалидная попытка guard")
    for entry in root.glob(f"v2-{token}-s*"):
        if not TXID.fullmatch(entry.name):
            continue
        owned_directory(entry)
        _, _, state = stable_file(entry / "state.env", keep=True)
        if b"\nSTATE=stalled\n" in state or manual_stop(entry, task, "check") == 0:
            return True
    return False


def cleanup_identity(control: Path, task: str, attempt: str) -> str | None:
    """Сравнение с exact UI record под engine lock до первой записи."""
    if not re.fullmatch(r"a_[a-f0-9]{32}", attempt):
        raise ValueError("невалидная попытка cleanup")
    root = control / "transactions" / ("t" + task)
    receipt = control / "transaction-finalization" / ("t" + task + ".json")

    def optional(file: Path) -> bytes | None:
        try:
            owned_directory(file.parent)
            return stable_file(file, keep=True)[2]
        except FileNotFoundError:
            return None

    receipt_bytes = optional(receipt)
    selected = json.loads(receipt_bytes) if receipt_bytes is not None else {}
    pointer = optional(root / "active.env")
    if pointer is None:
        txid = selected.get("txid", "")
    else:
        match = re.fullmatch(rb"SCHEMA=1\nTRANSACTION_ID=([^\n]+)\n", pointer)
        if not match:
            raise ValueError("невалидный указатель TX")
        txid = match[1].decode("ascii")
    payload = None
    if TXID.fullmatch(txid) and "a_" + TXID.fullmatch(txid)[1] == attempt:
        directory = root / txid
        owned_directory(directory)
        state = stable_file(directory / "state.env", keep=True)[2]
        manual = manual_stop(directory, task, "check") == 0
        if manual or b"\nSTATE=stalled\n" in state:
            raw = stable_file(directory / "manual-stop-required.json", keep=True)[2] if manual else state
            payload = txid.encode() + b"\n" + raw
        elif selected.get("attempt") == attempt and selected.get("txid") == txid \
                and selected.get("phase") in {"pending", "restored"}:
            payload = receipt_bytes
        elif pointer is not None:
            payload = txid.encode() + b"\n" + state
    if payload is None:
        channel = optional(control / "profile-channels" / ("t" + task) / "active.json")
        if channel is not None and json.loads(channel).get("attempt") == attempt:
            payload = channel
    if payload is None:
        return None
    return hashlib.sha256(f"{task}\n{attempt}\n".encode() + payload).hexdigest()


def verify_intent(intent: dict, task: str, txid: str, tx: Path, *, initial: bool, sync: bool) -> None:
    """Тот же inode temp переезжает под точное имя TX; подмена не восстанавливается."""
    info = owned_directory(tx)
    immutable, state = payload_proof(tx, initial=initial, sync=sync)
    if intent.get("task") != task or intent.get("txid") != txid \
            or intent.get("attempt") != "a_" + TXID.fullmatch(txid)[1] \
            or intent.get("identity") != [info.st_dev, info.st_ino] \
            or intent.get("immutable") != immutable or initial and intent.get("initialState") != state:
        raise ValueError("begin-intent не совпадает с ровно той же TX")


def begin(root: Path, task: str, txid: str, candidate: Path | None) -> bool:
    """Повторно закрепляет одну и ту же публикацию, включая видимый частичный rename."""
    tx = root / txid
    intent_name = txid + ".begin-intent.json"
    commit_name = txid + ".begin-committed.json"
    intent = read_proof(root / intent_name)
    committed = read_proof(root / commit_name)
    if committed is not None:
        verify_commit(root, task, txid, require_active_state=True)
        return True
    if disposition(root, task, txid) == "retired":
        raise ValueError("снятый TX ID нельзя переиспользовать")
    if read_proof(root / (txid + ".not-started.json")) is not None:
        raise ValueError("снятие TX должно завершиться до следующего begin")
    if intent is None:
        if candidate is None:
            return False
        info = owned_directory(candidate)
        immutable, state = payload_proof(candidate, initial=True, sync=True)
        intent = {
            "format": 1, "task": task, "attempt": "a_" + TXID.fullmatch(txid)[1], "txid": txid,
            "temporary": candidate.name, "identity": [info.st_dev, info.st_ino],
            "immutable": immutable, "initialState": state, "dispatch": "not-released",
        }
    temporary_name = intent.get("temporary", "")
    if not isinstance(temporary_name, str) or re.fullmatch(r"\.tx\.[a-zA-Z0-9]{6}", temporary_name) is None:
        raise ValueError("неизвестная подготовленная папка TX")
    temporary = root / temporary_name
    visible = tx if tx.exists() or tx.is_symlink() else temporary
    verify_intent(intent, task, txid, visible, initial=True, sync=True)
    guard.publish_immutable(root, intent_name, encoded(intent))
    if visible == temporary:
        parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            guard.rename_exclusive(parent, temporary.name, txid)
            os.fsync(parent)
        finally:
            os.close(parent)
    verify_intent(intent, task, txid, tx, initial=True, sync=True)
    guard.sync_directory(root)
    pointer = f"SCHEMA=1\nTRANSACTION_ID={txid}\n".encode()
    guard.publish_immutable(root, "active.env", pointer)
    proof = proof_for_intent(task, txid, intent)
    guard.publish_immutable(root, commit_name, encoded(proof))
    return True


def main() -> int:
    """Принимает только exact task/attempt TX под уже захваченным TX lock."""
    action, root_raw, task, txid, *args = sys.argv[1:]
    root = Path(root_raw)
    if action == "cleanup-identity" and not args and TASK.fullmatch(task):
        owned_directory(root)
        identity = cleanup_identity(root, task, txid)
        if identity is None:
            return 3
        print(identity)
        return 0
    if TASK.fullmatch(task) is None or root.name != "t" + task:
        raise ValueError("неверная identity begin")
    owned_directory(root)
    if action == "pending" and args in ([], ["sync-retired"]):
        found = pending_begin(root, task, txid, sync_retired=bool(args))
        if found is None:
            return 3
        print(found["txid"], found["temporary"])
        return 0
    if action == "requires-stop" and not args:
        return 75 if requires_explicit_stop(root, task, txid) else 0
    if TXID.fullmatch(txid) is None:
        raise ValueError("неверный TX ID")
    if action == "disposition" and args in ([], ["sync-retired"]):
        print(disposition(root, task, txid, sync_retired=bool(args)))
        return 0
    if action == "retire" and len(args) == 1:
        retire_begin(root, task, txid, Path(args[0]))
        return 0
    if action == "publish" and len(args) == 1:
        candidate = Path(args[0])
        if candidate.parent != root:
            raise ValueError("temp TX вне доверенного task root")
        return 0 if begin(root, task, txid, candidate) else 78
    if action == "recover" and not args:
        return 0 if begin(root, task, txid, None) else 3
    if action == "recover-published" and not args:
        if not os.path.lexists(root / txid):
            return 3
        return 0 if begin(root, task, txid, None) else 78
    if action == "resume-to-cursor" and len(args) == 2:
        return resume_to_cursor(root, task, txid, args[0], args[1])
    if action == "verify-initial-indexes" and not args:
        verify_commit(root, task, txid, require_active_state=True)
        verify_initial_indexes(root / txid)
        return 0
    if action == "manual-require" and len(args) == 1:
        return manual_stop(root / txid, task, "require", Path(args[0]))
    if action in {"manual-check", "manual-confirm"} and not args:
        return manual_stop(root / txid, task, action.removeprefix("manual-"))
    if action == "verify" and not args:
        verify_commit(root, task, txid)
        return 0
    raise ValueError("неизвестный переход begin")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, TypeError, KeyError):
        print("instrumentation: не удалось подтвердить durable begin", file=sys.stderr)
        sys.exit(78)
