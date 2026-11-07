"""Командная проверка только охвата задачи и строк её diff."""

import difflib
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
from attempt import bases, digest, named_file, read_context, read_snapshot, save_snapshot
from project import adapter, git, inside, load, main_error, matches, require, state_dir


def listed(root, *args):
    return [item for item in git(root, *args).split("\0") if item]


def changes(root, base):
    """Собирает committed, staged, unstaged и untracked изменения от одной базы.

    Удалённые файлы не исполняются, rename проверяется по существующему новому имени.
    """
    tracked = listed(root, "diff", "--name-only", "--no-renames", "-z", base, "--")
    untracked = listed(root, "ls-files", "--others", "--exclude-standard", "-z")
    statuses = listed(root, "diff", "--name-status", "--find-renames", "-z", base, "--")
    renames = {}
    index = 0
    while index < len(statuses):
        status, name = statuses[index:index + 2]
        index += 2
        if status.startswith("R"):
            renames[statuses[index]] = name
            index += 1

    result = {}
    for name in sorted(set(tracked + untracked)):
        file = inside(root, name)
        if not file.is_file() or (Path(root) / name).is_symlink():
            continue

        if name in untracked:
            result[name] = set(range(1, len(file.read_bytes().splitlines()) + 1))
            continue

        names = [renames[name], name] if name in renames else [name]
        patch = git(root, "diff", "--no-ext-diff", "--find-renames", "--unified=0", base, "--", *names)
        lines = set()
        for match in re.finditer(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", patch, re.M):
            start, count = int(match[1]), int(match[2] or 1)
            lines.update(range(start, start + count))
        result[name] = lines
    return result


def tree_hashes(roots):
    """Отпечаток проверенного дерева включает все обычные файлы Git и untracked.

    RECHECK может использовать результат только без delta и в той же попытке.
    """
    result = {}
    for repo, root in roots.items():
        for name in set(listed(root, "ls-files", "-c", "-o", "--exclude-standard", "-z")):
            file = inside(root, name)
            if file.is_file() and not (Path(root) / name).is_symlink():
                result[repo + ":" + name] = digest(file)
    return result


def tests_owner(snapshot, name, line, text):
    """Сопоставляет текущую строку с bytes, закреплёнными после TESTS.

    Перенос номера строки не превращает старый дефект тестов в дефект сборки.
    """
    if snapshot is None or name not in snapshot["files"]:
        return "build"

    old = snapshot["files"][name]["text"].splitlines()
    current = text.splitlines()
    for block in difflib.SequenceMatcher(None, old, current, autojunk=False).get_matching_blocks():
        if block.b <= line - 1 < block.b + block.size:
            return "tests"
    return "build"


def finding(owner, key, summary):
    token = hashlib.sha256(key.encode()).hexdigest()[:20]
    return owner, {
        "id": "check-" + token,
        "summary": " ".join(summary.split())[:500],
    }


def check_tests_snapshot(context, roots, route):
    """Feature требует уже проверенный хостом manifest, а не его свежую подмену.

    Отсутствующий снимок чинят TESTS, изменение его файлов после сдачи чинит BUILD.
    """
    snapshot = read_snapshot(context, "sample-tests.json")
    findings = []
    if route != "feature":
        return snapshot, findings

    if snapshot is None:
        findings.append(finding("tests", "tests-snapshot-missing", "Нет доверенного снимка TESTS"))
        return None, findings

    for name, captured in snapshot["files"].items():
        repo, relative, file = named_file(roots, name)
        if not file.is_file() or digest(file) != captured["sha256"]:
            findings.append(finding("build", "tests-mutated:" + name,
                                    "После TESTS изменён закреплённый тест " + name))
    return snapshot, findings


def style_findings(command, completed, roots, changed, snapshot):
    """JSONL даёт координаты дефектов, из которых остаются только добавленные строки.

    Невалидная диагностика означает отказ окружения, а не зелёную проверку.
    """
    repo = command["repo"]
    root = roots[repo]
    findings = []
    inherited = 0
    rows = []
    for line in completed.stdout.splitlines():
        row = json.loads(line)
        require(isinstance(row, dict) and {"path", "line", "rule", "message"} <= set(row),
                "неверная JSONL диагностика style")
        require(type(row["line"]) is int and row["line"] > 0,
                "неверная строка диагностики style")
        require(all(isinstance(row[key], str) and row[key] for key in ["path", "rule", "message"]),
                "неверные поля диагностики style")
        rows.append(row)
    require(completed.returncode == 0 or rows, "style завершился без диагностики JSONL")
    for row in rows:
        file = Path(row["path"])
        relative = str(file.relative_to(root)) if file.is_absolute() else str(file)
        file = inside(root, relative)
        if row["line"] not in changed[repo].get(relative, set()):
            inherited += 1
            continue

        text = file.read_text()
        lines = text.splitlines()
        require(row["line"] <= len(lines), "style указывает отсутствующую строку")
        name = repo + ":" + relative
        owner = tests_owner(snapshot, name, row["line"], text)
        key = name + ":" + row["rule"] + ":" + lines[row["line"] - 1]
        findings.append(finding(owner, key, name + ": " + row["rule"] + ": " + row["message"]))
    return findings, inherited


def build_comparison(command, current, root, base):
    """Вычитает воспроизводимый отказ сборки на отдельной копии базовой ревизии.

    Рабочее дерево не откатывается; неразделённый отказ не обвиняет продукт.
    """
    with tempfile.TemporaryDirectory(prefix="sample-base-", dir=state_dir()) as temporary:
        baseline = Path(temporary) / "repo"
        git(root, "clone", "--no-hardlinks", "--no-checkout", "--local", str(root), str(baseline))
        git(baseline, "checkout", "--detach", base)
        previous = adapter(command, baseline)
        before = (previous.stdout + previous.stderr).replace(str(baseline), "<workspace>")
        after = (current.stdout + current.stderr).replace(str(root), "<workspace>")
        if previous.returncode == 0:
            return "build"
        return "inherited" if before == after and previous.returncode == current.returncode else "environment"


def verify(project, context, roots, route, node):
    """Запускает только объявленные адаптеры и сохраняет проверенный охват.

    Все замечания сохраняются, корневой владелец выбирается по раннему ремонтному этапу.
    """
    base = bases(context, roots)
    hashes = tree_hashes(roots)
    snapshot, findings = check_tests_snapshot(context, roots, route)
    previous = read_snapshot(context, "sample-verify.json")
    if node == "recheck" and previous and previous["hashes"] == hashes and not findings:
        return previous["verdict"]

    changed = {repo: changes(root, base[repo]) for repo, root in roots.items()}
    logs = []
    inherited = 0
    for kind in ["tests", "style", "build"]:
        for index, command in enumerate(project["checks"][kind]):
            repo = command["repo"]
            root = roots[repo]
            files = sorted(name for name in changed[repo]
                           if kind == "tests" and matches(name, command["match"]))
            if kind == "tests" and not files:
                continue

            key = f"{kind}:{repo}:{index}"
            try:
                completed = adapter(command, root, files)
                logs.append({
                    "check": key,
                    "files": files,
                    "returncode": completed.returncode,
                    "stdout": completed.stdout,
                    "stderr": completed.stderr,
                })
                if kind == "style":
                    found, old = style_findings(command, completed, roots, changed, snapshot)
                    findings.extend(found)
                    inherited += old
                elif completed.returncode:
                    owner = "build" if kind == "tests" else build_comparison(command, completed,
                                                                            root, base[repo])
                    if owner == "inherited":
                        inherited += 1
                    else:
                        findings.append(finding(owner, key, "Не прошла проверка " + key))
            except (ValueError, OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                findings.append(finding("environment", key, "Проверка недоступна: " + str(error)))

    unique = {item["id"]: (owner, item) for owner, item in findings}
    findings = list(unique.values())
    owner = next((kind for kind in ["tests", "build", "environment"]
                  if any(source == kind for source, item in findings)), None)
    verdict = {
        "schema": 1,
        "outcome": "failed" if findings else "done",
        "comment": f"Проверен diff задачи; прежних дефектов вне охвата: {inherited}",
        "failureOwner": owner,
        "findings": [item for source, item in findings[:32]],
    }
    save_snapshot(context, "sample-verify.json", hashes=hashes, verdict=verdict, logs=logs,
                  changed={repo: {file: sorted(lines) for file, lines in files.items()}
                           for repo, files in changed.items()})
    return verdict


def main(task, route, node, run_key, command, file):
    """Неизвестный commandId отвергается до исполнения проектных команд.

    Штатный stdout содержит ровно один JSON-вердикт, исключения тоже типизированы.
    """
    if command not in {"verify", "recheck"} or node != command or run_key != command.upper():
        return main_error("неизвестный commandId")

    try:
        project = load()
        context, roots = read_context(file, task, project)
        result = verify(project, context, roots, route, node)
    except (ValueError, OSError, RuntimeError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        result = {
            "schema": 1,
            "outcome": "failed",
            "comment": "Недоступно доказательство проверки",
            "failureOwner": "environment",
            "findings": [finding("environment", "verification-environment", str(error))[1]],
        }
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:]))
