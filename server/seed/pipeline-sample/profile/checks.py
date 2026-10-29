"""Явная обёртка проверок проекта: команды и файлы задаются декларацией."""

import argparse
import sys

sys.dont_write_bytecode = True
from project import adapter, inside, load, main_error, matches, workspaces


def check(kind, task, files):
    """Выполняет только выбранную группу проверок в копии задачи.

    Тестовый адаптер получает только файлы своего match; пустой охват не запускается.
    """
    p = load()
    roots = workspaces(p, task)
    commands = p["stand"]["health"] if kind == "health" else p["checks"][kind]
    result = 0
    for command in commands:
        root = roots[command["repo"]]
        selected = [str(inside(root, file)) for file in files
                    if kind != "tests" or matches(file, command["match"])]

        if kind == "tests" and not selected:
            continue

        completed = adapter(command, root, selected)
        sys.stdout.write(completed.stdout)
        sys.stderr.write(completed.stderr)
        result = result or completed.returncode
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=["tests", "style", "build", "health"])
    parser.add_argument("task")
    parser.add_argument("files", nargs="*")
    args = parser.parse_args()
    try:
        sys.exit(check(args.kind, args.task, args.files))
    except (ValueError, OSError, RuntimeError) as error:
        sys.exit(main_error(error))
