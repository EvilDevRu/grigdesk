"""Полная проекция находок для человека и атомарного Markdown-отчёта.

Вход проверен host reader под task lock. Выгрузка не двигает курсор и остаётся
повторяемой после terminal; общий task-level файл является только проекцией.
"""

from __future__ import annotations

import hashlib
import json
import os
import runpy
import sys
import tempfile
from pathlib import Path
from typing import Any

CONTEXT = runpy.run_path(str(Path(__file__).resolve().parents[1] / "bin/factory-context"))


def projection(directory: Path, task: str, profile: str, attempt: str) -> dict[str, Any]:
    """Нормализует полную схему тем же validator, что и контекст этапа.
    Привязывает экспорт к exact attempt и подтверждённым источникам.
    """
    ledger = CONTEXT["findings_ledger"](
        sys.stdin.read(), max_bytes=32 * 1024 * 1024, max_records=20_000,
    )
    events = sorted((directory / "stage-results").glob("event.*.json"))
    checkpoint = directory / "artifacts/bootstrap.json"
    return {
        "schema": 1, "taskId": task, "profile": profile, "attemptId": attempt,
        "bootstrapHash": hashlib.sha256(checkpoint.read_bytes()).hexdigest() if checkpoint.exists() else None,
        "stageLedgerHash": events[-1].name.split(".")[2] if events else None,
        "findings": ledger,
    }


def markdown(value: dict[str, Any]) -> str:
    """Показывает все deferred, сохраняя различимое происхождение каждой находки.
    Отложенная проверка остаётся решением человека и не закрывает критерии задачи.
    """
    items = value["findings"]["deferred"]
    lines = [
        f"# Отложенные находки задачи {value['taskId']}", "",
        f"Профиль: {value['profile']}; попытка: {value['attemptId']}.",
        f"Bootstrap: {value['bootstrapHash'] or 'отсутствует'}.",
        f"Stage ledger: {value['stageLedgerHash'] or 'не инициализирован'}.", "",
        "Маршрут не чинил эти находки. На приёмке реши, принять их как есть,",
        "завести отдельные задачи или вернуть работу с явным требованием.", "",
    ]
    if not items:
        lines.append("Отложенных находок нет.")
    for item in items:
        phase = "разведка" if item.get("source", {}).get("phase") == "bootstrap" else "маршрут"
        lines.append(
            f"- **{item['id']}** ({phase}, {item['sourceNode']} → {item['owner']}): {item['summary']}"
        )
    return "\n".join(lines) + "\n"


def publish(target: Path, value: dict[str, Any]) -> int:
    """Заменяет производный файл целиком и удаляет устаревший пустой хвост.
    При ошибке прежний файл не объявляется актуальным; ledger остаётся неизменным.
    """
    items = value["findings"]["deferred"]
    if not items:
        target.unlink(missing_ok=True)
        return 9
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent, delete=False) as out:
            temporary = out.name
            out.write(markdown(value))
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, target)
        temporary = None
        descriptor = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)
    print(len(items))
    return 0


def main() -> int:
    """Одна операция используется short CLI, API и штатным gate writer.
    Stdin занят JSON, Python-код читается из файла и не конкурирует с данными.
    """
    directory, task, profile, attempt, mode, *rest = sys.argv[1:]
    value = projection(Path(directory), task, profile, attempt)
    if mode == "json":
        print(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2))
    elif mode == "markdown":
        print(markdown(value), end="")
    elif mode == "write" and len(rest) == 1:
        return publish(Path(rest[0]), value)
    else:
        raise ValueError("неизвестный формат выгрузки")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"findings-export: {error}", file=sys.stderr)
        raise SystemExit(1)
