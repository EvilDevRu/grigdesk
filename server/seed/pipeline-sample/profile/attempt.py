"""Общие границы точной попытки и доверенных снимков профильных проверок."""

import hashlib
import json
import os
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
from project import atomic_json, inside, require, state_dir, task_id, workspaces


def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def read_context(file, task, project, readonly=False):
    """Сверяет идентичность задачи и репозитории до любого действия.

    Адрес рабочего дерева берётся из контекста, но обязан совпасть с описанием.
    """
    value = json.loads(Path(file).read_text())
    require(str(value["task"]["id"]) == task_id(task), "контекст другой задачи")
    require(re.fullmatch(r"a_[a-f0-9]{32}", value["attempt"]["id"]), "неверная попытка")
    require(value["project"]["profile"] == project["id"], "контекст другого профиля")
    roots = workspaces(project, task)
    require(set(value["workspace"]["repos"]) == set(roots), "неверный набор репозиториев")
    for name, root in roots.items():
        actual = Path(value["workspace"][name]["path"]).resolve()
        declared = next(repo for repo in project["repositories"] if repo["name"] == name)
        allowed = {Path(root).resolve()}
        if readonly:
            allowed.add(Path(declared["source"]).resolve())
        require(actual in allowed,
                "контекст другой рабочей копии")
    return value, roots


def identity(context):
    return {
        "taskId": str(context["task"]["id"]),
        "attemptId": context["attempt"]["id"],
        "profile": context["project"]["profile"],
    }


def artifact(context, name):
    """Использует только каталог текущей доверенной попытки, заданный хостом.

    Provider-writable отчёты не служат источником закреплённого снимка.
    """
    root = os.environ.get("ROUTE_V2_ATTEMPT_DIR")
    require(root and Path(root).is_absolute(), "нет каталога доверенной попытки")
    root = Path(root)
    require(root.name == context["attempt"]["id"], "каталог другой попытки")
    return root / "artifacts" / name


def read_snapshot(context, name):
    """Отвергает снимок иной попытки даже при совпадающих адресах репозиториев.

    Отсутствие файла возвращается явно, повреждённый снимок не считается отсутствующим.
    """
    file = artifact(context, name)
    if not file.exists():
        return None

    value = json.loads(file.read_text())
    require(value["identity"] == identity(context), "снимок другой попытки")
    return value


def save_snapshot(context, name, **fields):
    """Публикует хостовый снимок атомарно вместе с exact identity.

    Read-only bytes исключают случайную запись обычного помощника поверх pin.
    """
    file = artifact(context, name)
    atomic_json(file, {"identity": identity(context), **fields})
    file.chmod(0o400)


def bases(context, roots):
    """Первое доказательство закрепляет исходную ревизию из workspace lifecycle.

    Следующие проверки не выбирают новую базу из изменившейся рабочей ветки.
    """
    saved = read_snapshot(context, "sample-base.json")
    if saved is None:
        task = str(context["task"]["id"])
        value = json.loads((state_dir() / f"t{task}.workspace.json").read_text())
        require(value["taskId"] == task and value["profile"] == context["project"]["profile"],
                "чужой снимок workspace")
        require(value["roots"] == roots, "workspace изменился")
        require(set(value["bases"]) == set(roots), "нет исходной ревизии")
        save_snapshot(context, "sample-base.json", roots=roots, bases=value["bases"])
        return value["bases"]

    require(saved["roots"] == roots, "адреса закреплённой копии изменились")
    return saved["bases"]


def named_file(roots, name):
    """Разрешает repo:relative только внутри объявленных рабочих деревьев.

    Символическая ссылка не может вывести чтение или stage за пределы repo.
    """
    repo, separator, relative = name.partition(":")
    require(separator and repo in roots, "неизвестный repo или путь")
    file = inside(roots[repo], relative)
    require(not (Path(roots[repo]) / relative).is_symlink(), "ссылка вместо обычного файла")
    return repo, relative, file
