"""Проекции декларации на фиксированные shell hooks движка."""

import hashlib
import json
import shlex
import sys

sys.dont_write_bytecode = True
from project import PROFILE, git, load, main_error, stand_address, workspaces


def project_context(p):
    """Оставляет typed project в закрытой форме stack/guardrails.

    Адреса описания, правил и обёртки передаются как обязательные правила работы.
    """
    rules = p["guardrails"] + [f"Описание проекта: {PROFILE / 'project.json'}",
                               f"Проверки: {PROFILE / 'checks.py'}; только явные файлы"]
    rules += [f"Правила продукта {r['name']}: {r['productRules']}" for r in p["repositories"]]
    return {
        "stack": p["stack"],
        "guardrails": rules,
    }


def container(p, task):
    """Одинаковые URL дают один ключ аренды даже у разных профилей.

    Режим без стенда использует явную метку задачи, не имя выдуманного сервиса.
    """
    if p["workspace"]["mode"] == "isolated":
        return f"no-stand-{p['id']}-{task}"
    urls = [p["stand"][field] for field in ["frontendUrl", "apiUrl"]]
    return "stand-" + hashlib.sha256(json.dumps(urls).encode()).hexdigest()[:24]


def dispatch(p, name, args):
    """Возвращает фиксированную проекцию; команды из описания здесь не запускаются.

    Неизвестное имя hook является ошибкой вместо динамического исполнения текста.
    """
    task = args[0] if args else "0"
    mode = p["workspace"]["mode"]
    if name == "metadata":
        values = [p["id"], json.dumps(project_context(p), ensure_ascii=False),
                  p["repositories"][0]["source"],
                  stand_address(p["stand"]["frontendUrl"]).hostname if mode == "shared" else "127.0.0.1",
                  " ".join(r["name"] + ":" + r["source"] for r in p["repositories"]),
                  " ".join(r["name"] + ":" + r["productRules"] for r in p["repositories"])]
        print("\n".join(values))
    elif name == "workspace_mode":
        print(mode)
    elif name == "stand_mode":
        print("none" if mode == "isolated" else "services")
    elif name == "project_context":
        print(json.dumps(project_context(p), ensure_ascii=False))
    elif name == "repositories":
        roots = workspaces(p, task)
        for repo in p["repositories"]:
            print("\t".join([repo["name"], repo["source"], roots[repo["name"]]]))
    elif name == "source_branch":
        repo = next(r for r in p["repositories"] if r["name"] == args[1])
        print(git(repo["source"], "branch", "--show-current") if mode == "shared" else "task-" + task)
    elif name == "container":
        print(container(p, task))
    elif name == "service_ports":
        print("\t".join(str(stand_address(p["stand"][key]).port) for key in ["frontendUrl", "apiUrl"]))
    elif name == "exclusive_resources":
        print("stand:" + container(p, task))
        for root in workspaces(p, task).values():
            print("workspace:" + root)
    elif name == "delivery_strategy":
        print(p["delivery"]["strategy"])
    elif name == "delivery_targets":
        for repo in p["repositories"]:
            print(repo["name"] + "\t" + repo["targetBranch"])
    elif name in {"allow", "deny"}:
        print("\n".join(p["permissions"][name]))
    elif name == "stage_agent_allow":
        for file in ["checks.py", "status.sh"] + (["deliver.py"] if args[0] == "SHIP" else []):
            print(f"Bash(*{PROFILE / file}:*)")
    elif name == "volatile_paths":
        for item in p["volatilePaths"]:
            print(item["repo"] + "\t" + item["path"])
    else:
        raise ValueError("неизвестный hook: " + name)


if __name__ == "__main__":
    try:
        dispatch(load(), sys.argv[1], sys.argv[2:])
    except (ValueError, OSError, RuntimeError, KeyError, IndexError) as error:
        sys.exit(main_error(error))
