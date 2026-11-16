#!/usr/bin/env python3
"""Небольшие помощники runtime-аналитики хоста без внешних зависимостей.

Этот модуль намеренно не дописывает события в lifecycle-журнал сам. Shell-оболочка
собирает здесь один строгий черновик и передаёт его авторитетному писателю
attempt-lifecycle, которому принадлежат последовательность, хеширование и долговечность.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import stat
import sys
import time
from pathlib import Path
from typing import Any, NoReturn


ID_PREFIXES = {"a", "ev", "os", "nv", "ne", "d", "sp", "lr"}
NULLABLE_IDENTITIES = (
    "nodeVisitId",
    "nodeExecutionId",
    "nodeId",
    "runKey",
    "dispatchId",
    "runId",
    "epoch",
)


def fail(message: str, code: int = 2) -> NoReturn:
    print(f"runtime analytics: {message}", file=sys.stderr)
    raise SystemExit(code)


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8", "strict")).hexdigest()


def identifier(prefix: str, components: list[str]) -> str:
    if prefix not in ID_PREFIXES or not components:
        fail("invalid deterministic id request")
    width = 32
    return f"{prefix}_{digest([1, prefix, components])[:width]}"


def utc_now() -> str:
    value = dt.datetime.now(dt.timezone.utc)
    # Lifecycle использует канонический момент UTC с точностью до миллисекунды.
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def boot_id() -> str:
    try:
        value = Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()
    except OSError:
        fail("boot id is unavailable", 78)
    if not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", value):
        fail("boot id is invalid", 78)
    return value


def strict_json(raw: str, where: str) -> Any:
    try:
        return json.loads(raw, parse_constant=lambda value: fail(f"{where}: invalid {value}"))
    except (json.JSONDecodeError, UnicodeError) as error:
        fail(f"{where}: invalid JSON: {error}")


def put_path(target: dict[str, Any], path: str, value: Any) -> None:
    parts = path.split(".")
    if not parts or any(not re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", item) for item in parts):
        fail(f"invalid JSON field path: {path}")
    cursor = target
    for part in parts[:-1]:
        child = cursor.setdefault(part, {})
        if not isinstance(child, dict):
            fail(f"JSON field collision at {path}")
        cursor = child
    if parts[-1] in cursor:
        fail(f"duplicate JSON field: {path}")
    cursor[parts[-1]] = value


def json_value(kind: str, raw: str) -> Any:
    if kind == "string":
        return raw
    if kind == "integer":
        if not re.fullmatch(r"0|[1-9][0-9]*", raw):
            fail(f"invalid non-negative integer: {raw}")
        value = int(raw)
        if value > 9_007_199_254_740_991:
            fail("integer exceeds JSON safe range")
        return value
    if kind == "signed-integer":
        if not re.fullmatch(r"0|-?[1-9][0-9]*", raw):
            fail(f"invalid integer: {raw}")
        value = int(raw)
        if abs(value) > 9_007_199_254_740_991:
            fail("integer exceeds JSON safe range")
        return value
    if kind == "boolean":
        if raw not in {"true", "false"}:
            fail(f"invalid boolean: {raw}")
        return raw == "true"
    if kind == "null":
        if raw not in {"", "null"}:
            fail("null field carries a value")
        return None
    if kind == "json":
        return strict_json(raw, "field")
    fail(f"unknown JSON field type: {kind}")


def event_draft(kind: str, details_raw: str, event_key: str, span_id: str) -> dict[str, Any]:
    details = strict_json(details_raw, "details")
    if not isinstance(details, dict):
        fail("details must be an object")

    required = {
        "taskId": os.environ.get("FACTORY_LIFECYCLE_TASK_ID", ""),
        "attemptId": os.environ.get("FACTORY_LIFECYCLE_ATTEMPT_ID", ""),
        "profile": os.environ.get("FACTORY_LIFECYCLE_PROFILE", ""),
        "orchestratorSessionId": os.environ.get("FACTORY_LIFECYCLE_SESSION_ID", ""),
    }
    if any(not value for value in required.values()):
        fail("lifecycle context is incomplete", 78)

    route_id = os.environ.get("FACTORY_LIFECYCLE_ROUTE_ID") or None
    route_hash = os.environ.get("FACTORY_LIFECYCLE_ROUTE_HASH") or None
    if (route_id is None) != (route_hash is None):
        fail("route id/hash must be both set or both absent", 78)

    identities: dict[str, Any] = {}
    for field in NULLABLE_IDENTITIES:
        env_name = "FACTORY_LIFECYCLE_" + re.sub(
            r"(?<!^)(?=[A-Z])", "_", field
        ).upper()
        raw = os.environ.get(env_name, "")
        identities[field] = None if raw == "" else int(raw) if field == "epoch" else raw

    at = os.environ.get("FACTORY_LIFECYCLE_EVENT_AT") or utc_now()
    monotonic_ns = os.environ.get("FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS") or str(time.monotonic_ns())
    clock_boot_id = os.environ.get("FACTORY_LIFECYCLE_EVENT_BOOT_ID") or boot_id()
    clock_fidelity = os.environ.get("FACTORY_LIFECYCLE_CLOCK_FIDELITY") or "monotonic"
    if not re.fullmatch(r"0|[1-9][0-9]*", monotonic_ns):
        fail("invalid monotonic clock", 78)
    if clock_fidelity not in {"monotonic", "wall", "derived"}:
        fail("invalid clock fidelity", 78)

    actual_span = (
        None
        if span_id == "-"
        else span_id or os.environ.get("FACTORY_LIFECYCLE_SPAN_ID", "") or None
    )
    event_components = [
        required["attemptId"],
        required["orchestratorSessionId"],
        kind,
        route_id or "",
        *("" if value is None else str(value) for value in identities.values()),
        actual_span or "",
        event_key,
    ]
    return {
        "schemaVersion": 1,
        "protocolVersion": 2,
        "eventId": identifier("ev", event_components),
        "at": at,
        **required,
        "routeId": route_id,
        "routeHash": route_hash,
        **identities,
        "spanId": actual_span,
        "kind": kind,
        "writerVersion": "runtime-analytics/1",
        "clock": {
            "bootId": clock_boot_id,
            "monotonicNs": monotonic_ns,
            "fidelity": clock_fidelity,
        },
        "details": details,
    }


def process_identity(pid_raw: str) -> dict[str, Any]:
    if not re.fullmatch(r"[1-9][0-9]*", pid_raw):
        fail("invalid pid")
    pid = int(pid_raw)
    try:
        stat_line = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    except OSError:
        fail("process identity is unavailable", 73)
    try:
        tail = stat_line.rsplit(") ", 1)[1].split()
        pgrp = int(tail[2])
        session = int(tail[3])
        start_ticks = tail[19]
    except (IndexError, ValueError):
        fail("process identity is malformed", 78)
    return {
        "pid": pid,
        "processGroupId": pgrp,
        "sessionId": session,
        "startTimeTicks": start_ticks,
    }


def get_path(path: str, dotted: str) -> Any:
    try:
        raw = Path(path).read_bytes()
        value = json.loads(raw)
    except (OSError, json.JSONDecodeError, UnicodeError):
        fail(f"cannot read JSON file: {path}", 78)
    for part in dotted.split("."):
        if isinstance(value, list) and part.isdigit():
            value = value[int(part)]
        elif isinstance(value, dict) and part in value:
            value = value[part]
        else:
            fail(f"JSON field is absent: {dotted}", 3)
    return value


def lifecycle_rows(path: str):
    """Отдаёт уже авторитетные строки lifecycle, не ослабляя их ограничений."""
    try:
        with open(path, "rb") as source:
            for ordinal, raw in enumerate(source, start=1):
                if len(raw) > 64 * 1024 or not raw.endswith(b"\n"):
                    fail(f"lifecycle row {ordinal} has an invalid boundary", 78)
                try:
                    value = json.loads(raw)
                except (json.JSONDecodeError, UnicodeError):
                    fail(f"lifecycle row {ordinal} is invalid", 78)
                if not isinstance(value, dict):
                    fail(f"lifecycle row {ordinal} is not an object", 78)
                yield value
    except OSError:
        fail("lifecycle projection is unavailable", 78)


def find_lifecycle_run(path: str, run_id: str, epoch_raw: str) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", run_id):
        fail("invalid run identity")
    if not re.fullmatch(r"[1-9][0-9]*", epoch_raw):
        fail("invalid run epoch")
    epoch = int(epoch_raw)
    matches = [
        row
        for row in lifecycle_rows(path)
        if row.get("kind") == "runner_started"
        and row.get("runId") == run_id
        and row.get("epoch") == epoch
    ]
    if len(matches) != 1:
        fail("exact lifecycle runner identity is unavailable", 73)
    return matches[0]


def find_human_stop(path: str, evidence: str, reason: str) -> dict[str, Any]:
    """Находит уже записанное ожидание exact visit и stage event, независимо от writer session.
    Это проекция, а не принятие результата; отсутствие отличается от конфликта scope.
    """
    if not re.fullmatch(r'[a-f0-9]{64}', evidence):
        fail('invalid human stage evidence', 78)
    names = {
        'taskId': 'TASK_ID', 'attemptId': 'ATTEMPT_ID', 'profile': 'PROFILE',
        'routeId': 'ROUTE_ID', 'routeHash': 'ROUTE_HASH', 'nodeVisitId': 'NODE_VISIT_ID',
        'nodeId': 'NODE_ID', 'runKey': 'RUN_KEY',
    }
    expected = {field: os.environ.get('FACTORY_LIFECYCLE_' + name) for field, name in names.items()}
    if not all(expected.values()):
        fail('human lookup requires exact lifecycle context', 78)
    rows = list(lifecycle_rows(path))
    matches = [row for row in rows
               if row.get('kind') == 'human_intervention_started'
               and row.get('nodeVisitId') == expected['nodeVisitId']]
    if not matches:
        fail('human projection is absent', 3)
    if len(matches) != 1:
        fail('human projection is ambiguous', 78)
    row = matches[0]
    if (any(row.get(k) != value for k, value in expected.items())
            or row.get('details', {}).get('evidenceSha256') != evidence
            or row.get('details', {}).get('reasonCode') != reason):
        fail('human projection scope/evidence conflict', 78)
    if any(item.get('kind') == 'human_intervention_resolved'
           and item.get('spanId') == row.get('spanId') for item in rows):
        fail('exact stop intervention is already resolved', 78)
    return row


def find_recovered_stop(path: str, task: str, attempt: str, profile: str, route: str,
                        route_hash: str, node: str, sequence: str, evidence: str) -> dict[str, Any]:
    """Доказывает, что exact stop уже допроецирован в другой writer session.
    Это позволяет удержать повтор resume без новой сессии и без закрытия вопроса.
    """
    if not re.fullmatch(r'[1-9][0-9]*', sequence):
        fail('invalid recovered stop sequence', 78)
    rows = list(lifecycle_rows(path))
    humans = [row for row in rows if row.get('kind') == 'human_intervention_started'
              and row.get('details', {}).get('evidenceSha256') == evidence]
    if not humans:
        fail('recovered stop is absent', 3)
    if len(humans) != 1:
        fail('recovered stop is ambiguous', 78)
    human = humans[0]
    origins = [row for row in rows if row.get('kind') == 'node_visit_started'
               and row.get('nodeVisitId') == human.get('nodeVisitId')]
    if len(origins) != 1:
        fail('recovered stop origin is ambiguous', 78)
    origin = origins[0]
    expected = {'taskId': 't' + task, 'attemptId': attempt, 'profile': profile,
                'routeId': route, 'routeHash': route_hash, 'nodeId': node, 'runKey': node.upper()}
    if (any(row.get(k) != value for row in (origin, human) for k, value in expected.items())
            or origin.get('details', {}).get('cursorOrdinal') != int(sequence) - 1):
        fail('recovered stop identity conflict', 78)
    if any(row.get('kind') == 'human_intervention_resolved'
           and row.get('spanId') == human.get('spanId') for row in rows):
        fail('the human intervention is already resolved', 3)
    if origin['orchestratorSessionId'] != human['orchestratorSessionId']:
        return human
    # Human append мог успеть в source session до сбоя. Новая host session
    # подтверждает повтор ожидания, не переисполняя завершённый visit.
    scope = {key: value for key, value in expected.items() if key not in {'nodeId', 'runKey'}}
    confirmations = [row for row in rows if row.get('kind') == 'orchestrator_session_started'
                     and row.get('sequence', 0) > human.get('sequence', 0)
                     and row.get('details', {}).get('previousSessionId') == origin['orchestratorSessionId']
                     and all(row.get(k) == value for k, value in scope.items())]
    if not confirmations:
        fail('ordinary stop is not a recovered stop', 3)
    return human


def find_open_span(path: str, started_kind: str, finished_kind: str, node_id: str) -> dict[str, Any]:
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,79}", started_kind):
        fail("invalid started kind")
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,79}", finished_kind):
        fail("invalid finished kind")
    if node_id and not re.fullmatch(r"[a-z0-9][a-z0-9_]{0,40}", node_id):
        fail("invalid node identity")
    opened: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for row in lifecycle_rows(path):
        span_id = row.get("spanId")
        if row.get("kind") == started_kind and isinstance(span_id, str):
            if node_id and row.get("nodeId") != node_id:
                continue
            opened[span_id] = row
            order.append(span_id)
        elif row.get("kind") == finished_kind and isinstance(span_id, str):
            opened.pop(span_id, None)
    available = [opened[span_id] for span_id in order if span_id in opened]
    if not available:
        fail("open lifecycle span is unavailable", 3)
    return available[-1]


def find_open_session(path: str) -> dict[str, Any]:
    """Возвращает последнюю сессию оркестратора без долговечной метки закрытия.

    Более позднее событие crash_detected закрывает точный предыдущий старт по его
    хешу. Без этого правила старый оборванный спан находился бы снова при каждом
    следующем штатно закрытом resume.
    """
    opened: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    by_hash: dict[str, str] = {}
    for row in lifecycle_rows(path):
        kind = row.get("kind")
        span_id = row.get("spanId")
        if kind == "orchestrator_session_started" and isinstance(span_id, str):
            event_hash = row.get("eventHash")
            if not isinstance(event_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", event_hash):
                fail("orchestrator session start hash is invalid", 78)
            opened[span_id] = row
            by_hash[event_hash] = span_id
            order.append(span_id)
        elif kind == "orchestrator_session_finished" and isinstance(span_id, str):
            opened.pop(span_id, None)
        elif kind == "attempt_interrupted":
            details = row.get("details")
            if not isinstance(details, dict) or details.get("reasonCode") != "crash_detected":
                continue
            evidence = details.get("evidenceSha256")
            if isinstance(evidence, str):
                prior_span = by_hash.get(evidence)
                if prior_span is not None:
                    opened.pop(prior_span, None)
    available = [opened[span_id] for span_id in order if span_id in opened]
    if not available:
        fail("open orchestrator session is unavailable", 3)
    return available[-1]


def missing_routing_transitions(stage_path: str, lifecycle_path: str) -> list[dict[str, Any]]:
    expected_keys = {
        "action", "sequence", "stageAt", "stageEventHash", "targetNodeId", "transitionId",
    }
    correlated: dict[str, set[str]] = {}
    for row in lifecycle_rows(lifecycle_path):
        if row.get("kind") not in {
            "gate_decided", "node_visit_finished", "routing_transition_reconciled",
        }:
            continue
        details = row.get("details")
        if not isinstance(details, dict):
            fail("routing lifecycle details are invalid", 78)
        stage_hash = details.get("stageEventHash")
        transition_id = details.get("transitionId")
        if isinstance(stage_hash, str) and isinstance(transition_id, str):
            correlated.setdefault(stage_hash, set()).add(transition_id)

    missing: list[dict[str, Any]] = []
    seen_hashes: set[str] = set()
    try:
        with open(stage_path, "rb") as source:
            for ordinal, raw in enumerate(source, start=1):
                if ordinal > 100_000 or len(raw) > 4096 or not raw.endswith(b"\n"):
                    fail("stage transition projection exceeds its bound", 78)
                try:
                    value = json.loads(raw)
                except (json.JSONDecodeError, UnicodeError):
                    fail("stage transition projection is invalid", 78)
                if not isinstance(value, dict) or set(value) != expected_keys:
                    fail("stage transition projection shape is invalid", 78)
                stage_hash = value.get("stageEventHash")
                transition_id = value.get("transitionId")
                target = value.get("targetNodeId")
                if (
                    not isinstance(stage_hash, str)
                    or not re.fullmatch(r"[a-f0-9]{64}", stage_hash)
                    or transition_id != "tr_" + stage_hash[:32]
                    or value.get("action") not in {"next", "rewind", "stop"}
                    or (value.get("action") == "stop") != (target is None)
                    or (
                        target is not None
                        and (
                            not isinstance(target, str)
                            or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,40}", target)
                        )
                    )
                    or not isinstance(value.get("sequence"), int)
                    or isinstance(value.get("sequence"), bool)
                    or value["sequence"] < 1
                    or not re.fullmatch(
                        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z",
                        str(value.get("stageAt")),
                    )
                    or stage_hash in seen_hashes
                ):
                    fail("stage transition projection identity is invalid", 78)
                seen_hashes.add(stage_hash)
                references = correlated.get(stage_hash, set())
                if references and transition_id not in references:
                    fail("stage/lifecycle transition identity conflicts", 78)
                if transition_id not in references:
                    missing.append(value)
    except OSError:
        fail("stage transition projection is unavailable", 78)
    return missing


def wall_duration_ms(started: str, ended: str) -> int:
    pattern = "%Y-%m-%dT%H:%M:%S.%fZ"
    try:
        before = dt.datetime.strptime(started, pattern).replace(tzinfo=dt.timezone.utc)
        after = dt.datetime.strptime(ended, pattern).replace(tzinfo=dt.timezone.utc)
    except ValueError:
        fail("invalid lifecycle wall instant", 78)
    delta = after - before
    milliseconds = delta.days * 86_400_000 + delta.seconds * 1_000 + delta.microseconds // 1_000
    if milliseconds < 0 or milliseconds > 9_007_199_254_740_991:
        fail("invalid lifecycle wall duration", 78)
    return milliseconds


def event_context(path: str) -> list[str]:
    try:
        value = json.loads(Path(path).read_bytes())
    except (OSError, json.JSONDecodeError, UnicodeError):
        fail("lifecycle event projection is unavailable", 78)
    if not isinstance(value, dict):
        fail("lifecycle event projection is not an object", 78)
    fields = [
        "taskId", "attemptId", "profile", "routeId", "routeHash",
        "orchestratorSessionId", "nodeVisitId", "nodeExecutionId", "nodeId",
        "runKey", "dispatchId", "runId", "epoch", "spanId",
    ]
    output: list[str] = []
    for field in fields:
        item = value.get(field)
        if item is None:
            # TAB для IFS в Bash — пробел, поэтому соседние пустые колонки схлопнутся.
            # Вместо них используем маркер, который не может быть valid lifecycle id.
            output.append("-")
        elif isinstance(item, (str, int)) and "\t" not in str(item) and "\n" not in str(item):
            output.append(str(item))
        else:
            fail(f"lifecycle event has an invalid {field}", 78)
    return output


def _owned_directory(path: str) -> int:
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        fail("durable state directory must be an absolute normalized path", 78)
    flags = os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_DIRECTORY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        info = os.fstat(descriptor)
    except OSError:
        fail("durable state directory is unavailable", 78)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
        os.close(descriptor)
        fail("durable state directory is unsafe", 78)
    return descriptor


def _safe_entry(name: str) -> str:
    if not name or name in {".", ".."} or "/" in name or "\x00" in name:
        fail("durable state entry name is unsafe", 78)
    return name


def durable_replace(source: str, destination: str) -> None:
    """Делает fsync и атомарно публикует уже созданный файл того же каталога."""
    source_dir = os.path.dirname(source)
    destination_dir = os.path.dirname(destination)
    if source_dir != destination_dir:
        fail("durable replace must stay in one directory", 78)
    source_name = _safe_entry(os.path.basename(source))
    destination_name = _safe_entry(os.path.basename(destination))
    directory_fd = _owned_directory(source_dir)
    file_fd = -1
    try:
        try:
            source_info = os.stat(source_name, dir_fd=directory_fd, follow_symlinks=False)
        except OSError:
            fail("durable replace source is unavailable", 78)
        if (
            not stat.S_ISREG(source_info.st_mode)
            or source_info.st_uid != os.geteuid()
            or source_info.st_nlink != 1
        ):
            fail("durable replace source is unsafe", 78)
        try:
            destination_info = os.stat(
                destination_name, dir_fd=directory_fd, follow_symlinks=False
            )
        except FileNotFoundError:
            destination_info = None
        except OSError:
            fail("durable replace destination cannot be inspected", 78)
        if destination_info is not None and (
            not stat.S_ISREG(destination_info.st_mode)
            or destination_info.st_uid != os.geteuid()
            or destination_info.st_nlink != 1
        ):
            fail("durable replace destination is unsafe", 78)
        flags = os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
        file_fd = os.open(source_name, flags, dir_fd=directory_fd)
        opened = os.fstat(file_fd)
        if (opened.st_dev, opened.st_ino) != (source_info.st_dev, source_info.st_ino):
            fail("durable replace source identity changed", 78)
        os.fsync(file_fd)
        os.replace(
            source_name,
            destination_name,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
        )
        os.fsync(directory_fd)
    except OSError:
        fail("durable replace failed", 1)
    finally:
        if file_fd >= 0:
            os.close(file_fd)
        os.close(directory_fd)


def durable_unlink(path: str) -> None:
    directory = os.path.dirname(path)
    name = _safe_entry(os.path.basename(path))
    directory_fd = _owned_directory(directory)
    try:
        try:
            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        except OSError:
            fail("durable unlink target cannot be inspected", 78)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_nlink != 1
        ):
            fail("durable unlink target is unsafe", 78)
        os.unlink(name, dir_fd=directory_fd)
        os.fsync(directory_fd)
    except OSError:
        fail("durable unlink failed", 1)
    finally:
        os.close(directory_fd)


def verified_parent_usage(
    path: str,
    expected_hash: str,
    expected_run: str,
    expected_checkpoint: str,
    expected_provider: str,
    expected_dialect: str,
    expected_scope: str,
) -> dict[str, Any]:
    if (
        re.fullmatch(r"[a-f0-9]{64}", expected_hash) is None
        or re.fullmatch(r"[a-f0-9]{64}", expected_checkpoint) is None
        or not expected_run
        or not expected_provider
        or not expected_dialect
        or not expected_scope
        or len(expected_scope.encode("utf-8", "strict")) > 512
        or any(character in expected_scope for character in "\x00\r\n")
    ):
        fail("parent usage expectation is invalid", 78)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        path_before = os.lstat(path)
        fd = os.open(path, flags)
        try:
            before = os.fstat(fd)
            if (
                not stat.S_ISREG(path_before.st_mode)
                or not stat.S_ISREG(before.st_mode)
                or path_before.st_uid != os.geteuid()
                or before.st_uid != os.geteuid()
                or stat.S_IMODE(path_before.st_mode) != 0o600
                or stat.S_IMODE(before.st_mode) != 0o600
                or path_before.st_nlink != 1
                or before.st_nlink != 1
                or (path_before.st_dev, path_before.st_ino) != (before.st_dev, before.st_ino)
                or before.st_size > 2 * 1024 * 1024
            ):
                fail("parent usage document is unsafe", 78)
            raw = bytearray()
            while len(raw) <= 2 * 1024 * 1024:
                block = os.read(fd, min(1024 * 1024, 2 * 1024 * 1024 + 1 - len(raw)))
                if not block:
                    break
                raw.extend(block)
            after = os.fstat(fd)
        finally:
            os.close(fd)
        path_after = os.lstat(path)
    except OSError:
        fail("parent usage document is unavailable", 78)
    if (
        len(raw) > 2 * 1024 * 1024
        or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
        != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        or (path_after.st_dev, path_after.st_ino, path_after.st_size,
            path_after.st_mtime_ns, path_after.st_ctime_ns)
        != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        or not stat.S_ISREG(path_after.st_mode)
        or path_after.st_uid != os.geteuid()
        or stat.S_IMODE(path_after.st_mode) != 0o600
        or path_after.st_nlink != 1
        or hashlib.sha256(raw).hexdigest() != expected_hash
    ):
        fail("parent usage document identity/hash mismatch", 78)
    try:
        document = json.loads(bytes(raw))
    except (json.JSONDecodeError, UnicodeError):
        fail("parent usage document is invalid", 78)
    checkpoint = document.get("terminalCounterCheckpoint") if isinstance(document, dict) else None
    if (
        bytes(raw) != (canonical(document) + "\n").encode("utf-8", "strict")
        or document.get("runId") != expected_run
        or document.get("provider") != expected_provider
        or document.get("normalizerDialect") != expected_dialect
        or document.get("observedProviderScope") != expected_scope
        or document.get("completeness") != "complete"
        or document.get("resumeEligible") is not True
        or not isinstance(checkpoint, dict)
        or checkpoint.get("checkpointHash") != expected_checkpoint
        or checkpoint.get("counterScope") != expected_scope
        or checkpoint.get("resumeEligible") is not True
    ):
        fail("parent usage checkpoint contract mismatch", 78)
    return {"resumeVerified": True, "terminalCounterCheckpoint": checkpoint}


def main() -> None:
    if len(sys.argv) < 2:
        fail("operation is required")
    operation, *args = sys.argv[1:]
    if operation == "id":
        if len(args) < 2:
            fail("id requires prefix and components")
        print(identifier(args[0], args[1:]))
    elif operation == "now":
        if args:
            fail("now takes no arguments")
        print(utc_now(), time.monotonic_ns(), boot_id(), sep="\t")
    elif operation == "json":
        if len(args) % 3:
            fail("json requires PATH TYPE VALUE triples")
        output: dict[str, Any] = {}
        for index in range(0, len(args), 3):
            put_path(output, args[index], json_value(args[index + 1], args[index + 2]))
        print(canonical(output))
    elif operation == "event":
        if len(args) not in {2, 3, 4}:
            fail("event requires KIND DETAILS [EVENT_KEY [SPAN_ID]]")
        value = event_draft(
            args[0], args[1], args[2] if len(args) >= 3 else "default",
            args[3] if len(args) >= 4 else "",
        )
        print(canonical(value))
    elif operation == "process":
        if len(args) != 1:
            fail("process requires PID")
        print(canonical(process_identity(args[0])))
    elif operation == "hash-string":
        if len(args) != 1:
            fail("hash-string requires one value")
        print(hashlib.sha256(args[0].encode("utf-8", "strict")).hexdigest())
    elif operation == "hash-file":
        if len(args) != 1:
            fail("hash-file requires one path")
        try:
            with open(args[0], "rb") as source:
                hasher = hashlib.sha256()
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    hasher.update(block)
        except OSError:
            fail("cannot hash file", 78)
        print(hasher.hexdigest())
    elif operation == "get":
        if len(args) != 2:
            fail("get requires PATH FIELD")
        value = get_path(args[0], args[1])
        if value is None:
            print("null")
        elif isinstance(value, bool):
            print("true" if value else "false")
        elif isinstance(value, (dict, list)):
            print(canonical(value))
        else:
            print(value)
    elif operation == "find-run":
        if len(args) != 3:
            fail("find-run requires LEDGER RUN EPOCH")
        print(canonical(find_lifecycle_run(*args)))
    elif operation == 'find-human-stop':
        if len(args) != 3:
            fail('find-human-stop requires LEDGER EVIDENCE REASON')
        print(canonical(find_human_stop(*args)))
    elif operation == 'find-recovered-stop':
        if len(args) != 9:
            fail('find-recovered-stop requires LEDGER TASK ATTEMPT PROFILE ROUTE HASH NODE SEQ EVIDENCE')
        print(canonical(find_recovered_stop(*args)))
    elif operation == "find-open-span":
        if len(args) not in {3, 4}:
            fail("find-open-span requires LEDGER STARTED FINISHED [NODE]")
        print(canonical(find_open_span(args[0], args[1], args[2], args[3] if len(args) == 4 else "")))
    elif operation == "find-open-session":
        if len(args) != 1:
            fail("find-open-session requires LEDGER")
        print(canonical(find_open_session(args[0])))
    elif operation == "missing-routing-transitions":
        if len(args) != 2:
            fail("missing-routing-transitions requires STAGE_PROJECTION LEDGER")
        for transition in missing_routing_transitions(*args):
            print(canonical(transition))
    elif operation == "wall-ms":
        if len(args) != 2:
            fail("wall-ms requires STARTED ENDED")
        print(wall_duration_ms(*args))
    elif operation == "event-context":
        if len(args) != 1:
            fail("event-context requires EVENT")
        print(*event_context(args[0]), sep="\t")
    elif operation == "durable-replace":
        if len(args) != 2:
            fail("durable-replace requires SOURCE DESTINATION")
        durable_replace(*args)
    elif operation == "durable-unlink":
        if len(args) != 1:
            fail("durable-unlink requires PATH")
        durable_unlink(*args)
    elif operation == "parent-usage":
        if len(args) != 7:
            fail("parent-usage requires PATH HASH RUN CHECKPOINT PROVIDER DIALECT SCOPE")
        print(canonical(verified_parent_usage(*args)))
    else:
        fail(f"unknown operation: {operation}")


if __name__ == "__main__":
    main()
