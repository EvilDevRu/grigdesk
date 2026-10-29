"""Сдача принятых поимённых изменений ровно выбранным способом."""

import argparse
import json
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True
from attempt import artifact, named_file, read_context, read_snapshot, save_snapshot
from project import execute, git, load, main_error, require


def strategy_actions(strategy, actions):
    """Использует тот же словарь действий, что constructor и guard движка.

    FACTORY_HOME предоставляет хост; профиль не ищет соседние исходники сервера.
    """
    home = os.environ.get("FACTORY_HOME")
    require(home and Path(home).is_absolute(), "нужен FACTORY_HOME текущего движка")
    sys.path.insert(0, str(Path(home) / "lib"))
    from delivery_contract import ACTIONS, validate

    validate(strategy, actions)
    return ACTIONS[strategy]


def contract(context, project):
    """Сверяет приёмку, exact permissions и immutable pin до первого Git-эффекта.

    Изменённое описание не может дать продолженной попытке дополнительные действия.
    """
    stage = {
        "id": "ship",
        "runKey": "SHIP",
    }
    require(context["stage"] == stage, "доставка только на SHIP")
    require(context["decisions"]["acceptance"]["status"] == "approved", "нужна приёмка человека")
    delivery = context["delivery"]
    strategy = delivery.get("strategy")
    require(delivery["mode"] == "publish", "сдача отключена")
    actions = strategy_actions(strategy, delivery["actions"])
    targets = {repo["name"]: repo["targetBranch"] for repo in project["repositories"]}
    require(delivery["targetBranches"] == targets, "неверные цели сдачи")
    rows = [line.split("\t") for line in artifact(context, "delivery.tsv").read_text().splitlines()]
    require(all(len(row) == 2 and row[0] in {"strategy", "action", "target"} for row in rows),
            "испорчен pin сдачи")
    expected = [["strategy", strategy]] + [["action", action] for action in actions]
    expected += [["target", name + "=" + target] for name, target in targets.items()]
    require(sorted(rows) == sorted(expected), "контекст не совпадает с pin сдачи")
    return strategy, targets


def preflight(context, project, roots, paths, strategy, targets):
    """Проверяет все repo и чужие checkout перед stage или commit любого из них.

    Только буквальные имена файлов допускаются к stage; shared не публикует рабочую ветку через PR.
    Чужой index, грязный target и non-fast-forward останавливаются без очистки.
    """
    require(strategy != "pull-request" or project["workspace"]["mode"] != "shared",
            "pull-request требует isolated: shared использует рабочую ветку владельца")
    require(paths, "нужен явный список путей задачи")
    selected = {}
    for name in paths:
        repo, relative, file = named_file(roots, name)
        require(not file.is_dir(), "нужен поимённый файл, каталог недопустим")
        tracked = git(roots[repo], "--literal-pathspecs", "ls-files", "-z", "--", relative).split("\0")
        require(file.is_file() or relative in tracked,
                "поимённый путь отсутствует")
        selected.setdefault(repo, set()).add(relative)
    for repo in project["repositories"]:
        name = repo["name"]
        root = roots[name]
        require(git(root, "branch", "--show-current") == context["workspace"][name]["branch"],
                "ветка задачи изменилась")
        staged = set(git(root, "diff", "--cached", "--name-only", "-z").split("\0")) - {""}
        require(staged <= selected.get(name, set()), "в index есть чужие пути")
        if strategy != "merge":
            continue

        if Path(root).resolve() == Path(repo["source"]).resolve():
            require(git(root, "branch", "--show-current") == targets[name],
                    "shared открыт не на целевой ветке: нужен человек")
            continue

        source = repo["source"]
        require(not git(source, "status", "--porcelain"), "целевая копия грязная: нужен человек")
        require(git(source, "branch", "--show-current") == targets[name],
                "целевая ветка не открыта в source: нужен человек")
        source_head = git(source, "rev-parse", "HEAD")
        git(root, "merge-base", "--is-ancestor", source_head, "HEAD")
    return selected


def merge_target(repo, root, target):
    """Переносит объекты из сохранённой копии и выполняет только fast-forward.

    Source checkout остаётся на своей текущей ветке; stash/reset не используются.
    """
    source = repo["source"]
    if Path(source).resolve() == Path(root).resolve():
        require(git(source, "branch", "--show-current") == target, "shared открыт не на целевой ветке")
        return

    require(not git(source, "status", "--porcelain"), "целевая копия изменилась: нужен человек")
    require(git(source, "branch", "--show-current") == target, "целевая ветка изменилась")
    git(source, "fetch", "--no-tags", str(root), git(root, "branch", "--show-current"))
    git(source, "merge", "--ff-only", "FETCH_HEAD")


def deliver(file, paths):
    """Запоминает завершённые действия по repo в доверенном каталоге попытки.

    Повтор успешной сдачи не создаёт новый commit, push или запрос на слияние.
    """
    project = load()
    raw = json.loads(Path(file).read_text())
    context, roots = read_context(file, str(raw["task"]["id"]), project)
    strategy, targets = contract(context, project)
    selected = preflight(context, project, roots, paths, strategy, targets)
    previous = read_snapshot(context, "sample-delivery.json")
    progress = previous["repos"] if previous else {}
    if previous:
        require(previous["strategy"] == strategy, "стратегия сохранённой сдачи изменилась")

    for repo in project["repositories"]:
        name = repo["name"]
        root = roots[name]
        steps = progress.setdefault(name, {})
        files = sorted(selected.get(name, []))
        if "commit" in steps and files:
            require(not git(root, "--literal-pathspecs", "status", "--porcelain", "--", *files),
                    "поимённые файлы изменились после сдачи: нужен человек")
        if "commit" not in steps:
            if files and git(root, "--literal-pathspecs", "status", "--porcelain", "--", *files):
                git(root, "--literal-pathspecs", "add", "--", *files)
                git(root, "commit", "-m", context["task"]["title"])
            steps["commit"] = git(root, "rev-parse", "HEAD")
            save_snapshot(context, "sample-delivery.json", strategy=strategy, repos=progress)
        require(git(root, "rev-parse", "HEAD") == steps["commit"], "результат после сдачи изменился")
        if strategy == "merge" and not steps.get("merge"):
            merge_target(repo, root, targets[name])
            steps["merge"] = True
            save_snapshot(context, "sample-delivery.json", strategy=strategy, repos=progress)
        if strategy == "pull-request":
            branch = git(root, "branch", "--show-current")
            if not steps.get("push"):
                git(root, "push", project["delivery"]["remote"], branch + ":refs/heads/" + branch)
                steps["push"] = True
                save_snapshot(context, "sample-delivery.json", strategy=strategy, repos=progress)
            if not steps.get("pull-request"):
                substitutions = {
                    "{branch}": branch,
                    "{target}": targets[name],
                    "{repo}": name,
                }
                args = [substitutions.get(arg, arg) for arg in project["delivery"]["pullRequestCommand"]]
                result = execute(args, root)
                steps["pull-request"] = result.stdout.strip() or True
                save_snapshot(context, "sample-delivery.json", strategy=strategy, repos=progress)

    lines = ["# Сдача", "", "Способ: " + strategy]
    for name, steps in progress.items():
        lines += ["", f"{name}: {steps['commit']}", "Ветка: " + context["workspace"][name]["branch"],
                  "Копия с результатом: " + roots[name], "Действия: " + ", ".join(steps)]
    Path(context["artifacts"]["ship"]).write_text("\n".join(lines) + "\n")
    print("Работа сдана выбранным способом; копии сохранены.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--context", required=True)
    parser.add_argument("--path", action="append", default=[])
    args = parser.parse_args()
    try:
        deliver(args.context, args.path)
    except (ValueError, OSError, RuntimeError, KeyError, TypeError) as error:
        sys.exit(main_error(error))
