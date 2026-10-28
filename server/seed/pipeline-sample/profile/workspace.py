"""Независимые локальные Git-копии и health без управления чужими сервисами."""

import json
import os
from pathlib import Path
import shlex
import sys

sys.dont_write_bytecode = True
from project import (
    adapter, atomic_json, git, load, main_error, require, state_dir, task_id, workspaces,
)
from hookData import container


def record_file(task):
    return state_dir() / f"t{task_id(task)}.workspace.json"


def record(p, task):
    """Читает снимок своей копии с точной привязкой к профилю и задаче.

    Чужой или частичный каталог не считается готовым и не удаляется автоматически.
    """
    value = json.loads(record_file(task).read_text())
    require(value["taskId"] == task and value["profile"] == p["id"], "чужой снимок workspace")
    require(value["roots"] == workspaces(p, task), "адреса workspace изменились")
    return value


def prepare(p, task):
    """Создаёт отдельные копии от локальных веток без hardlinks и сетевых обращений.

    Снимок публикуется после prepare; частичная чужая папка остаётся для разбора человеком.
    """
    require(p["workspace"]["mode"] == "isolated", "shared не вызывает up/prepare")
    roots = workspaces(p, task)
    if record_file(task).exists():
        record(p, task)
        return
    require(all(not Path(root).exists() for root in roots.values()), "workspace частично существует")
    bases = {}
    for repo in p["repositories"]:
        root = Path(roots[repo["name"]])
        root.parent.mkdir(parents=True, exist_ok=True)
        bases[repo["name"]] = git(repo["source"], "rev-parse", "refs/heads/" + repo["baseBranch"])
        git(repo["source"], "clone", "--no-hardlinks", "--no-checkout", "--local", repo["source"], str(root))
        git(root, "checkout", "-b", "task-" + task, bases[repo["name"]])
        # В клоне origin изначально указывает в source. Для внешней сдачи нужен
        # объявленный remote исходного проекта, а не локальный адрес checkout.
        remotes = git(repo["source"], "remote").splitlines()
        remote = p["delivery"]["remote"]
        if remote in remotes:
            url = git(repo["source"], "remote", "get-url", remote)
            if remote == "origin":
                git(root, "remote", "set-url", remote, url)
            else:
                git(root, "remote", "add", remote, url)
    for command in p["workspace"]["prepare"]:
        completed = adapter(command, roots[command["repo"]])
        sys.stderr.write(completed.stdout + completed.stderr)
        require(completed.returncode == 0, "prepare завершился ошибкой; копии сохранены")
    atomic_json(record_file(task), {
        "schema": 1,
        "taskId": task,
        "profile": p["id"],
        "roots": roots,
        "bases": bases,
    })
    write_env(p, task, roots)


def write_env(p, task, roots):
    """Атомарно отдаёт transport env с явно пустыми портами режима none.

    Служебный progress стенда не создаётся: UI не должен ждать несуществующий сервис.
    """
    fields = {
        "TASK": task,
        "SB_K": "0",
        "FE_PORT": "",
        "API_PORT": "",
        "PROTOCOL": "route-v2",
        "WORKSPACE_MODE": "isolated",
        "STAND_OWNERSHIP": "task",
        "SOURCE_BRANCH": "task-" + task,
        "CONTAINER": container(p, task),
        "SERVICE_HOST": "127.0.0.1",
        "REPO_COUNT": str(len(roots)),
    }
    for index, repo in enumerate(p["repositories"]):
        values = {
            "NAME": repo["name"],
            "SOURCE": repo["source"],
            "WT": roots[repo["name"]],
            "BRANCH": "task-" + task,
        }
        for field, value in values.items():
            fields[f"REPO_{index}_{field}"] = value
    state_dir().mkdir(parents=True, exist_ok=True)
    text = "".join(key + "=" + (shlex.quote(value) if value else "") + "\n"
                   for key, value in fields.items())
    destinations = [state_dir() / f"t{task}.env"]
    early = os.environ.get("FACTORY_BOOTSTRAP_WORKSPACE_ENV")
    if early:
        require(Path(early).is_absolute(), "ранний env требует абсолютный путь")
        destinations.insert(0, Path(early))
    for file in destinations:
        file.parent.mkdir(parents=True, exist_ok=True)
        temporary = file.with_suffix(".env.tmp")
        temporary.write_text(text)
        temporary.replace(file)


def health(p, task):
    """Проверяет готовность копий либо только объявленный health существующего стенда.

    Shared checkout до первого агента должен быть чистым; чужие изменения не очищаются.
    """
    roots = workspaces(p, task)
    if p["workspace"]["mode"] == "isolated":
        value = record(p, task)
        for name, root in roots.items():
            require(git(root, "rev-parse", "--is-inside-work-tree") == "true", "копия не готова")
        return
    first = not record_file(task).exists()
    if first:
        for root in roots.values():
            require(not git(root, "status", "--porcelain"), "shared содержит правки владельца: нужен человек")
    for command in p["stand"]["health"]:
        completed = adapter(command, roots[command["repo"]])
        sys.stderr.write(completed.stdout + completed.stderr)
        require(completed.returncode == 0, "стенд недоступен: нужен человек")
    if first:
        atomic_json(record_file(task), {
            "schema": 1,
            "taskId": task,
            "profile": p["id"],
            "roots": roots,
            "bases": {name: git(root, "rev-parse", "HEAD") for name, root in roots.items()},
        })


def main(operation, task):
    """Lifecycle меняет только собственную проекцию состояния isolated-задачи.

    Down сохраняет Git-копии вместе с результатом; shared lifecycle запрещён.
    """
    p = load()
    task_id(task)
    if operation == "up":
        prepare(p, task)
    elif operation == "health":
        health(p, task)
    elif operation == "status":
        print(json.dumps(record(p, task), ensure_ascii=False))
    elif operation == "down":
        require(p["workspace"]["mode"] == "isolated", "shared не вызывает down")
        value = record(p, task)
        (state_dir() / f"t{task}.env").unlink(missing_ok=True)
        print("Копии с результатом сохранены: " + ", ".join(value["roots"].values()), file=sys.stderr)
    else:
        raise ValueError("неизвестная операция workspace")


if __name__ == "__main__":
    try:
        main(*sys.argv[1:])
    except (ValueError, OSError, RuntimeError, KeyError) as error:
        sys.exit(main_error(error))
