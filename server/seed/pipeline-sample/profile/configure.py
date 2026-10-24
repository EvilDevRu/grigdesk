"""Ручная настройка уже скопированного профиля через canonical CLI."""

import argparse
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
from project import PROFILE, execute, load, main_error, require


def configure(factory):
    """Проверяет весь ввод до первой записи и использует штатный writer runner policy.

    Публикация маршрутов и включение capability остаются отдельными действиями человека.
    """
    p = load()
    require(Path(factory).is_absolute() and Path(factory).is_file(), "нужен абсолютный factory CLI")
    author = p["executors"]["author"]
    execute([factory, "profile", p["id"], "runner", "set", author["provider"],
             "--failover", ",".join(author["failover"])], PROFILE)
    defaults = set()
    for policy in p["executors"].values():
        if policy["provider"] in defaults:
            continue

        execute([factory, "profile", p["id"], "model", "set", "DEFAULT", policy["provider"],
                 "exact=" + policy["model"], "effort=" + policy["effort"]], PROFILE)
        defaults.add(policy["provider"])
    roles = {"author": ["PLAN", "BUILD", "TESTS", "REPRO", "DIAGNOSE"],
             "reviewer": ["SKEPTIC", "REVIEW", "BROWSER", "AUDIT", "SHIP"]}
    for role, stages in roles.items():
        policy = p["executors"][role]
        for stage in stages:
            execute([factory, "profile", p["id"], "runner", "set", stage, policy["provider"],
                     "--failover", ",".join(policy["failover"])], PROFILE)
            execute([factory, "profile", p["id"], "model", "set", stage, policy["provider"],
                     "exact=" + policy["model"], "effort=" + policy["effort"]], PROFILE)
    (PROFILE / "dashboard.env").write_text("# Создано configure из project.json\n" +
                                           "PROJECT_NAME=" + p["id"] + "\n")
    if p["workspace"]["mode"] == "isolated" and p["stand"]["hasInterface"]:
        print("Интерфейс без стенда: приёмка остановится у человека; выберите shared.", file=sys.stderr)
    print("Профиль настроен; маршруты публикуются и включаются отдельно.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--factory", required=True)
    args = parser.parse_args()
    try:
        configure(args.factory)
    except (ValueError, OSError, RuntimeError) as error:
        sys.exit(main_error(error))
