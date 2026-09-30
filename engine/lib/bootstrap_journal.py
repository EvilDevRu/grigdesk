"""Append-only вопросы отдельной разведки и адресованные им решения.

Хост удерживает task lock при любой операции. Журнал не создаёт основной курсор,
а результат раннера не становится authority до guard и проверки закреплённого перехода.
"""

from __future__ import annotations

import base64
import hashlib
import os
import re
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from bootstrap_state import (
    canonical_json, checkpoint, fail, identity, read_json, trusted_directory,
    transition_for, unique_object, validate_success_transition, validate_verdict,
)
from route_model import FAILURE_OWNERS, select_node_transition

EVENT_RE = re.compile(r"^event\.([0-9]{20})\.([a-f0-9]{64})\.json$")
VISIT_RE = re.compile(r"^b_[a-f0-9]{32}$")
RUN_RE = re.compile(r"^[A-Za-z0-9._-]+$")
EXTRA_KEYS = {
    "visit": {"decisionHash"},
    "stop": {"outcome", "reason", "verdict", "runs", "transitionHash"},
    "decision": {"stopHash", "answer"},
    "completed": {"checkpointHash"},
}


def text_value(value: Any, label: str) -> str:
    """Ограничивает вопрос и ответ до записи, сохраняя абзацы человека.
    Управляющие символы, кроме перевода строки и табуляции, не попадают в промпт.
    """
    if not isinstance(value, str) or not value.strip() or len(value) > 20000:
        fail(f"{label}: требуется непустой текст до 20000 символов", 75)
    if any(ord(char) < 32 and char not in "\n\t" or ord(char) == 127 for char in value):
        fail(f"{label}: управляющий символ", 75)
    return value


def journal_dir(attempt: Path, create: bool = False) -> Path:
    """Отделяет журнал bootstrap от hash-chain основного маршрута.
    Новый каталог принадлежит хосту и закрыт для чужой записи.
    """
    trusted_directory(attempt)
    directory = attempt / "bootstrap-results"
    if create:
        directory.mkdir(mode=0o700, exist_ok=True)
    if directory.exists() or directory.is_symlink():
        trusted_directory(directory)
    return directory


def validate_runs(runs: Any, outcome: str) -> None:
    """Сохраняет реально исполненные run/epoch, включая молчавшие попытки.
    Исчерпание бюджета не выдаётся за committed результат агента.
    """
    if not isinstance(runs, list) or not runs or len(runs) > 1000:
        fail("bootstrap: неверный список исполнений")
    seen = set()
    for run in runs:
        if not isinstance(run, dict) or set(run) != {"runId", "epoch", "result"}:
            fail("bootstrap: неверная форма исполнения")
        key = (run["runId"], run["epoch"])
        if (
            not isinstance(key[0], str) or not RUN_RE.fullmatch(key[0])
            or isinstance(key[1], bool) or not isinstance(key[1], int) or key[1] < 1
            or run["result"] not in (None, "failed", "skipped") or key in seen
        ):
            fail("bootstrap: неверный run/epoch или результат исполнения")
        seen.add(key)
    if outcome == "exhausted" and any(run["result"] is not None for run in runs):
        fail("bootstrap: exhausted содержит committed результат")
    if outcome != "exhausted" and runs[-1]["result"] != outcome:
        fail("bootstrap: исход не совпадает с последним исполнением")


def read_events(attempt: Path, expected: dict[str, Any], routes: str) -> list[dict[str, Any]]:
    """Проверяет полную неизменяемую цепочку до выдачи actionable остановки.
    Нет mutable указателя: текущий визит и решение выводятся из predecessor событий.
    """
    directory = journal_dir(attempt)
    if not directory.exists():
        return []
    events = []
    previous = None
    visit = None
    stop = None
    decision = None
    completed = False
    for name in sorted(entry.name for entry in directory.iterdir() if not entry.name.startswith(".")):
        match = EVENT_RE.fullmatch(name)
        if not match or len(events) >= 4096:
            fail("bootstrap: неизвестный файл или слишком длинный журнал")
        value, raw = read_json(directory / name, immutable=True)
        kind = value.get("kind")
        keys = set(expected) | {
            "schema", "phase", "sequence", "previousEventHash", "at", "kind", "visitId",
        } | EXTRA_KEYS.get(kind, set())
        if (
            kind not in EXTRA_KEYS or set(value) != keys
            or any(value.get(key) != item for key, item in expected.items())
            or value["schema"] != 1 or isinstance(value["schema"], bool)
            or value["phase"] != "bootstrap" or value["sequence"] != len(events) + 1
            or isinstance(value["sequence"], bool)
            or int(match[1]) != value["sequence"] or value["previousEventHash"] != previous
            or hashlib.sha256(raw).hexdigest() != match[2]
            or raw != canonical_json(value).encode()
            or not isinstance(value["visitId"], str) or not VISIT_RE.fullmatch(value["visitId"])
        ):
            fail("bootstrap: identity, predecessor или digest журнала не подтверждены")
        try:
            datetime.strptime(value["at"], "%Y-%m-%dT%H:%M:%SZ")
        except (ValueError, TypeError):
            fail("bootstrap: неверная дата события")
        if kind == "visit":
            if completed or stop is not None and decision is None:
                fail("bootstrap: новый визит без решения человека")
            expected_decision = decision["recordHash"] if decision else None
            if value["decisionHash"] != expected_decision:
                fail("bootstrap: визит не связан с последним решением")
            if any(event["kind"] == "visit" and event["visitId"] == value["visitId"] for event in events):
                fail("bootstrap: повтор visitId")
            visit, stop = value, None
        else:
            if visit is None or value["visitId"] != visit["visitId"] or completed:
                fail("bootstrap: событие не относится к текущему визиту")
            if kind == "stop":
                if stop is not None or value["outcome"] not in ("failed", "skipped", "exhausted"):
                    fail("bootstrap: неверная остановка")
                text_value(value["reason"], "причина")
                validate_runs(value["runs"], value["outcome"])
                if value["outcome"] == "exhausted":
                    if value["verdict"] is not None:
                        fail("bootstrap: exhausted не имеет вердикта агента")
                else:
                    validate_verdict(value["outcome"], value["verdict"])
                owner = (value["verdict"] or {}).get("owner", "")
                transition = transition_for(expected, routes, value["outcome"], owner)
                if transition["action"] != {"stop": "human"}:
                    fail("bootstrap: остановка не объявлена закреплённым каталогом")
                if hashlib.sha256(canonical_json(transition).encode()).hexdigest() != value["transitionHash"]:
                    fail("bootstrap: transition hash не подтверждён")
                stop, decision = value, None
            elif kind == "decision":
                if stop is None or decision is not None or value["stopHash"] != stop["recordHash"]:
                    fail("bootstrap: решение не адресует ожидающую остановку")
                text_value(value["answer"], "ответ")
                decision = value
            else:
                if stop is not None:
                    fail("bootstrap: завершённый визит содержит остановку")
                _, raw_checkpoint = checkpoint(attempt / "artifacts/bootstrap.json", expected, routes)
                if hashlib.sha256(raw_checkpoint).hexdigest() != value["checkpointHash"]:
                    fail("bootstrap: завершение не связано с checkpoint")
                completed = True
        value = {**value, "recordHash": match[2]}
        if kind == "stop":
            stop = value
        elif kind == "decision":
            decision = value
        events.append(value)
        previous = match[2]
    return events


def append_event(
    attempt: Path, expected: dict[str, Any], events: list[dict[str, Any]],
    kind: str, visit_id: str, payload: dict[str, Any],
) -> dict[str, Any]:
    """Публикует fsync + rename одного content-addressed события под task lock.
    Незавершённый временный файл не является частью цепочки и не двигает её head.
    """
    directory = journal_dir(attempt, create=True)
    value = {
        **expected, "schema": 1, "phase": "bootstrap", "sequence": len(events) + 1,
        "previousEventHash": events[-1]["recordHash"] if events else None,
        "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "kind": kind, "visitId": visit_id, **payload,
    }
    raw = canonical_json(value).encode()
    digest = hashlib.sha256(raw).hexdigest()
    filename = directory / f"event.{value['sequence']:020d}.{digest}.json"
    fd, temporary = tempfile.mkstemp(prefix=".pending-", dir=directory)
    try:
        with os.fdopen(fd, "wb") as target:
            target.write(raw)
            target.flush()
            os.fchmod(target.fileno(), 0o400)
            os.fsync(target.fileno())
        if filename.exists() or filename.is_symlink():
            fail("bootstrap: конфликт публикации", 75)
        os.rename(temporary, filename)
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {**value, "recordHash": digest}


def projection(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Отдаёт вопрос отдельно от основного cursor и сохраняет подтверждённый ответ.
    Новый визит помечается running, поэтому прежний вопрос больше не actionable.
    """
    stop = next((event for event in reversed(events) if event["kind"] == "stop"), None)
    decision = next((event for event in reversed(events) if event["kind"] == "decision"), None)
    latest = events[-1] if events else None
    state = {
        "stop": "waiting", "decision": "answered", "visit": "running", "completed": "completed",
    }.get(latest["kind"]) if latest else None
    return {"state": state, "visit": latest, "stop": stop, "decision": decision}


def preflight(description: Path, expected: dict[str, Any], routes: str) -> None:
    """Отклоняет неподдерживаемую bootstrap topology до платного запуска модели.
    Owner override проверяется тем же selector, что используется при реальном failed.
    """
    value, _ = read_json(description)
    machine = value.get("machine", {})
    if (
        value.get("catalogHash") != expected["catalogHash"] or value.get("profile") != expected["profile"]
        or value.get("schema") != 2
        or
        machine.get("entry") != "scout" or len(machine.get("nodes", [])) != 1
        or machine.get("sequence") != {"bootstrap": ["scout"]}
    ):
        fail("bootstrap: поддерживается только отдельный scout")
    action, policy, node = select_node_transition(machine, "scout", "done")
    validate_success_transition({
        "schema": 2, "catalogHash": expected["catalogHash"], "phase": "bootstrap", "node": "scout",
        "outcome": "done", "action": action, "retry": node.get("retry"), "escalationPolicy": policy,
    }, expected)
    for outcome, owner in [("failed", ""), ("skipped", ""), ("exhausted", "")]:
        action, _, _ = select_node_transition(machine, "scout", outcome)
        if action != {"stop": "human"}:
            fail(f"bootstrap: неподдерживаемое действие {outcome}")
    for owner in sorted(FAILURE_OWNERS):
        action, _, _ = select_node_transition(machine, "scout", "failed", owner)
        if action != {"stop": "human"}:
            fail(f"bootstrap: неподдерживаемый onFailure[{owner}]")


def main() -> None:
    """Выполняет одну короткую host-операцию над уже проверенной attempt identity.
    Ответ записывается отдельно от resume и не запускает модель или подготовку среды.
    """
    import json

    op, attempt_path, *args = sys.argv[1:]
    expected, routes = identity(args[:7])
    rest = args[7:]
    attempt = Path(attempt_path)
    if op == "preflight":
        preflight(Path(rest[0]), expected, routes)
        return
    events = read_events(attempt, expected, routes)
    view = projection(events)
    result: dict[str, Any] = view
    if op == "begin":
        if view["state"] in ("waiting", "completed"):
            fail("bootstrap: визит не разрешён", 75)
        decision = view["decision"]
        result = append_event(attempt, expected, events, "visit", "b_" + uuid.uuid4().hex, {
            "decisionHash": decision["recordHash"] if decision else None,
        })
    elif op == "stop":
        visit_id, outcome, reason_file, verdict_b64, runs_file = rest
        if view["state"] not in ("running", "waiting") or view["visit"]["visitId"] != visit_id:
            fail("bootstrap: визит уже изменился", 75)
        reason = text_value(Path(reason_file).read_text(encoding="utf-8"), "причина")
        verdict = json.loads(base64.b64decode(verdict_b64, validate=True), object_pairs_hook=unique_object) \
            if verdict_b64 else None
        runs = json.loads(Path(runs_file).read_text(encoding="utf-8"), object_pairs_hook=unique_object)
        validate_runs(runs, outcome)
        if outcome != "exhausted":
            validate_verdict(outcome, verdict)
        elif verdict is not None:
            fail("bootstrap: exhausted не имеет вердикта агента")
        transition = transition_for(expected, routes, outcome, (verdict or {}).get("owner", ""))
        if transition["action"] != {"stop": "human"}:
            fail("bootstrap: действие не является stop human")
        payload = {
            "outcome": outcome, "reason": reason, "verdict": verdict, "runs": runs,
            "transitionHash": hashlib.sha256(canonical_json(transition).encode()).hexdigest(),
        }
        if view["state"] == "waiting":
            if any(view["stop"].get(key) != value for key, value in payload.items()):
                fail("bootstrap: конфликт повторной остановки", 75)
            result = view["stop"]
        else:
            result = append_event(attempt, expected, events, "stop", visit_id, payload)
    elif op == "answer":
        visit_id, stop_hash, answer_file = rest
        answer = text_value(Path(answer_file).read_text(encoding="utf-8"), "ответ")
        confirmed = next((event for event in events if event["kind"] == "decision"
                          and event["visitId"] == visit_id and event["stopHash"] == stop_hash), None)
        if confirmed:
            if confirmed["answer"] != answer:
                fail("bootstrap: на визит уже принят другой ответ", 75)
            result = confirmed
        elif (
            view["state"] != "waiting" or view["stop"]["visitId"] != visit_id
            or view["stop"]["recordHash"] != stop_hash
        ):
            fail("bootstrap: устаревший визит или stop hash", 75)
        else:
            result = append_event(attempt, expected, events, "decision", visit_id, {
                "stopHash": stop_hash, "answer": answer,
            })
    elif op == "completed":
        visit_id = rest[0]
        if view["state"] == "completed" and view["visit"]["visitId"] == visit_id:
            sys.stdout.write(canonical_json(view["visit"]))
            return
        if view["state"] != "running" or view["visit"]["visitId"] != visit_id:
            fail("bootstrap: завершение другого визита", 75)
        _, raw = checkpoint(attempt / "artifacts/bootstrap.json", expected, routes)
        result = append_event(attempt, expected, events, "completed", visit_id, {
            "checkpointHash": hashlib.sha256(raw).hexdigest(),
        })
    elif op != "read":
        fail("bootstrap: неизвестная операция журнала")
    sys.stdout.write(canonical_json(result))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError) as error:
        code, message = error.args[0] if error.args and isinstance(error.args[0], tuple) else (78, str(error))
        print(f"bootstrap: {message}", file=sys.stderr)
        raise SystemExit(code)
