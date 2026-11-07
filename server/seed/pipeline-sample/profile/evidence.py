"""Хостовая проверка тестового снимка и приёмки всей постановки."""

import json
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
from attempt import bases, digest, named_file, read_context, save_snapshot
from project import load, main_error, matches, require


def capture_tests(project, context, roots, run):
    """Закрепляет фактические bytes TESTS после проверки manifest хостом.

    Последующая подмена manifest не меняет виновника изменения закреплённых файлов.
    """
    bases(context, roots)
    manifest = Path(context["artifacts"]["testsDigest"]).read_text().splitlines()
    require(manifest, "TESTS: пустой manifest")
    files = {}
    for line in manifest:
        match = re.fullmatch(r"([a-f0-9]{64})  (.+)", line)
        require(match, "TESTS: неверный manifest")
        name = match[2]
        repo, relative, file = named_file(roots, name)
        require(name not in files and file.is_file(), "TESTS: неверный файл")
        require(any(command["repo"] == repo and matches(relative, command["match"])
                    for command in project["checks"]["tests"]), "TESTS: файл не исполняется адаптером")
        require(digest(file) == match[1], "TESTS: bytes не совпадают с manifest")
        files[name] = {
            "sha256": match[1],
            "text": file.read_text(),
        }
    save_snapshot(context, "sample-tests.json", runId=run, files=files)


def evidence_file(value):
    return isinstance(value, str) and Path(value).is_absolute() and Path(value).is_file()


def description_items(description):
    """Разделяет постановку по нумерованным и маркированным пунктам Markdown.

    Вводный текст сохраняется отдельным пунктом; переносы внутри пункта не теряются.
    """
    parts = re.split(r"(?m)^[ \t]*(?:\d+[.)]|[-*+])[ \t]+", description)
    items = ["\n".join(line.strip() for line in part.strip().splitlines())
             for part in parts if part.strip()]

    return items or [description]


def acceptance(project, context, run):
    """Принимает только полный отчёт текущего запуска по всем критериям задачи.

    UI требует заданный доступный стенд и сохранённое браузерное доказательство.
    """
    task = str(context["task"]["id"])
    file = Path(context["workspace"]["stateDir"]) / f"t{task}.acceptance.json"
    value = json.loads(file.read_text())
    require(value["schema"] == 1 and str(value["taskId"]) == task, "приёмка другой задачи")
    require(value["attemptId"] == context["attempt"]["id"] and value["runId"] == run,
            "приёмка другой попытки или запуска")

    task_data = context["task"]
    expected = task_data["acceptanceCriteria"] or description_items(task_data["description"])
    rows = value["criteria"]

    require(isinstance(rows, list) and len(rows) == len(expected), "не проверены все критерии")
    require(sorted(row["criterion"] for row in rows) == sorted(expected), "неверный охват приёмки")
    require(all(row["status"] == "passed" and evidence_file(row["evidence"]) for row in rows),
            "не все критерии доказаны")
    if project["stand"]["hasInterface"]:
        require(project["workspace"]["mode"] == "shared", "UI без стенда: нужен человек")
        require(value["mode"] == "browser", "UI требует браузер")
        for field in ["frontendUrl", "apiUrl"]:
            require(context["services"][field] == project["stand"][field],
                    "обязательный стенд недоступен: нужен человек")
        require(value["url"] == project["stand"]["frontendUrl"], "проверен другой стенд")
        require(evidence_file(value.get("browserEvidence")), "нет доказательства браузера")
    else:
        require(value["mode"] == "commands", "без UI приёмка выполняется командами")


def check(task, route, node, run_key, outcome, run, file):
    """Отклоняет недоказанный done, остальные результаты оставляет маршруту.

    Hooks выполняются после runner, поэтому снимки имеют хостовое происхождение.
    """
    project = load()
    if outcome != "done":
        return

    context, roots = read_context(file, task, project, readonly=node != "tests")
    require(context["stage"]["id"] == node and context["stage"]["runKey"] == run_key,
            "контекст другого узла")
    if node == "tests":
        capture_tests(project, context, roots, run)
    elif node == "browser":
        acceptance(project, context, run)


if __name__ == "__main__":
    try:
        check(*sys.argv[1:])
    except (ValueError, OSError, RuntimeError, KeyError, TypeError) as error:
        sys.exit(main_error(error))
