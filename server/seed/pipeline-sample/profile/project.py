"""Единственный проектный ввод и безопасное исполнение объявленных argv."""

import fnmatch
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
PROFILE = Path(__file__).resolve().parent
ID = r"[a-z0-9][a-z0-9_-]{0,40}"
BRANCH = r"[A-Za-z0-9][A-Za-z0-9._/-]{0,79}"


def require(condition, message):
    """Прерывает обработку до эффектов при нарушении закрытого контракта.

    Диагностика всегда указывает единственный исправляемый проектный файл.
    """
    if not condition:
        raise ValueError("project.json: " + message)


def keys(value, expected):
    """Не позволяет опечатке в декларации молча включить другое поведение.

    Все обязательные поля существуют, дополнительные поля отвергаются.
    """
    require(isinstance(value, dict) and set(value) == set(expected.split()), "неверные поля описания")


def relative(value):
    """Проверяет относительный путь внутри репозитория без переходов наверх.

    Реальный путь дополнительно проверяется в границе чтения или записи файла.
    """
    require(isinstance(value, str) and value and not Path(value).is_absolute(), "нужен относительный путь")
    require(not any(part in {"..", ".git"} for part in Path(value).parts), "выход из репозитория")
    require(not re.search(r"[\x00-\x20:\\\\]", value), "неподдерживаемый путь")
    return value


def inside(root, value):
    """Не позволяет объявленному пути пройти через ссылку за границу репозитория.

    Используется одинаково при тестировании, закреплении тестов и сдаче работы.
    """
    file = (Path(root) / relative(value)).resolve()
    require(file.is_relative_to(Path(root).resolve()), "путь вне репозитория")
    return file


def absolute(value):
    """Отвергает адреса, которые текущий transport движка не способен передать.

    Значение пути остаётся одним argv, а не исполняемым shell-текстом.
    """
    require(isinstance(value, str) and Path(value).is_absolute(), "нужен абсолютный путь")
    require(re.fullmatch(r"/[A-Za-z0-9_./@+-]+", value), "символ пути не поддержан transport")
    return Path(value).resolve()


def strings(value):
    return isinstance(value, list) and all(isinstance(item, str) and item for item in value)


def argv(value):
    require(strings(value) and not any("\0" in arg for arg in value), "команда должна быть массивом argv")


def git(root, *args):
    return execute(["git", "-C", str(root), *args], root).stdout.strip()


def execute(args, cwd, timeout=60):
    """Исполняет ровно объявленные аргументы с конечным временем ожидания.

    Shell не участвует; вывод возвращается вызывающей границе для разбора и журналирования.
    """
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr or result.stdout or f"Команда завершилась: {result.returncode}")
    return result


def adapter(command, root, files=None):
    """Подставляет файлы отдельными аргументами, сохраняя остальные bytes argv.

    Пустой охват тестов никогда не превращается в вызов полного набора.
    """
    args = []
    for arg in command["argv"]:
        args.extend(files or []) if arg == "{files}" else args.append(arg)
    return subprocess.run(args, cwd=root, text=True, capture_output=True,
                          timeout=command["timeoutSeconds"], check=False)


def matches(file, pattern):
    return fnmatch.fnmatchcase(file, pattern) or fnmatch.fnmatchcase(file, pattern.replace("**/", ""))


def stand_address(value):
    """Ограничивает URL формой, которую движок переносит без изменения адреса.

    HTTPS, пути, отсутствующий порт и разные хосты требуют другого transport.
    """
    require(isinstance(value, str), "нужны оба адреса стенда")
    parsed = urlsplit(value)
    require(parsed.scheme == "http" and parsed.path == "" and not parsed.query and not parsed.fragment,
            "URL стенда: нужен http://<host>:<port> без пути")
    require(not parsed.username and not parsed.password and parsed.hostname is not None,
            "URL стенда: неверный хост")
    require(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,61}[A-Za-z0-9])?", parsed.hostname),
            "URL стенда: хост не поддержан transport")
    require(parsed.port is not None and 1000 <= parsed.port <= 65535, "URL стенда: нужен порт 1000..65535")
    return parsed


def load():
    """Полностью проверяет описание прежде, чем любой hook получит его проекцию.

    Source профиля только читает данные; configure отдельно выполняет явные изменения настроек.
    """
    p = json.loads((PROFILE / "project.json").read_text())
    keys(p, "schema id repositories workspace checks stand stack guardrails permissions "
         "volatilePaths delivery executors")
    require(p["schema"] == 1, "неизвестная schema")
    require(isinstance(p["id"], str) and re.fullmatch(ID, p["id"]), "неверный id")
    require(p["id"] == PROFILE.name, "id должен совпадать с каталогом скопированного профиля")
    require(isinstance(p["repositories"], list) and 1 <= len(p["repositories"]) <= 16,
            "нужны репозитории")
    names = set()
    for repo in p["repositories"]:
        keys(repo, "name source baseBranch targetBranch productRules")
        require(isinstance(repo["name"], str) and re.fullmatch(ID, repo["name"]), "неверное имя repo")
        require(repo["name"] not in names, "повтор repo")
        names.add(repo["name"])
        source = absolute(repo["source"])
        require(source.is_dir() and git(source, "rev-parse", "--is-inside-work-tree") == "true",
                "source должен быть существующим Git-репозиторием")
        for field in ["baseBranch", "targetBranch"]:
            require(isinstance(repo[field], str) and re.fullmatch(BRANCH, repo[field])
                    and ".." not in repo[field], "неверная ветка")
        git(source, "rev-parse", "--verify", "refs/heads/" + repo["baseBranch"])
        require(inside(source, repo["productRules"]).is_file(), "файл правил продукта отсутствует")
    keys(p["workspace"], "mode root prepare")
    require(p["workspace"]["mode"] in {"isolated", "shared"}, "неверный workspace.mode")
    root = absolute(p["workspace"]["root"])
    for repo in p["repositories"]:
        source = Path(repo["source"]).resolve()
        require(not root.is_relative_to(source) and not source.is_relative_to(root),
                "workspace пересекает source")
    keys(p["checks"], "tests style build")
    require(isinstance(p["checks"]["tests"], list) and p["checks"]["tests"], "нужен tests adapter")
    keys(p["stand"], "hasInterface frontendUrl apiUrl health entryInstructions")
    require(type(p["stand"]["hasInterface"]) is bool, "hasInterface должен быть boolean")
    require(isinstance(p["stand"]["entryInstructions"], str), "нужна инструкция входа")
    addresses = [stand_address(p["stand"][field]) for field in ["frontendUrl", "apiUrl"]
                 if p["stand"][field] is not None]
    if p["workspace"]["mode"] == "shared":
        require(len(addresses) == 2, "shared требует оба URL стенда")
        for repo in p["repositories"]:
            require(git(repo["source"], "branch", "--show-current") == repo["baseBranch"],
                    "shared должен быть открыт на объявленной baseBranch; переключает владелец")
    require(len({address.hostname for address in addresses}) <= 1, "у стенда должен быть один хост")
    groups = [(p["workspace"]["prepare"], "prepare"), (p["stand"]["health"], "health")]
    groups.extend((p["checks"][name], name) for name in ["tests", "style", "build"])
    for commands, kind in groups:
        require(isinstance(commands, list), "проверки должны быть массивами")
        for command in commands:
            fields = "repo argv timeoutSeconds"
            fields += " match" if kind == "tests" else " format" if kind == "style" else ""
            keys(command, fields)
            require(command["repo"] in names, "неизвестный repo в команде")
            argv(command["argv"])
            require(type(command["timeoutSeconds"]) is int and 1 <= command["timeoutSeconds"] <= 3600,
                    "timeoutSeconds должен быть 1..3600")
            if kind == "tests":
                relative(command["match"])
                require(command["argv"].count("{files}") == 1, "tests требует один {files}")
            if kind == "style":
                require(command["format"] == "jsonl", "style требует jsonl")
    require(strings(p["stack"]) and p["stack"], "нужен stack")
    require(strings(p["guardrails"]), "неверный guardrails")
    keys(p["permissions"], "allow deny")
    require(all(strings(value) for value in p["permissions"].values()), "неверные permissions")
    require(isinstance(p["volatilePaths"], list), "неверные volatilePaths")
    for item in p["volatilePaths"]:
        keys(item, "repo path")
        require(item["repo"] in names, "неизвестный volatile repo")
        relative(item["path"])
        repo = next(repo for repo in p["repositories"] if repo["name"] == item["repo"])
        require(not git(repo["source"], "ls-files", "--", item["path"]),
                "volatile путь содержит tracked код")
    keys(p["delivery"], "strategy remote pullRequestCommand")
    require(p["delivery"]["strategy"] in {"commit", "merge", "pull-request"}, "неверная сдача")
    require(isinstance(p["delivery"]["remote"], str) and re.fullmatch(ID, p["delivery"]["remote"]),
            "неверный remote")
    argv(p["delivery"]["pullRequestCommand"])
    keys(p["executors"], "author reviewer")
    for policy in p["executors"].values():
        keys(policy, "provider model effort failover")
        require(isinstance(policy["provider"], str) and re.fullmatch(ID, policy["provider"]),
                "неверный provider")
        require(all(isinstance(policy[field], str) and policy[field] for field in ["model", "effort"]),
                "нужны точная модель и effort")
        require(strings(policy["failover"]), "неверный failover")
    author, reviewer = (p["executors"][role] for role in ["author", "reviewer"])
    require((author["provider"], author["model"]) != (reviewer["provider"], reviewer["model"]),
            "скептику нужна другая модель; поставщик может совпадать")
    return p


def state_dir():
    default = str(Path.home() / ".factory/state")
    return Path(os.environ.get("STATE_DIR", os.environ.get("FACTORY_STATE", default)))


def task_id(task):
    require(isinstance(task, str) and re.fullmatch(r"[0-9]+", task), "неверный номер задачи")
    return task


def workspaces(p, task):
    """Вычисляет только принадлежащие задаче адреса, без создания каталогов.

    В shared возвращает source; isolated всегда лежит под объявленным root.
    """
    task_id(task)
    return {r["name"]: str(Path(r["source"]).resolve()) if p["workspace"]["mode"] == "shared"
            else str(Path(p["workspace"]["root"]) / p["id"] / task / r["name"])
            for r in p["repositories"]}


def atomic_json(file, value):
    """Публикует служебный снимок целиком, без промежуточных bytes для читателя.

    Файл расположен в состоянии задачи, продуктовые файлы не затрагиваются.
    """
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(file.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n")
    temporary.replace(file)


def main_error(error):
    print("project.json: " + str(error), file=sys.stderr)
    return 64
