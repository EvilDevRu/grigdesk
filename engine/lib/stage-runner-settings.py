"""Защищённая запись параметров узла; вызывается только управляющим контуром.

Метаданные собираются вне блокировок, commit повторно сверяет identity и CAS.
Профиль и неизменяемые документы попытки этот модуль никогда не переписывает.
"""

import hashlib
import json
import os
import re
import runpy
import stat
import subprocess
import sys
import tempfile
from pathlib import Path


def fail(message, code=75):
    print(message, file=sys.stderr)
    raise SystemExit(code)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


# Файл открывается без перехода по symlink и проверяется по тому же дескриптору.
# Hardlink и чужой владелец не могут стать источником управляющего решения.
def regular(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            fail("settings_corrupt: ожидался собственный обычный файл", 78)
        with os.fdopen(fd, encoding="utf-8") as source:
            fd = -1
            return source.read()
    finally:
        if fd >= 0:
            os.close(fd)


def read_json(path):
    return json.loads(regular(path))


# Ревизия включает сами файлы активного снимка, в том числе metadata с TTL.
# Отсутствие snapshot не подменяется seed: доступность доказывает callback раннера.
def catalog_fingerprint(provider):
    directory = Path(os.environ["STATE_DIR"]) / "runners/catalogs" / provider
    active = directory / "active"
    if not active.exists():
        return digest(None)
    revision = regular(active).strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]+", revision):
        fail("catalog_corrupt: неверная ревизия каталога", 78)
    files = {"active": revision}
    for name in ("meta.env", "models.tsv", "READY"):
        file = directory / "revisions" / revision / name
        files[name] = regular(file) if file.exists() else None
    return digest(files)


# Отсутствующая проекция означает отсутствие наблюдения, а не пустой запуск.
# Содержимое используется для факта только после проверки trusted process identity.
def env_file(path):
    try:
        return dict(line.split("=", 1) for line in regular(path).splitlines() if "=" in line)
    except FileNotFoundError:
        return {}


# Exact identity не нормализуется: недопустимый символ нельзя вычеркнуть из node.
# Проверка выполняется до построения путей и повторяется при каждом commit.
def identity_valid(value):
    patterns = {
        "task": r"[1-9][0-9]{0,18}",
        "profile": r"[a-z0-9][a-z0-9_-]{0,63}",
        "attempt": r"a_[a-f0-9]{32}",
        "node": r"[a-z0-9][a-z0-9_-]{0,40}",
        "stage": r"[A-Z][A-Z0-9_]{0,63}",
    }
    if not isinstance(value, dict) or set(value) != set(patterns):
        fail("settings_input: неверная identity", 2)
    for key, pattern in patterns.items():
        if not isinstance(value[key], str) or not re.fullmatch(pattern, value[key]):
            fail("settings_input: неверное поле identity " + key, 2)


# У каждого поля самостоятельное наследование; пустой effort отличается от null.
# Непрозрачный modelRef допускает JSON, но не управляющие символы и неограниченный размер.
def selection_valid(value):
    if not isinstance(value, dict) or set(value) != {"primary", "parametersFor", "model", "effort"}:
        fail("settings_input: неверная selection", 2)
    for key in ("primary", "parametersFor"):
        item = value[key]
        if key == "primary" and item is None:
            continue
        if not isinstance(item, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", item):
            fail("settings_input: неверный provider", 2)
    for key in ("model", "effort"):
        item = value[key]
        if item is not None and (not isinstance(item, str) or len(item) > 2048
                                 or any(ord(char) < 32 for char in item)):
            fail("settings_input: неверное поле " + key, 2)


# Клиент передаёт одну закрытую команду с целой связкой и CAS-ожиданиями.
# Лишние поля и неверные типы отвергаются до чтения или изменения настроек.
def payload_valid(value):
    keys = {
        "identity", "expectedRevision", "expectedRun", "catalogRevision", "requestId", "mode", "selection"
    }
    if not isinstance(value, dict) or set(value) != keys:
        fail("settings_input: неверные поля apply", 2)
    identity_valid(value["identity"])
    selection_valid(value["selection"])
    if type(value["expectedRevision"]) is not int or value["expectedRevision"] < 0:
        fail("settings_input: неверная revision", 2)
    if value["mode"] not in ("next", "restart"):
        fail("settings_input: неверный mode", 2)
    if not isinstance(value["catalogRevision"], str) or not value["catalogRevision"]:
        fail("settings_input: неверная catalogRevision", 2)
    request_id = value["requestId"]
    if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", request_id):
        fail("settings_input: неверный requestId", 2)
    run = value["expectedRun"]
    if run is not None and (not isinstance(run, dict) or set(run) != {"id", "epoch"}
                            or not isinstance(run["id"], str)
                            or not re.fullmatch(r"[A-Za-z0-9._-]+", run["id"])
                            or type(run["epoch"]) is not int or run["epoch"] < 1):
        fail("settings_input: неверный expectedRun", 2)


# Authority определяется активным указателем, проверенными immutable pins и бандлом.
# Совпадение stage в проекции само по себе не разрешает действие над другим node.
def context(root, identity):
    identity_valid(identity)
    task_root = root / "protocol-v2/tasks" / ("t" + identity["task"])
    if read_json(task_root / "active-attempt.json")["attemptId"] != identity["attempt"]:
        fail("identity_conflict: сменилась попытка")
    directory = task_root / "attempts" / identity["attempt"]
    for parent in (root, task_root, directory):
        if parent.is_symlink() or parent.resolve() != parent or parent.stat().st_uid != os.getuid():
            fail("settings_corrupt: недоверенный каталог", 78)
    document = regular(directory / "attempt.json")
    if hashlib.sha256(document.encode()).hexdigest() != regular(directory / "attempt.sha256").strip():
        fail("settings_corrupt: checksum попытки", 78)
    attempt = json.loads(document)
    if attempt["profile"] != identity["profile"] or str(attempt["taskId"]) != identity["task"]:
        fail("identity_conflict: другой профиль или задача")
    pins_raw = regular(directory / "pins.json")
    if hashlib.sha256(pins_raw.encode()).hexdigest() != regular(directory / "pins.sha256").strip():
        fail("settings_corrupt: checksum pins", 78)
    pins_document = json.loads(pins_raw)
    for key, expected in (("taskId", identity["task"]), ("attemptId", identity["attempt"]),
                          ("profile", identity["profile"]), ("catalogHash", attempt["catalogHash"])):
        if pins_document.get(key) != expected:
            fail("settings_corrupt: identity pins", 78)
    if list(directory.glob("terminal.*.json")):
        fail("identity_conflict: попытка завершена")
    pins = list(directory.glob("route-pin.*.json"))
    arguments = [str(Path(os.environ["FACTORY_HOME"]) / "bin/factory-route"),
                 "--routes-dir", attempt["routesDir"], "--profile", identity["profile"]]
    if pins:
        if len(pins) != 1:
            fail("settings_corrupt: несколько route pin", 78)
        raw = regular(pins[0])
        if hashlib.sha256(raw.encode()).hexdigest() != pins[0].name.split(".")[1]:
            fail("settings_corrupt: checksum route pin", 78)
        pin = json.loads(raw)
        arguments += ["describe-route", "--catalog-hash", attempt["catalogHash"], "--route", pin["routeId"]]
    else:
        arguments += ["describe-bootstrap", "--catalog-hash", attempt["catalogHash"]]
    route = json.loads(subprocess.check_output(arguments, text=True))
    nodes = [node for node in route["machine"]["nodes"] if node["id"] == identity["node"]]
    if not nodes and pins:
        # Выбранный основной маршрут не удаляет bootstrap из доверенной топологии.
        # Первый агент scout принадлежит каталогу даже после публикации route pin.
        bootstrap_args = arguments[:5] + ["describe-bootstrap", "--catalog-hash", attempt["catalogHash"]]
        bootstrap = json.loads(subprocess.check_output(bootstrap_args, text=True))
        nodes = [node for node in bootstrap["machine"]["nodes"] if node["id"] == identity["node"]]
    if len(nodes) != 1 or nodes[0].get("executor") != "agent" or nodes[0].get("runKey") != identity["stage"]:
        fail("identity_conflict: node не соответствует этапу")
    return directory, nodes[0]


# Отсутствие sidecar сохраняет профильную политику, повреждение не маскируется наследованием.
# Вся сохранённая связка читается одним обычным файлом с ограниченными правами.
def record_read(directory, identity):
    file = directory / "runner-settings" / (identity["node"] + ".json")
    if not file.exists() and not file.is_symlink():
        return None
    if file.parent.is_symlink() or file.parent.resolve() != file.parent:
        fail("settings_corrupt: недоверенный каталог настроек", 78)
    if stat.S_IMODE(file.lstat().st_mode) != 0o600 or stat.S_IMODE(file.parent.stat().st_mode) != 0o700:
        fail("settings_corrupt: права записи настроек", 78)
    record = read_json(file)
    if record.get("schema") != 1 or record.get("identity") != identity:
        fail("settings_corrupt: identity записи", 78)
    selection_valid(record.get("selection"))
    if type(record.get("revision")) is not int or record["revision"] < 1:
        fail("settings_corrupt: revision записи", 78)
    return record


# Единственная точка записи выполняет fsync файла и каталога после atomic replace.
# Ошибка до replace сохраняет прежние байты, временный файл всегда удаляется.
def durable_write(directory, identity, record):
    parent = directory / "runner-settings"
    parent.mkdir(mode=0o700, exist_ok=True)
    if parent.is_symlink() or parent.resolve() != parent or parent.stat().st_uid != os.getuid():
        fail("settings_corrupt: недоверенный каталог настроек", 78)
    os.chmod(parent, 0o700)
    fd, temporary = tempfile.mkstemp(prefix=".settings-", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            json.dump(record, target, ensure_ascii=False, separators=(",", ":"))
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, parent / (identity["node"] + ".json"))
        directory_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


# Живой факт подтверждается control identity, lifecycle binding и процессом из /proc.
# Диагностическая telemetry даёт только собственную пару уже установленного run.
def actual_read(root, identity):
    process = env_file(root / "runner-processes" / ("t" + identity["task"] + ".active"))
    active = env_file(root / "runs" / ("t" + identity["task"]) / (identity["stage"] + ".active"))
    if (process.get("STAGE") != identity["stage"] or active.get("STATE") != "active"
            or process.get("RUN_ID") != active.get("RUN_ID") or process.get("EPOCH") != active.get("EPOCH")):
        return None
    bound = os.environ.get("STAGE_SETTINGS_BOUND_RUN")
    if bound is not None and bound != active["RUN_ID"] + ":" + active["EPOCH"]:
        return None
    try:
        raw = Path("/proc", process["PID"], "stat").read_text().rsplit(")", 1)[1].split()
        if raw[19] != process["STARTTIME"] or raw[0] == "Z":
            return None
    except (KeyError, OSError):
        return None
    meta = env_file(Path(os.environ["STATE_DIR"]) / "logs/runs" / ("t" + identity["task"])
                    / identity["stage"] / active["RUN_ID"] / "meta.env")
    return {"run": {"id": active["RUN_ID"], "epoch": int(active["EPOCH"])},
            "provider": process.get("RUNNER"), "model": meta.get("MODEL"), "effort": meta.get("EFFORT")}


# Независимые null-поля накладываются на действующую policy выбранного исполнителя.
# Конфликт пары возвращает причину без смены модели, effort или провайдера.
def pair(selection, provider, model, effort, models):
    if selection["parametersFor"] == provider:
        model = selection["model"] if selection["model"] is not None else model
        effort = selection["effort"] if selection["effort"] is not None else effort
    entry = next((item for item in models if item["id"] == model or model in item.get("aliases", [])), None)
    if entry is None:
        fail("model_unavailable: модель недоступна: " + model)
    if effort not in entry["efforts"]:
        fail("effort_unavailable: уровень " + effort + " недоступен для модели " + model)
    return model, effort


# Shell держит pipeline/task locks для операций записи и собирает metadata вне них.
# Здесь повторно проверяются authority, revision и immutable intent перед каждой мутацией.
def main():
    operation, root_raw, identity_raw, *args = sys.argv[1:]
    root = Path(root_raw)
    identity = json.loads(identity_raw)
    if operation == "input":
        payload_valid(json.loads(args[0]))
        print(json.loads(args[0])["selection"]["parametersFor"])
        return
    if operation == "catalog":
        identity_valid(identity)
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", args[0]):
            fail("settings_input: неверный provider", 2)
        print(catalog_fingerprint(args[0]))
        return
    directory, node = context(root, identity)
    record = record_read(directory, identity)
    if operation == "policy":
        print(json.dumps(node))
        return
    if operation == "read":
        print(json.dumps(record))
        return
    if operation == "replay":
        payload = json.loads(args[0])
        payload_valid(payload)
        receipt = record.get("receipt") if record else None
        if not receipt or receipt.get("requestId") != payload["requestId"]:
            raise SystemExit(3)
        if receipt.get("payloadHash") != digest(payload):
            fail("request_conflict: другой payload с прежним requestId")
        return
    if operation == "view":
        (provider, primary, failover, source, model, effort, models_raw, fingerprint,
         inherited_primary, inherited_failover) = args
        inherited = {"primary": inherited_primary, "model": model, "effort": effort,
                     "chain": [inherited_primary] + [item for item in inherited_failover.split(",") if item]}
        models = json.loads(models_raw)["models"]
        selection = record["selection"] if record else {
            "primary": primary if source == "task-stage" else None,
            "parametersFor": primary, "model": None, "effort": None}
        if selection["parametersFor"] == provider:
            model = selection["model"] if selection["model"] is not None else model
            effort = selection["effort"] if selection["effort"] is not None else effort
        chain = [primary] + [item for item in failover.split(",") if item]
        if record and selection["primary"] is not None:
            chain = [selection["primary"]] + (record.get("failover") or [])
        elif record:
            chain = inherited["chain"]
        sources = {"primary": "node" if selection["primary"] else source,
                   "model": "node" if selection["model"] is not None else "profile",
                   "effort": "node" if selection["effort"] is not None else "profile"}
        value = {"schema": 1, "identity": identity, "revision": record["revision"] if record else 0,
                 "selection": selection, "sources": sources,
                 "effective": {"primary": chain[0], "model": model, "effort": effort}, "chain": chain,
                 "models": models,
                 "catalogRevision": digest([provider, models, fingerprint, catalog_fingerprint(provider)]),
                 "actual": actual_read(root, identity), "receipt": record.get("receipt") if record else None,
                 "inherited": inherited}
        pending = record.get("pending") if record else None
        if pending and pending.get("state") == "pending":
            active = env_file(root / "runs" / ("t" + identity["task"]) / (identity["stage"] + ".active"))
            if (active.get("STATE") != "active" or active.get("RUN_ID") != pending["source"]["id"]
                    or active.get("EPOCH") != str(pending["source"]["epoch"])):
                value["receipt"] = dict(value["receipt"], state="stale", reason="Исходный запуск уже завершён.")
        print(json.dumps(value))
        return
    if operation == "apply":
        payload, preview = map(json.loads, args[:2])
        payload_valid(payload)
        if payload["identity"] != identity:
            fail("identity_conflict: запрос относится к другому узлу")
        revision = record["revision"] if record else 0
        receipt = record.get("receipt") if record else None
        payload_hash = digest(payload)
        if receipt and receipt["requestId"] == payload["requestId"]:
            if receipt["payloadHash"] != payload_hash:
                fail("request_conflict: другой payload с прежним requestId")
            preview.update(selection=record["selection"], revision=revision, receipt=receipt)
            print(json.dumps(preview))
            return
        if revision != payload["expectedRevision"] or revision != preview["revision"]:
            fail("revision_conflict: настройки уже изменены")
        if hashlib.sha256(regular(Path(args[4])).encode()).hexdigest() != args[5]:
            fail("catalog_stale: политика модели изменилась во время проверки")
        if catalog_fingerprint(args[6]) != args[7]:
            fail("catalog_stale: снимок каталога изменился во время проверки")
        actual = actual_read(root, identity)
        if payload["expectedRun"] != (actual["run"] if actual else None):
            fail("identity_conflict: сменилась выполняющаяся попытка")
        selection = payload["selection"]
        primary = selection["primary"] or preview["inherited"]["primary"]
        if primary != selection["parametersFor"]:
            fail("provider_conflict: parametersFor не соответствует исполнителю")
        if payload["catalogRevision"] != preview["catalogRevision"]:
            fail("catalog_stale: каталог моделей или политика изменились")
        model, effort = pair(selection, primary, args[2], args[3], preview["models"])
        if payload["mode"] == "restart" and actual is None:
            fail("identity_conflict: нет живой попытки для restart")
        legacy = env_file(root / "requests" / ("t" + identity["task"]) / (identity["stage"] + ".switch"))
        pending_state = (record.get("pending") or {}).get("state") if record else None
        if legacy.get("STATE") == "pending" or pending_state == "pending":
            fail("restart_pending: другое переключение ещё ожидает")
        if selection["primary"] is None:
            failover = preview["inherited"]["chain"][1:]
        else:
            failover = preview["chain"][1:] if primary == preview["chain"][0] else []
        receipt = {"requestId": payload["requestId"], "payloadHash": payload_hash,
                   "state": "pending" if payload["mode"] == "restart" else "saved", "reason": ""}
        value = {"schema": 1, "identity": identity, "revision": revision + 1, "selection": selection,
                 "failover": failover if selection["primary"] is not None else None, "receipt": receipt}
        if payload["mode"] == "restart":
            value["pending"] = {
                "state": "pending",
                "source": actual["run"],
                "requestId": payload["requestId"],
                "revision": revision + 1,
                "selection": selection,
                "effective": {
                    "primary": primary,
                    "model": model,
                    "effort": effort,
                },
                "chain": [primary] + failover,
            }
            value["pending"]["hash"] = digest(value["pending"])
            details = {"requestId": payload["requestId"], "sourceRunId": actual["run"]["id"],
                       "sourceEpoch": actual["run"]["epoch"], "targetProvider": primary,
                       "requestRecordSha256": value["pending"]["hash"]}
            analytics = runpy.run_path(str(Path(os.environ["FACTORY_HOME"]) / "lib/runtime-analytics.py"))
            key = (actual["run"]["id"] + ":" + str(actual["run"]["epoch"]) + ":switch:"
                   + payload["requestId"] + ":runner_switch_requested")
            value["pending"]["eventDraft"] = analytics["event_draft"](
                "runner_switch_requested", json.dumps(details), key, "-")
            value["pending"]["eventPublished"] = False
        durable_write(directory, identity, value)
        preview.update(selection=selection, revision=revision + 1, receipt=receipt,
                       effective={"primary": primary, "model": model, "effort": effort},
                       chain=[primary] + failover,
                       sources={
                           "primary": "node" if selection["primary"] is not None else "profile",
                           "model": "node" if selection["model"] is not None else "profile",
                           "effort": "node" if selection["effort"] is not None else "profile",
                       })
        print(json.dumps(preview))
        return
    if operation == "receipt":
        request, state, reason, *expected_states = args
        if record and record.get("receipt", {}).get("requestId") == request:
            if expected_states and record["receipt"]["state"] not in expected_states:
                return
            record["receipt"].update(state=state, reason=reason)
            if state == "failed" and record.get("pending"):
                record["pending"]["state"] = "failed"
            durable_write(directory, identity, record)
        return
    if operation == "consume":
        run, epoch = args
        pending = record.get("pending") if record else None
        if (not pending or pending.get("state") != "pending" or not pending.get("eventPublished")
                or pending["source"] != {"id": run, "epoch": int(epoch)}):
            raise SystemExit(3)
        frozen = {key: value for key, value in pending.items()
                  if key not in ("hash", "eventDraft", "eventPublished")}
        if digest(frozen) != pending["hash"] or pending["revision"] != record["revision"]:
            fail("restart_corrupt: изменён intent", 78)
        active = env_file(root / "runs" / ("t" + identity["task"]) / (identity["stage"] + ".active"))
        if (active.get("RUN_ID") != run or active.get("EPOCH") != epoch
                or active.get("STATE") != "active"):
            fail("restart_stale: исходный запуск уже сменился", 75)
        pending["state"] = "consumed"
        record["receipt"]["state"] = "consumed"
        durable_write(directory, identity, record)
        print(json.dumps(pending))
        return
    if operation == "published":
        if record and record.get("receipt", {}).get("requestId") == args[0] and record.get("pending"):
            record["pending"]["eventPublished"] = True
            durable_write(directory, identity, record)
        return
    if operation == "pending":
        if record and (record.get("pending") or {}).get("state") == "pending":
            fail("restart_pending: ожидает применение настроек этапа", 76)
        return
    fail("settings_input: неизвестная операция", 2)


try:
    main()
except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
    fail("settings_unavailable: " + str(error), 1)
