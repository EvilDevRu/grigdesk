"""Проверяемые свидетельства отдельной разведки до основного курсора.

Операции записи вызывает хост под task lock. Active-файл раннера не используется
как источник находок после публикации неизменяемого успешного checkpoint.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

from route_model import canonical_json

ENGINE = Path(__file__).resolve().parents[1]
HASH_RE = re.compile(r"^[a-f0-9]{64}$")
RUN_RE = re.compile(r"^[A-Za-z0-9._-]+$")
TRANSITION_FIELDS = {
    "schema", "catalogHash", "phase", "node", "outcome", "action", "retry", "escalationPolicy",
}


def fail(message: str, code: int = 78) -> None:
    raise ValueError((code, message))


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Не позволяет дублированным ключам скрыть другое значение identity.
    Правило применяется ко всем вложенным объектам читаемого JSON.
    """
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"повтор JSON-поля {key}")
        result[key] = value
    return result


def read_json(path: Path, immutable: bool = False) -> tuple[dict[str, Any], bytes]:
    """Читает один обычный файл через NOFOLLOW и ограничивает его размер.
    У долговечного свидетельства проверяет владельца, режим и число ссылок.
    """
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 1024 * 1024:
            fail(f"{path.name}: ожидался обычный файл до 1 МиБ")
        if immutable and (
            stat.S_IMODE(info.st_mode) != 0o400 or info.st_nlink != 1 or info.st_uid != os.geteuid()
        ):
            fail(f"{path.name}: небезопасное свидетельство")
        raw = source.read()
    value = json.loads(raw, object_pairs_hook=unique_object, parse_constant=lambda _: fail("NaN/Infinity"))
    if not isinstance(value, dict):
        fail(f"{path.name}: ожидался объект")
    return value, raw


def trusted_directory(path: Path) -> None:
    """Проверяет родительскую границу файлов перед чтением или публикацией.
    Каталог не может быть ссылкой или принадлежать другому пользователю.
    """
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
        fail(f"{path}: недоверенный каталог")
    if stat.S_IMODE(info.st_mode) & 0o022:
        fail(f"{path}: каталог доступен для чужой записи")


def identity(args: list[str]) -> tuple[dict[str, Any], str]:
    """Получает identity только от host helper, проверившего attempt/pins.
    Путь store не переносится в записи и не берётся из текста агента.
    """
    task, attempt, profile, catalog, route, route_hash, routes = args
    expected = {
        "protocolVersion": 2,
        "taskId": task,
        "attemptId": attempt,
        "profile": profile,
        "catalogHash": catalog,
        "routeId": route,
        "routeHash": route_hash,
        "node": "scout",
        "runKey": "SCOUT",
    }
    return expected, routes


def transition_for(expected: dict[str, Any], routes: str, outcome: str, owner: str = "") -> dict[str, Any]:
    """Повторно выбирает переход из закреплённого проверенного bundle.
    Для успешного checkpoint фиксирует исторический canonical envelope.
    """
    args = [
        str(ENGINE / "bin/factory-route"), "--routes-dir", routes,
        "--profile", expected["profile"], "transition-bootstrap",
        "--catalog-hash", expected["catalogHash"], "--node", "scout", "--outcome", outcome,
    ]
    if owner:
        args.extend(["--failure-owner", owner])
    result = subprocess.run(args, capture_output=True, check=False)
    if result.returncode:
        fail("закреплённый bootstrap-переход недоступен")
    value = json.loads(result.stdout, object_pairs_hook=unique_object)
    if not TRANSITION_FIELDS <= value.keys():
        fail("неполный bootstrap-переход")
    return {key: value[key] for key in TRANSITION_FIELDS}


def validate_success_transition(value: dict[str, Any], expected: dict[str, Any]) -> None:
    """Сохраняет pin человека и обязательную политику успешной эскалации.
    Новая разведка не выбирает другой route из допустимого списка сама.
    """
    action = value.get("action")
    allowed = action.get("escalate", {}).get("routes") if isinstance(action, dict) else None
    policy = value.get("escalationPolicy")
    if (
        value.get("schema") != 2 or value.get("catalogHash") != expected["catalogHash"]
        or value.get("phase") != "bootstrap" or value.get("node") != "scout"
        or value.get("outcome") != "done" or not isinstance(allowed, list)
        or expected["routeId"] not in allowed or len(allowed) != len(set(allowed))
        or not isinstance(policy, dict) or policy.get("from") != "scout"
        or policy.get("allowedRoutes") != allowed or policy.get("requiresHumanWhenPinned") is not True
    ):
        fail("bootstrap done не подтверждает выбранный человеком маршрут")


def validate_verdict(result: str, value: Any) -> None:
    """Повторно применяет общий validator, не создавая второй набор правил сдачи.
    Подпроцесс только проверяет JSON и не получает run capability.
    """
    encoded = ""
    if value is not None:
        raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        encoded = base64.b64encode(raw).decode()
    checked = subprocess.run(
        ["bash", "-c", 'source "$1/lib/run-state.sh"; run_state_verdict_validate "$2" "$3"',
         "bootstrap-verdict", str(ENGINE), result, encoded],
        capture_output=True, check=False,
    )
    if checked.returncode:
        fail("недопустимый bootstrap verdict")


def checkpoint(path: Path, expected: dict[str, Any], routes: str) -> tuple[dict[str, Any], bytes]:
    """Проверяет сохранённый успех независимо от текущего SCOUT.active.
    Старый hash без версии emitter сохраняет прежнюю проверку формы и pin-семантики.
    """
    trusted_directory(path.parent)
    value, raw = read_json(path, immutable=True)
    version = value.get("schema")
    keys = set(expected) | {"schema", "result", "runId", "transitionHash"}
    if version == 2:
        keys |= {"epoch", "verdict"}
    elif version != 1 or isinstance(version, bool):
        fail("неподдерживаемая версия bootstrap checkpoint")
    if set(value) != keys or any(value.get(key) != item for key, item in expected.items()):
        fail("bootstrap checkpoint расходится с identity/pins")
    if value.get("result") != "done" or not RUN_RE.fullmatch(value.get("runId", "")):
        fail("bootstrap checkpoint не подтверждает done/run")
    if not HASH_RE.fullmatch(value.get("transitionHash", "")):
        fail("неверный transition hash")
    transition = transition_for(expected, routes, "done")
    validate_success_transition(transition, expected)
    if version == 2:
        epoch = value["epoch"]
        if isinstance(epoch, bool) or not isinstance(epoch, int) or epoch < 1:
            fail("неверный bootstrap epoch")
        validate_verdict("done", value["verdict"])
        digest = hashlib.sha256(canonical_json(transition).encode()).hexdigest()
        if digest != value["transitionHash"]:
            fail("bootstrap transition hash не подтверждён")
    return value, raw


def make_checkpoint(path: Path, expected: dict[str, Any], rest: list[str]) -> None:
    """Материализует новый checkpoint только после host guard и выбора перехода.
    Окончательную атомарную публикацию под task lock выполняет вызывающий хост.
    """
    run_id, epoch, encoded, output = rest
    transition, _ = read_json(path)
    validate_success_transition(transition, expected)
    if not RUN_RE.fullmatch(run_id) or not re.fullmatch(r"[1-9][0-9]*", epoch):
        fail("неверная run identity bootstrap")
    verdict = json.loads(base64.b64decode(encoded, validate=True)) if encoded else None
    validate_verdict("done", verdict)
    value = {
        **expected, "schema": 2, "result": "done", "runId": run_id,
        "epoch": int(epoch), "verdict": verdict,
        "transitionHash": hashlib.sha256(canonical_json(transition).encode()).hexdigest(),
    }
    with open(output, "w", encoding="utf-8") as target:
        target.write(canonical_json(value))
        target.flush()
        os.fsync(target.fileno())


def findings(path: Path, expected: dict[str, Any], routes: str) -> dict[str, Any]:
    """Добавляет отдельный immutable bootstrap-источник к проверенному route ledger.
    Sequence журнала этапов не назначается визиту вне этого журнала.
    """
    ledger = json.load(sys.stdin)
    if not path.exists() and not path.is_symlink():
        return ledger
    value, raw = checkpoint(path, expected, routes)
    verdict = value.get("verdict")
    items = verdict.get("findings", []) if verdict else []
    if not items:
        return ledger
    source = {
        "phase": "bootstrap", "recordHash": hashlib.sha256(raw).hexdigest(),
        "runId": value["runId"], "epoch": value["epoch"],
    }
    result: dict[str, Any] = {"schema": 2}
    for status in ("open", "closed", "deferred"):
        result[status] = [{**item, "source": {"phase": "route"}} for item in ledger.get(status, [])]
    result["deferred"] = [
        {
            "id": item["id"], "sourceNode": "scout", "owner": verdict["owner"],
            "summary": item["summary"], "status": "deferred", "openedSequence": None,
            "lastSeenSequence": None, "closedSequence": None, "source": source,
        }
        for item in sorted(items, key=lambda item: item["id"])
    ] + result["deferred"]
    return result


def main() -> None:
    """CLI получает уже проверенные host pins и не запускает профиль или модель.
    Ошибки чтения и формы всегда выходят с явной fail-closed диагностикой.
    """
    op, path, *args = sys.argv[1:]
    expected, routes = identity(args[:7])
    rest = args[7:]
    if op == "validate":
        checkpoint(Path(path), expected, routes)
    elif op == "make":
        make_checkpoint(Path(path), expected, rest)
    elif op == "findings":
        sys.stdout.write(canonical_json(findings(Path(path), expected, routes)))
    else:
        fail("неизвестная bootstrap-операция")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
        code, message = error.args[0] if error.args and isinstance(error.args[0], tuple) else (78, str(error))
        print(f"bootstrap: {message}", file=sys.stderr)
        raise SystemExit(code)
