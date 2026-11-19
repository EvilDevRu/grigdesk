#!/usr/bin/env python3
"""Связывает допуск writer и его checkpoint по одному неизменяемому ключу."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path


PORT = importlib.util.spec_from_file_location(
    "darwin_transaction_begin", Path(__file__).with_name("darwin-transaction-begin.py"),
)
if PORT is None or PORT.loader is None:
    raise RuntimeError("порт TX begin недоступен")
begin = importlib.util.module_from_spec(PORT)
PORT.loader.exec_module(begin)

ORDINAL = re.compile(r"(?:0|[1-9][0-9]{0,17})")
POSITIVE = re.compile(r"[1-9][0-9]{0,17}")
KEY = re.compile(r"[a-zA-Z][a-zA-Z0-9_-]{0,127}")
RUN = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}")
UUID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")


def read_state(tx: Path) -> int:
    _, _, raw = begin.stable_file(tx / "state.env", keep=True)
    lines = raw.decode().splitlines()
    fields = dict(line.split("=", 1) for line in lines)
    if len(fields) != len(lines) or fields.get("STATE") != "active" \
            or not ORDINAL.fullmatch(fields.get("CHECKPOINT", "")):
        raise ValueError("dispatch требует active TX и точное поколение")
    return int(fields["CHECKPOINT"])


def verify_generation(value: dict, task: str, txid: str, number: int) -> None:
    expected = {"format", "task", "attempt", "txid", "checkpoint", "phase", "stage", "run", "epoch",
                "cursor", "boot", "pid", "sid", "pgid", "starttime"}
    if set(value) != expected or value["task"] != task or value["txid"] != txid \
            or value["attempt"] != "a_" + begin.TXID.fullmatch(txid)[1] \
            or value["phase"] != "may-have-run" or value["checkpoint"] != number \
            or not KEY.fullmatch(value["stage"]) or not RUN.fullmatch(value["run"]) \
            or not ORDINAL.fullmatch(value["cursor"]) or not UUID.fullmatch(value["boot"]) \
            or not all(POSITIVE.fullmatch(value[name]) for name in ("pid", "sid", "pgid", "epoch", "starttime")):
        raise ValueError("не совпадает dispatch поколения TX")


def dispatches(tx: Path, task: str, txid: str, checkpoint: int) -> list[dict]:
    records = {}
    for file in tx.glob("dispatch-*.json"):
        generation = file.name.removeprefix("dispatch-").removesuffix(".json")
        if not POSITIVE.fullmatch(generation):
            raise ValueError("неизвестное имя dispatch записи")
        number = int(generation)
        record = begin.read_proof(file)
        if record is None:
            raise ValueError("dispatch запись изменилась при чтении")
        verify_generation(record, task, txid, number)
        records[number] = record
    numbers = sorted(records)
    if any(index != number for index, number in enumerate(numbers, 1)) \
            or not checkpoint <= len(numbers) <= checkpoint + 1:
        raise ValueError("неоднозначное поколение dispatch")
    return [records[number] for number in numbers]


def operation_key(record: dict) -> str:
    key = ["provider-checkpoint", *(record[name] for name in ("task", "attempt", "txid", "stage", "run", "epoch"))]
    encoded_key = json.dumps(key, ensure_ascii=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded_key).hexdigest()


def operation_proof(record: dict, workspace: str, indexes: str) -> dict:
    return {"format": 1, "operation": operation_key(record), "checkpoint": record["checkpoint"],
            "dispatchSHA256": hashlib.sha256(begin.encoded(record)).hexdigest(),
            "workspaceSHA256": workspace, "indexesSHA256": indexes}


def checkpoint_proof(tx: Path, record: dict) -> dict:
    number = record["checkpoint"]
    _, workspace, _ = begin.stable_file(tx / f"checkpoint-{number}.tsv", sync=True)
    _, indexes, _ = begin.stable_file(tx / f"indexes-expected-{number}.json", sync=True)
    return operation_proof(record, workspace, indexes)


def read_stage(tx: Path, record: dict) -> tuple[dict, bytes, bytes] | None:
    """Видимое staging содержит полные bytes и проверяемое описание предыдущего N."""
    file = tx / f"checkpoint-{operation_key(record)}.staged"
    try:
        mode, _, raw = begin.stable_file(file, keep=True, sync=True, limit=None)
    except FileNotFoundError:
        return None
    header, delimiter, workspace = raw.partition(b"\n")
    value = json.loads(header)
    indexes = begin.encoded(value["indexes"])
    proof = operation_proof(record, hashlib.sha256(workspace).hexdigest(), hashlib.sha256(indexes).hexdigest())
    if not delimiter or mode != 0o600 or set(value) != {"previous", "operation", "indexes"} \
            or value["previous"] != record["checkpoint"] - 1 or value["operation"] != proof \
            or value["indexes"]["workspaceSHA256"] != proof["workspaceSHA256"] or header != begin.encoded(value):
        raise ValueError("сохранённая подготовка checkpoint не соответствует dispatch")
    begin.guard.sync_directory(tx)
    return proof, workspace, indexes


def stage_checkpoint(tx: Path, record: dict, scratch: Path, *, resume_only: bool = False) -> dict:
    number = record["checkpoint"]
    snapshot = tx / f"checkpoint-{number}.tsv"
    index_file = tx / f"indexes-expected-{number}.json"
    prepared_file = tx / f"checkpoint-{number}.prepared.json"
    if scratch.parent != tx:
        raise ValueError("снимок вне проверенной TX")
    _, digest, actual = begin.stable_file(scratch, keep=True, limit=None)
    stage = read_stage(tx, record)
    if stage is None and (resume_only or any(os.path.lexists(file) for file in (snapshot, index_file, prepared_file))):
        raise ValueError("обнаружена публикация checkpoint без исходного staging")
    evidence = begin.guard.checkpoint_index_evidence(tx, str(number), actual)
    index_bytes = begin.encoded(evidence)
    if stage is None:
        proof = operation_proof(record, digest, hashlib.sha256(index_bytes).hexdigest())
        header = {"previous": number - 1, "operation": proof, "indexes": evidence}
        name = f"checkpoint-{operation_key(record)}.staged"
        begin.guard.publish_immutable(tx, name, begin.encoded(header) + b"\n" + actual)
        stage = read_stage(tx, record)
    if stage is None:
        raise ValueError("утрачены подготовленные данные checkpoint")
    proof, workspace, indexes = stage
    if workspace != actual or indexes != index_bytes:
        raise ValueError("workspace или реальный index изменился после staging")
    saved = begin.read_proof(prepared_file)
    if (resume_only or os.path.lexists(snapshot) or os.path.lexists(index_file)) and saved != proof:
        raise ValueError("numbered checkpoint без точной operation record")
    begin.guard.publish_immutable(tx, prepared_file.name, begin.encoded(proof))
    begin.guard.publish_immutable(tx, snapshot.name, workspace)
    begin.guard.publish_immutable(tx, index_file.name, indexes)
    return proof


def process_output(helper: str, command: str) -> str:
    return subprocess.check_output([helper, command], text=True, timeout=10).strip()


def binding_path(tx: Path, task: str) -> Path:
    control = tx.parents[2]
    processes = control / "runner-processes"
    begin.owned_directory(processes)
    return processes / f"t{task}.active"


def verify_no_binding(tx: Path, task: str) -> None:
    binding = binding_path(tx, task)
    for suffix in ("", ".scope", ".pending"):
        if os.path.lexists(binding.with_name(binding.name + suffix)):
            raise ValueError("осталась привязка процесса writer")


def verify_quiescence(tx: Path, task: str, record: dict, helper: str) -> None:
    verify_no_binding(tx, task)
    boot = process_output(helper, "boot-id").lower()
    if not UUID.fullmatch(boot):
        raise ValueError("неизвестная загрузка Darwin")
    if boot != record["boot"]:
        return
    for _ in range(2):
        census = json.loads(process_output(helper, "uid-census"))
        if not isinstance(census, list) or any(row["sid"] == int(record["sid"]) for row in census):
            raise ValueError("не доказано завершение сессии writer")


def publish_dispatch(tx: Path, task: str, txid: str, checkpoint: int,
                     records: list[dict], args: list[str]) -> None:
    stage, run, epoch, cursor, boot, pid, sid, pgid, starttime = args
    if len(records) != checkpoint:
        raise ValueError("предыдущий writer не закрепил checkpoint")
    number = checkpoint + 1
    if checkpoint and begin.read_proof(tx / f"checkpoint-{checkpoint}.committed.json") \
            != checkpoint_proof(tx, records[-1]):
        raise ValueError("предыдущий checkpoint не подтверждён")
    record = {"format": 1, "task": task, "attempt": "a_" + begin.TXID.fullmatch(txid)[1], "txid": txid,
              "checkpoint": number, "phase": "may-have-run", "stage": stage, "run": run, "epoch": epoch,
              "cursor": cursor, "boot": boot, "pid": pid, "sid": sid, "pgid": pgid, "starttime": starttime}
    verify_generation(record, task, txid, number)
    mode, _, data = begin.stable_file(binding_path(tx, task), keep=True, sync=True)
    lines = data.decode().splitlines()
    fields = dict(line.split("=", 1) for line in lines)
    exact = {"TASK": task, "STAGE": stage, "RUN_ID": run, "EPOCH": epoch,
             "PID": pid, "SESSION": sid, "PGID": pgid, "STARTTIME": starttime}
    if mode != 0o600 or len(fields) != len(lines) or fields.get("STATE") != "active" \
            or any(fields.get(name) != value for name, value in exact.items()):
        raise ValueError("dispatch не соответствует активной привязке")
    begin.guard.publish_immutable(tx, f"dispatch-{number}.json", begin.encoded(record))


def select(tx: Path, task: str, checkpoint: int, records: list[dict], helper: str) -> None:
    """Восстанавливает тот же checkpoint после отказа на любой границе публикации."""
    if not records:
        verify_no_binding(tx, task)
        print("none")
        return
    record = records[-1]
    number = record["checkpoint"]
    prepared = begin.read_proof(tx / f"checkpoint-{number}.prepared.json")
    committed = begin.read_proof(tx / f"checkpoint-{number}.committed.json")
    if committed is not None or number == checkpoint:
        proof = checkpoint_proof(tx, record)
        if number != checkpoint or prepared != proof or (committed is not None and committed != proof):
            raise ValueError("несогласованная публикация checkpoint")
        if committed is None:
            verify_quiescence(tx, task, record, helper)
            print(f"commit {number}")
        else:
            # Имя могло пережить EIO родителя. Повторно подтверждаем те же байты.
            begin.guard.publish_immutable(tx, f"checkpoint-{number}.committed.json", begin.encoded(proof))
            print("done")
        return
    verify_quiescence(tx, task, record, helper)
    print(f"snapshot {number}")


def main() -> int:
    action, root_text, task, txid, helper, *args = sys.argv[1:]
    root = Path(root_text)
    if begin.TASK.fullmatch(task) is None or root.name != "t" + task or begin.TXID.fullmatch(txid) is None:
        raise ValueError("неверная identity dispatch")
    tx = root / txid
    begin.owned_directory(root)
    begin.owned_directory(tx)
    checkpoint = read_state(tx)
    records = dispatches(tx, task, txid, checkpoint)
    if action == "publish" and len(args) == 9:
        publish_dispatch(tx, task, txid, checkpoint, records, args)
    elif action == "select" and not args:
        select(tx, task, checkpoint, records, helper)
    elif action in {"prepare", "commit", "resume-commit"} and records:
        record = records[-1]
        number = record["checkpoint"]
        if len(args) != (1 if action == "commit" else 2) or args[0] != str(number) \
                or number != checkpoint + (action == "prepare"):
            raise ValueError("операция относится к другому checkpoint")
        if action == "prepare":
            stage_checkpoint(tx, record, Path(args[1]))
            return 0
        if action == "resume-commit":
            stage_checkpoint(tx, record, Path(args[1]), resume_only=True)
        proof = checkpoint_proof(tx, record)
        if begin.read_proof(tx / f"checkpoint-{number}.prepared.json") != proof:
            raise ValueError("нет подготовленной операции checkpoint")
        begin.stable_file(tx / "state.env", sync=True)
        begin.guard.sync_directory(tx)
        begin.guard.publish_immutable(tx, f"checkpoint-{number}.committed.json", begin.encoded(proof))
    else:
        raise ValueError("неизвестный переход checkpoint")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        print("FACTORY_ERROR=release_task_cleanup_required", file=sys.stderr)
        sys.exit(78)
