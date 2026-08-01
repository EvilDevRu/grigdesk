#!/usr/bin/env bash
# Trusted execution cursor for a pinned route-v2 attempt.
#
# Public API:
#   attempt_stage_state_init_v2 TASK ATTEMPT_ID ROUTE_ID
#   attempt_stage_state_read_v2 TASK ATTEMPT_ID
#   attempt_stage_state_pause_v2 TASK ATTEMPT_ID NODE REASON
#   attempt_stage_state_commit_v2 TASK ATTEMPT_ID NODE OUTCOME
#
# The mutable cursor and its append-only, hash-chained event ledger live only in
# <control-root>/protocol-v2/tasks/t<TASK>/attempts/<ATTEMPT>/stage-results.
# This module deliberately never opens or writes legacy STATE_DIR/t*.pipeline files.
#
# Return codes follow attempt-state.sh:
#   2  invalid caller input
#   73 execution cursor has not been initialized
#   75 stale active-attempt/current-node/state CAS
#   78 corrupt state, bundle, transition, or unsafe filesystem object

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/attempt-state.sh"

_attempt_stage_state_node_id() {
  _attempt_state_route_id "${1:-}"
}

_attempt_stage_state_outcome() {
  _attempt_state_route_id "${1:-}"
}

_attempt_stage_state_now() {
  local value
  if [[ -n "${ATTEMPT_STAGE_STATE_TIME_OVERRIDE:-}" ]]; then
    [[ "${FACTORY_TESTING:-0}" == 1 ]] || return 2
    value=$ATTEMPT_STAGE_STATE_TIME_OVERRIDE
  else
    value=$(date -u +%Y-%m-%dT%H:%M:%SZ) || return 1
  fi
  [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    return 2
  printf '%s\n' "$value"
}

_attempt_stage_state_json() {
  local operation=${1:?operation}
  shift
  python3 - "$operation" "$@" <<'PY'
import datetime
import hashlib
import json
import os
import re
import stat
import sys

OP, *ARGS = sys.argv[1:]
ATTEMPT_RE = re.compile(r"^a_[a-f0-9]{32}$")
HASH_RE = re.compile(r"^[a-f0-9]{64}$")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")
PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
TASK_RE = re.compile(r"^[1-9][0-9]{0,18}$")
TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
EVENT_RE = re.compile(r"^event\.([0-9]{20})\.([a-f0-9]{64})\.json$")
STOP_TARGETS = {"human", "failed", "done"}


def fail(code=78):
    raise SystemExit(code)


def exact(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        fail()


def identifier(value, regexp=ID_RE):
    if not isinstance(value, str) or not regexp.fullmatch(value):
        fail()
    return value


def integer(value, minimum=0):
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        fail()
    return value


def timestamp(value):
    if not isinstance(value, str) or not TIME_RE.fullmatch(value):
        fail()
    try:
        datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        fail()
    return value


def reason(value):
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 500
        or any(ord(char) < 32 or ord(char) == 127 for char in value)
    ):
        fail()
    return value


def canonical_bytes(value):
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")


def digest_value(value):
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def dump(value):
    json.dump(value, sys.stdout, ensure_ascii=False, sort_keys=True, indent=2)
    sys.stdout.write("\n")


def regular_json(path, immutable=True):
    try:
        info = os.lstat(path)
    except OSError:
        fail()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        fail()
    if immutable and (stat.S_IMODE(info.st_mode) != 0o400 or info.st_nlink != 1):
        fail()
    try:
        with open(path, encoding="utf-8") as source:
            return json.load(source, parse_constant=lambda _: fail())
    except (OSError, UnicodeError, json.JSONDecodeError):
        fail()


def validate_static(
    value,
    task,
    attempt,
    profile,
    catalog,
    route,
    route_hash,
):
    if (
        value.get("schema") != 1
        or value.get("protocolVersion") != 2
        or value.get("taskId") != task
        or value.get("attemptId") != attempt
        or value.get("profile") != profile
        or value.get("catalogHash") != catalog
        or value.get("route") != route
        or value.get("routeHash") != route_hash
    ):
        fail()


def validate_last_commit(value, maximum):
    if value is None:
        return None
    exact(value, {"node", "outcome", "sequence"})
    identifier(value["node"])
    identifier(value["outcome"])
    sequence = integer(value["sequence"], 1)
    if sequence > maximum:
        fail()
    return value


def validate_cursor(value, maximum):
    exact(value, {"state", "currentNode", "stop", "pauseReason", "lastCommit"})
    state_value = value["state"]
    if state_value not in {"ready", "paused", "stopped"}:
        fail()
    validate_last_commit(value["lastCommit"], maximum)
    if state_value == "ready":
        identifier(value["currentNode"])
        if value["stop"] is not None or value["pauseReason"] is not None:
            fail()
    elif state_value == "paused":
        identifier(value["currentNode"])
        if value["stop"] is not None:
            fail()
        reason(value["pauseReason"])
    else:
        if value["currentNode"] is not None or value["pauseReason"] is not None:
            fail()
        if value["stop"] not in STOP_TARGETS:
            fail()
    return value


def validate_action(value):
    if not isinstance(value, dict):
        fail()
    modes = set(value) & {"next", "rewind", "stop", "escalate"}
    if len(modes) != 1:
        fail()
    mode = next(iter(modes))
    if mode == "next":
        exact(value, {"next"})
        identifier(value["next"])
    elif mode == "rewind":
        exact(value, {"rewind", "reset"})
        identifier(value["rewind"])
        reset = value["reset"]
        if (
            not isinstance(reset, list)
            or not reset
            or len(reset) != len(set(reset))
        ):
            fail()
        for item in reset:
            identifier(item)
        if reset[0] != value["rewind"]:
            fail()
    elif mode == "stop":
        exact(value, {"stop"})
        if value["stop"] not in STOP_TARGETS:
            fail()
    else:
        # A selected route is immutable for the lifetime of the attempt. Route
        # escalation needs a separate, explicit attempt/route selection protocol.
        fail()
    return mode


def derive_commit_cursor(before, action, node, outcome, sequence):
    mode = validate_action(action)
    last = {"node": node, "outcome": outcome, "sequence": sequence}
    if mode == "next":
        return {
            "state": "ready",
            "currentNode": action["next"],
            "stop": None,
            "pauseReason": None,
            "lastCommit": last,
        }
    if mode == "rewind":
        return {
            "state": "ready",
            "currentNode": action["rewind"],
            "stop": None,
            "pauseReason": None,
            "lastCommit": last,
        }
    return {
        "state": "stopped",
        "currentNode": None,
        "stop": action["stop"],
        "pauseReason": None,
        "lastCommit": last,
    }


def human_rewind_note(directory, node):
    # Указание, оставленное человеком при возврате курсора на узел. Живёт в журнале
    # попытки событием human-rewind и обязано доехать до промпта того захода, ради
    # которого узел и вернули: иначе человек жмёт «перейти сюда», агент входит с тем
    # же заданием, что и в прошлый раз, и повторяет ту же ошибку.
    # Снимается ПЕРВЫМ ЖЕ коммитом узла: указание отработано, и подсовывать его
    # следующему заходу — врать ему о том, зачем он здесь. Возврат туда же второй раз
    # кладёт новое событие со своей причиной, поэтому «последнее слово» всегда свежее.
    # reason() строгая: события пишутся через ту же валидацию, поэтому непроходной
    # текст здесь означает порчу журнала, а её нельзя проглатывать молча.
    identifier(node)
    try:
        names = os.listdir(directory)
    except OSError:
        fail()
    events = []
    for name in names:
        match = EVENT_RE.fullmatch(name)
        if match:
            events.append((int(match.group(1)), name))
    events.sort()
    note = ""
    for _, name in events:
        event = regular_json(os.path.join(directory, name))
        if not isinstance(event, dict) or event.get("node") != node:
            continue
        if event.get("kind") == "human-rewind":
            note = reason(event.get("reason"))
        elif event.get("kind") == "commit":
            note = ""
    return note


def validate_event_static(
    event,
    task,
    attempt,
    profile,
    catalog,
    route,
    route_hash,
):
    exact(
        event,
        {
            "schema",
            "protocolVersion",
            "taskId",
            "attemptId",
            "profile",
            "catalogHash",
            "route",
            "routeHash",
            "sequence",
            "at",
            "kind",
            "node",
            "outcome",
            "reason",
            "action",
            "previousEventHash",
            "before",
            "after",
        },
    )
    validate_static(
        event,
        task,
        attempt,
        profile,
        catalog,
        route,
        route_hash,
    )
    integer(event["sequence"])
    timestamp(event["at"])
    identifier(event["node"])
    if event["kind"] not in {"init", "pause", "commit", "human-rewind"}:
        fail()


def validate_runtime(
    runtime,
    task,
    attempt,
    profile,
    catalog,
    route,
    route_hash,
    entry,
):
    exact(
        runtime,
        {
            "schema",
            "protocolVersion",
            "taskId",
            "attemptId",
            "profile",
            "catalogHash",
            "route",
            "routeHash",
            "entry",
            "sequence",
            "headEventHash",
            "cursor",
        },
    )
    validate_static(
        runtime,
        task,
        attempt,
        profile,
        catalog,
        route,
        route_hash,
    )
    if runtime["entry"] != entry:
        fail()
    integer(runtime["sequence"])
    identifier(runtime["headEventHash"], HASH_RE)
    validate_cursor(runtime["cursor"], runtime["sequence"])
    return runtime


def event_base(runtime, sequence, at, kind, node):
    return {
        "schema": 1,
        "protocolVersion": 2,
        "taskId": runtime["taskId"],
        "attemptId": runtime["attemptId"],
        "profile": runtime["profile"],
        "catalogHash": runtime["catalogHash"],
        "route": runtime["route"],
        "routeHash": runtime["routeHash"],
        "sequence": sequence,
        "at": timestamp(at),
        "kind": kind,
        "node": identifier(node),
        "previousEventHash": runtime["headEventHash"],
    }


def validate_transition(value, runtime, node, outcome):
    exact(
        value,
        {
            "schema",
            "catalogHash",
            "route",
            "routeHash",
            "node",
            "outcome",
            "action",
            "retry",
            "escalationPolicy",
        },
    )
    if (
        value["schema"] != 2
        or value["catalogHash"] != runtime["catalogHash"]
        or value["route"] != runtime["route"]
        or value["routeHash"] != runtime["routeHash"]
        or value["node"] != node
        or value["outcome"] != outcome
        or value["escalationPolicy"] is not None
    ):
        fail()
    validate_action(value["action"])
    return value["action"]


if OP == "parse-description":
    path, profile, catalog, route, route_hash = ARGS
    value = regular_json(path, immutable=False)
    exact(
        value,
        {"schema", "profile", "catalogHash", "route", "routeHash", "machine"},
    )
    if (
        value["schema"] != 2
        or value["profile"] != profile
        or value["catalogHash"] != catalog
        or value["route"] != route
        or value["routeHash"] != route_hash
    ):
        fail()
    machine = value["machine"]
    if not isinstance(machine, dict):
        fail()
    sys.stdout.write(identifier(machine.get("entry")) + "\n")

elif OP == "assert-empty":
    (directory,) = ARGS
    try:
        info = os.lstat(directory)
        entries = os.listdir(directory)
    except OSError:
        fail()
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or stat.S_IMODE(info.st_mode) != 0o700
        or entries
    ):
        fail()

elif OP == "make-init":
    task, attempt, profile, catalog, route, route_hash, entry, at = ARGS
    identifier(task, TASK_RE)
    identifier(attempt, ATTEMPT_RE)
    identifier(profile, PROFILE_RE)
    identifier(catalog, HASH_RE)
    identifier(route)
    identifier(route_hash, HASH_RE)
    identifier(entry)
    cursor = {
        "state": "ready",
        "currentNode": entry,
        "stop": None,
        "pauseReason": None,
        "lastCommit": None,
    }
    dump(
        {
            "schema": 1,
            "protocolVersion": 2,
            "taskId": task,
            "attemptId": attempt,
            "profile": profile,
            "catalogHash": catalog,
            "route": route,
            "routeHash": route_hash,
            "sequence": 0,
            "at": timestamp(at),
            "kind": "init",
            "node": entry,
            "outcome": None,
            "reason": None,
            "action": {"next": entry},
            "previousEventHash": None,
            "before": None,
            "after": cursor,
        }
    )

elif OP == "runtime-from-event":
    event_path, event_hash, entry = ARGS
    event = regular_json(event_path)
    identifier(event_hash, HASH_RE)
    if hashlib.sha256(open(event_path, "rb").read()).hexdigest() != event_hash:
        fail()
    dump(
        {
            "schema": event["schema"],
            "protocolVersion": event["protocolVersion"],
            "taskId": event["taskId"],
            "attemptId": event["attemptId"],
            "profile": event["profile"],
            "catalogHash": event["catalogHash"],
            "route": event["route"],
            "routeHash": event["routeHash"],
            "entry": identifier(entry),
            "sequence": event["sequence"],
            "headEventHash": event_hash,
            "cursor": event["after"],
        }
    )

elif OP == "make-envelope":
    (runtime_path,) = ARGS
    runtime = regular_json(runtime_path)
    dump({"checksum": digest_value(runtime), "runtime": runtime})

elif OP == "prepare-pause":
    runtime_path, node, pause_reason, at = ARGS
    runtime = regular_json(runtime_path)
    cursor = runtime.get("cursor")
    if not isinstance(cursor, dict):
        fail()
    identifier(node)
    reason(pause_reason)
    if (
        cursor.get("state") == "paused"
        and cursor.get("currentNode") == node
        and cursor.get("pauseReason") == pause_reason
    ):
        fail(10)
    if cursor.get("state") != "ready" or cursor.get("currentNode") != node:
        fail(75)
    sequence = integer(runtime.get("sequence")) + 1
    event = event_base(runtime, sequence, at, "pause", node)
    event.update(
        {
            "outcome": None,
            "reason": pause_reason,
            "action": None,
            "before": cursor,
            "after": {
                "state": "paused",
                "currentNode": node,
                "stop": None,
                "pauseReason": pause_reason,
                "lastCommit": cursor.get("lastCommit"),
            },
        }
    )
    dump(event)

elif OP == "prepare-human-rewind":
    runtime_path, node, reset_csv, rewind_reason, at = ARGS
    runtime = regular_json(runtime_path)
    cursor = runtime.get("cursor")
    if not isinstance(cursor, dict):
        fail()
    identifier(node)
    reason(rewind_reason)
    reset = [item for item in reset_csv.split(",") if item]
    if not reset or len(reset) != len(set(reset)) or reset[0] != node:
        fail()
    for item in reset:
        identifier(item)
    # Остановка `stop: human` буквально означает «маршрут ждёт решения человека»,
    # и возврат курсора — законное решение (провайдер лежал, узел исчерпал бюджет).
    # Терминальные done/failed закрывают попытку: их разбирают abandon/recover.
    if cursor.get("state") == "stopped" and cursor.get("stop") != "human":
        fail(75)
    if cursor.get("currentNode") == node and cursor.get("state") == "ready":
        fail(10)
    sequence = integer(runtime.get("sequence")) + 1
    event = event_base(runtime, sequence, at, "human-rewind", node)
    event.update(
        {
            "outcome": None,
            "reason": rewind_reason,
            "action": {"rewind": node, "reset": reset},
            "before": cursor,
            "after": {
                "state": "ready",
                "currentNode": node,
                "stop": None,
                "pauseReason": None,
                "lastCommit": cursor.get("lastCommit"),
            },
        }
    )
    dump(event)

elif OP == "prepare-commit":
    runtime_path, transition_path, results_dir, node, outcome, at = ARGS
    runtime = regular_json(runtime_path)
    cursor = runtime.get("cursor")
    if not isinstance(cursor, dict):
        fail()
    identifier(node)
    identifier(outcome)
    last = cursor.get("lastCommit")
    # Идемпотентность существует ради ОДНОГО случая: коммит лёг в журнал, процесс умер
    # до того, как увидел успех, и повтор не должен класть второе событие. Возврат
    # курсора человеком — не этот случай: человек вернул узел ЗНАЯ его прошлый исход и
    # прося переиграть, поэтому «тот же исход» здесь законен и обязан лечь событием.
    # Иначе курсор не двигается, а диспетчер видит тот же узел готовым и гоняет по нему
    # агента до потолка шагов — деньгами и часами за отказ записать один факт.
    # После нового коммита узла возврат перестаёт считаться свежим, и повтор упавшего
    # процесса снова гасится идемпотентностью — ровно как задумано.
    if (
        isinstance(last, dict)
        and last.get("node") == node
        and last.get("outcome") == outcome
        and not human_rewind_note(results_dir, node)
    ):
        fail(10)
    if cursor.get("state") not in {"ready", "paused"} or cursor.get("currentNode") != node:
        fail(75)
    transition = regular_json(transition_path, immutable=False)
    action = validate_transition(transition, runtime, node, outcome)
    sequence = integer(runtime.get("sequence")) + 1
    event = event_base(runtime, sequence, at, "commit", node)
    event.update(
        {
            "outcome": outcome,
            "reason": None,
            "action": action,
            "before": cursor,
            "after": derive_commit_cursor(
                cursor,
                action,
                node,
                outcome,
                sequence,
            ),
        }
    )
    dump(event)

elif OP == "event-sequence":
    (event_path,) = ARGS
    event = regular_json(event_path)
    sys.stdout.write(str(integer(event.get("sequence"))) + "\n")

elif OP == "project-runtime":
    (runtime_path,) = ARGS
    runtime = regular_json(runtime_path, immutable=False)
    cursor = runtime.get("cursor")
    if not isinstance(cursor, dict):
        fail()
    dump(
        {
            "schema": runtime.get("schema"),
            "protocolVersion": runtime.get("protocolVersion"),
            "taskId": runtime.get("taskId"),
            "attemptId": runtime.get("attemptId"),
            "profile": runtime.get("profile"),
            "catalogHash": runtime.get("catalogHash"),
            "routeId": runtime.get("route"),
            "routeHash": runtime.get("routeHash"),
            "entryNode": runtime.get("entry"),
            "eventSequence": runtime.get("sequence"),
            "headEventHash": runtime.get("headEventHash"),
            "state": cursor.get("state"),
            "currentNode": cursor.get("currentNode"),
            "stop": cursor.get("stop"),
            "pauseReason": cursor.get("pauseReason"),
            "lastCommit": cursor.get("lastCommit"),
        }
    )

elif OP == "human-note":
    # Указание, оставленное человеком при возврате курсора на узел. Живёт в журнале
    # попытки событием human-rewind и обязано доехать до промпта того захода, ради
    # которого узел и вернули. Правила — в human_rewind_note().
    directory, node = ARGS
    note = human_rewind_note(directory, node)
    if note:
        sys.stdout.write(note + "\n")

elif OP == "validate-ledger":
    directory, task, attempt, profile, catalog, route, route_hash, entry = ARGS
    identifier(task, TASK_RE)
    identifier(attempt, ATTEMPT_RE)
    identifier(profile, PROFILE_RE)
    identifier(catalog, HASH_RE)
    identifier(route)
    identifier(route_hash, HASH_RE)
    identifier(entry)
    try:
        dir_info = os.lstat(directory)
        names = os.listdir(directory)
    except OSError:
        fail()
    if (
        not stat.S_ISDIR(dir_info.st_mode)
        or stat.S_ISLNK(dir_info.st_mode)
        or stat.S_IMODE(dir_info.st_mode) != 0o700
    ):
        fail()
    if "runtime.json" not in names:
        fail(73)
    event_names = []
    for name in names:
        path = os.path.join(directory, name)
        try:
            info = os.lstat(path)
        except OSError:
            fail()
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or stat.S_IMODE(info.st_mode) != 0o400
            or info.st_nlink != 1
        ):
            fail()
        if name == "runtime.json":
            continue
        match = EVENT_RE.fullmatch(name)
        if not match:
            fail()
        event_names.append((int(match.group(1)), match.group(2), name))
    event_names.sort()
    if not event_names or event_names[0][0] != 0:
        fail()

    previous_hash = None
    cursor = None
    for expected_sequence, (sequence, file_hash, name) in enumerate(event_names):
        if sequence != expected_sequence:
            fail()
        path = os.path.join(directory, name)
        try:
            raw = open(path, "rb").read()
        except OSError:
            fail()
        if hashlib.sha256(raw).hexdigest() != file_hash:
            fail()
        event = regular_json(path)
        validate_event_static(
            event,
            task,
            attempt,
            profile,
            catalog,
            route,
            route_hash,
        )
        if event["sequence"] != sequence or event["previousEventHash"] != previous_hash:
            fail()
        if sequence == 0:
            expected_cursor = {
                "state": "ready",
                "currentNode": entry,
                "stop": None,
                "pauseReason": None,
                "lastCommit": None,
            }
            if (
                event["kind"] != "init"
                or event["node"] != entry
                or event["outcome"] is not None
                or event["reason"] is not None
                or event["action"] != {"next": entry}
                or event["before"] is not None
                or event["after"] != expected_cursor
            ):
                fail()
        else:
            if event["before"] != cursor:
                fail()
            validate_cursor(cursor, sequence - 1)
            # Человеческий возврат — единственное событие, которое законно
            # УКАЗЫВАЕТ на другой узел: остальные описывают текущий.
            if event["kind"] != "human-rewind" and event["node"] != cursor["currentNode"]:
                fail()
            if event["kind"] == "human-rewind":
                # Возврат допустим из живого курсора и из остановки «ждёт человека»:
                # именно её человек и разрешает своим решением.
                if (
                    (cursor["state"] == "stopped" and cursor.get("stop") != "human")
                    or event["outcome"] is not None
                    or not isinstance(event["action"], dict)
                    or set(event["action"]) != {"rewind", "reset"}
                    or event["action"]["rewind"] != event["node"]
                ):
                    fail()
                reason(event["reason"])
                expected_cursor = {
                    "state": "ready",
                    "currentNode": event["node"],
                    "stop": None,
                    "pauseReason": None,
                    "lastCommit": cursor["lastCommit"],
                }
                if event["after"] != expected_cursor:
                    fail()
            elif event["kind"] == "pause":
                if (
                    cursor["state"] != "ready"
                    or event["outcome"] is not None
                    or event["action"] is not None
                ):
                    fail()
                reason(event["reason"])
                expected_cursor = {
                    "state": "paused",
                    "currentNode": event["node"],
                    "stop": None,
                    "pauseReason": event["reason"],
                    "lastCommit": cursor["lastCommit"],
                }
                if event["after"] != expected_cursor:
                    fail()
            elif event["kind"] == "commit":
                if (
                    cursor["state"] not in {"ready", "paused"}
                    or event["reason"] is not None
                ):
                    fail()
                identifier(event["outcome"])
                expected_cursor = derive_commit_cursor(
                    cursor,
                    event["action"],
                    event["node"],
                    event["outcome"],
                    sequence,
                )
                if event["after"] != expected_cursor:
                    fail()
            else:
                fail()
        validate_cursor(event["after"], sequence)
        cursor = event["after"]
        previous_hash = file_hash

    pointer = regular_json(os.path.join(directory, "runtime.json"))
    exact(pointer, {"checksum", "runtime"})
    identifier(pointer["checksum"], HASH_RE)
    if pointer["checksum"] != digest_value(pointer["runtime"]):
        fail()
    runtime = validate_runtime(
        pointer["runtime"],
        task,
        attempt,
        profile,
        catalog,
        route,
        route_hash,
        entry,
    )
    if (
        runtime["sequence"] != event_names[-1][0]
        or runtime["headEventHash"] != previous_hash
        or runtime["cursor"] != cursor
    ):
        fail()
    dump(runtime)

else:
    fail(2)
PY
}

# Populates ASTAGE_* globals after verifying the active attempt, immutable pins,
# terminal state, selected route, and the pinned route bundle itself.
_attempt_stage_state_load_locked() {
  local task=$1 attempt=$2 expected_route=${3:-}
  local root dir profile routes catalog route_pin route route_hash
  local terminal_rc description entry rc

  root=$(attempt_state_v2_task_root "$task") || return
  _attempt_state_protocol_locked "$root" || return
  _attempt_state_require_active_locked "$root" "$task" "$attempt" >/dev/null || return
  dir=$(_attempt_state_validate_attempt_locked "$root" "$task" "$attempt") || return
  profile=$(_attempt_state_json get "$dir/attempt.json" profile) || return
  routes=$(_attempt_state_json get "$dir/attempt.json" routesDir) || return
  catalog=$(_attempt_state_json get "$dir/attempt.json" catalogHash) || return
  _attempt_state_routes_dir "$routes" >/dev/null || return 78
  _attempt_state_validate_pins_locked \
    "$dir" "$task" "$attempt" "$profile" "$catalog" || return

  _attempt_state_terminal_locked "$dir" "$task" "$attempt" >/dev/null
  terminal_rc=$?
  if (( terminal_rc == 0 )); then
    return 75
  elif (( terminal_rc != 3 )); then
    return "$terminal_rc"
  fi

  route_pin=$(_attempt_state_route_pin_locked \
    "$dir" "$task" "$attempt" "$profile" "$catalog")
  rc=$?
  (( rc == 0 )) || {
    (( rc == 3 )) && return 73
    return "$rc"
  }
  route=$(_attempt_state_json get "$route_pin" routeId) || return
  route_hash=$(_attempt_state_json get "$route_pin" routeHash) || return
  if [[ -n "$expected_route" && "$expected_route" != "$route" ]]; then
    return 75
  fi

  description=$(mktemp "$dir/.route-description.XXXXXX") || return 1
  "$(_attempt_state_route_tool)" \
    --routes-dir "$routes" \
    --profile "$profile" \
    describe-route \
    --catalog-hash "$catalog" \
    --route "$route" >"$description"
  rc=$?
  if (( rc == 0 )); then
    entry=$(_attempt_stage_state_json parse-description \
      "$description" "$profile" "$catalog" "$route" "$route_hash")
    rc=$?
  fi
  rm -f -- "$description"
  (( rc == 0 )) || return "$rc"

  ASTAGE_ROOT=$root
  ASTAGE_ATTEMPT_DIR=$dir
  ASTAGE_RESULTS_DIR="$dir/stage-results"
  ASTAGE_PROFILE=$profile
  ASTAGE_ROUTES_DIR=$routes
  ASTAGE_CATALOG_HASH=$catalog
  ASTAGE_ROUTE=$route
  ASTAGE_ROUTE_HASH=$route_hash
  ASTAGE_ENTRY=$entry
  [[ -d "$ASTAGE_RESULTS_DIR" && ! -L "$ASTAGE_RESULTS_DIR" ]] || return 78
}

_attempt_stage_state_validate_internal_locked() {
  _attempt_stage_state_json validate-ledger \
    "$ASTAGE_RESULTS_DIR" \
    "$1" "$2" "$ASTAGE_PROFILE" "$ASTAGE_CATALOG_HASH" \
    "$ASTAGE_ROUTE" "$ASTAGE_ROUTE_HASH" "$ASTAGE_ENTRY"
}

_attempt_stage_state_validate_locked() {
  local task=$1 attempt=$2 runtime_tmp rc
  runtime_tmp=$(mktemp "$ASTAGE_ATTEMPT_DIR/.runtime-output.XXXXXX") || return 1
  _attempt_stage_state_validate_internal_locked "$task" "$attempt" >"$runtime_tmp"
  rc=$?
  if (( rc == 0 )); then
    _attempt_stage_state_json project-runtime "$runtime_tmp"
    rc=$?
  fi
  rm -f -- "$runtime_tmp"
  return "$rc"
}

_attempt_stage_state_publish_event_locked() {
  local event_tmp=$1 sequence hash final
  chmod 400 "$event_tmp" || return 1
  sync -f "$event_tmp" 2>/dev/null || true
  sequence=$(_attempt_stage_state_json event-sequence "$event_tmp") || return
  hash=$(sha256sum -- "$event_tmp" | awk '{print $1}') || return 1
  [[ "$hash" =~ ^[a-f0-9]{64}$ ]] || return 78
  printf -v final '%s/event.%020d.%s.json' "$ASTAGE_RESULTS_DIR" "$sequence" "$hash"
  [[ ! -e "$final" && ! -L "$final" ]] || return 78
  mv -- "$event_tmp" "$final" || return 1
  ASTAGE_EVENT_FILE=$final
  ASTAGE_EVENT_HASH=$hash
}

_attempt_stage_state_publish_runtime_locked() {
  local runtime_payload=$1 tmp rc
  tmp=$(mktemp "$ASTAGE_RESULTS_DIR/.runtime.XXXXXX") || return 1
  _attempt_stage_state_json make-envelope "$runtime_payload" >"$tmp"
  rc=$?
  if (( rc != 0 )); then
    rm -f -- "$tmp"
    return "$rc"
  fi
  chmod 400 "$tmp" || {
    rm -f -- "$tmp"
    return 1
  }
  sync -f "$tmp" 2>/dev/null || true
  mv -f -- "$tmp" "$ASTAGE_RESULTS_DIR/runtime.json" || {
    rm -f -- "$tmp"
    return 1
  }
  sync -f "$ASTAGE_RESULTS_DIR/runtime.json" 2>/dev/null || true
}

_attempt_stage_state_append_locked() {
  local event_tmp=$1 runtime_tmp rc
  _attempt_stage_state_publish_event_locked "$event_tmp" || return
  runtime_tmp=$(mktemp "$ASTAGE_RESULTS_DIR/.runtime-payload.XXXXXX") || return 1
  _attempt_stage_state_json runtime-from-event \
    "$ASTAGE_EVENT_FILE" "$ASTAGE_EVENT_HASH" "$ASTAGE_ENTRY" >"$runtime_tmp"
  rc=$?
  if (( rc == 0 )); then
    chmod 400 "$runtime_tmp" || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_publish_runtime_locked "$runtime_tmp"
    rc=$?
  fi
  rm -f -- "$runtime_tmp"
  return "$rc"
}

attempt_stage_state_init_v2() {
  local task attempt route root lock_fd event_tmp now rc
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  route=$(_attempt_state_route_id "${3:-}") || return
  root=$(attempt_state_v2_task_root "$task") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_stage_state_load_locked "$task" "$attempt" "$route"
  rc=$?
  if (( rc == 0 )) && [[ -e "$ASTAGE_RESULTS_DIR/runtime.json" ||
                         -L "$ASTAGE_RESULTS_DIR/runtime.json" ]]; then
    _attempt_stage_state_validate_locked "$task" "$attempt"
    rc=$?
    _attempt_state_unlock "$lock_fd"
    return "$rc"
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_json assert-empty "$ASTAGE_RESULTS_DIR" || rc=$?
  fi
  if (( rc == 0 )); then
    now=$(_attempt_stage_state_now) || rc=$?
    event_tmp=$(mktemp "$ASTAGE_RESULTS_DIR/.event.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_json make-init \
      "$task" "$attempt" "$ASTAGE_PROFILE" "$ASTAGE_CATALOG_HASH" \
      "$ASTAGE_ROUTE" "$ASTAGE_ROUTE_HASH" "$ASTAGE_ENTRY" "$now" >"$event_tmp" ||
      rc=$?
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_append_locked "$event_tmp"
    rc=$?
  else
    [[ -z "${event_tmp:-}" ]] || rm -f -- "$event_tmp"
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_validate_locked "$task" "$attempt"
    rc=$?
  fi
  _attempt_state_unlock "$lock_fd"
  return "$rc"
}

attempt_stage_state_read_v2() {
  local task attempt root lock_fd rc
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  root=$(attempt_state_v2_task_root "$task") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_stage_state_load_locked "$task" "$attempt" ""
  rc=$?
  if (( rc == 0 )); then
    _attempt_stage_state_validate_locked "$task" "$attempt"
    rc=$?
  fi
  _attempt_state_unlock "$lock_fd"
  return "$rc"
}

# Человеческий возврат курсора на пройденный узел маршрута. Это НЕ подделка
# исхода агента: в журнал ложится отдельное событие kind=human-rewind с
# обязательной причиной, а пройденные узлы сбрасываются, как при обычном rewind.
# Появился из кнопки «перейти сюда» кокпита: у v1 она форсировала статус этапа
# напрямую в реестре, в v2 такой путь закрыт — нужен доверенный эквивалент.
attempt_stage_state_human_rewind_v2() {
  local task attempt node reset reason root lock_fd runtime_tmp event_tmp now rc
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  node=$(_attempt_stage_state_node_id "${3:-}") || return
  reset=${4:-}
  reason=${5:-}
  [[ -n "$reset" ]] || return 2
  _attempt_state_reason "$reason" || return
  root=$(attempt_state_v2_task_root "$task") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_stage_state_load_locked "$task" "$attempt" ""
  rc=$?
  if (( rc == 0 )); then
    runtime_tmp=$(mktemp "$ASTAGE_ATTEMPT_DIR/.runtime-read.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_validate_internal_locked "$task" "$attempt" >"$runtime_tmp"
    rc=$?
  fi
  if (( rc == 0 )); then
    chmod 400 "$runtime_tmp" || rc=1
    now=$(_attempt_stage_state_now) || rc=$?
    event_tmp=$(mktemp "$ASTAGE_RESULTS_DIR/.event.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_json prepare-human-rewind \
      "$runtime_tmp" "$node" "$reset" "$reason" "$now" >"$event_tmp"
    rc=$?
    if (( rc == 10 )); then
      rm -f -- "$event_tmp" "$runtime_tmp"
      _attempt_stage_state_validate_locked "$task" "$attempt"
      rc=$?
      _attempt_state_unlock "$lock_fd"
      return "$rc"
    fi
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_append_locked "$event_tmp"
    rc=$?
  else
    [[ -z "${event_tmp:-}" ]] || rm -f -- "$event_tmp"
  fi
  [[ -z "${runtime_tmp:-}" ]] || rm -f -- "$runtime_tmp"
  if (( rc == 0 )); then
    _attempt_stage_state_validate_locked "$task" "$attempt"
    rc=$?
  fi
  _attempt_state_unlock "$lock_fd"
  return "$rc"
}

# Указание человека, приложенное к возврату курсора на узел, — для промпта захода.
# Чтение, ничего не пишет. Пустой вывод — норма: в узел вошли обычным ходом маршрута,
# а не возвратом, либо узел с тех пор уже закрывали коммитом.
attempt_stage_state_human_note_v2() {
  local task attempt node lock_fd rc
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  node=$(_attempt_stage_state_node_id "${3:-}") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_stage_state_load_locked "$task" "$attempt" ""
  rc=$?
  if (( rc == 0 )); then
    _attempt_stage_state_json human-note "$ASTAGE_RESULTS_DIR" "$node"
    rc=$?
  fi
  _attempt_state_unlock "$lock_fd"
  return "$rc"
}

attempt_stage_state_pause_v2() {
  local task attempt node reason root lock_fd runtime_tmp event_tmp now rc
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  node=$(_attempt_stage_state_node_id "${3:-}") || return
  reason=${4:-}
  _attempt_state_reason "$reason" || return
  root=$(attempt_state_v2_task_root "$task") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_stage_state_load_locked "$task" "$attempt" ""
  rc=$?
  if (( rc == 0 )); then
    runtime_tmp=$(mktemp "$ASTAGE_ATTEMPT_DIR/.runtime-read.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_validate_internal_locked "$task" "$attempt" >"$runtime_tmp"
    rc=$?
  fi
  if (( rc == 0 )); then
    chmod 400 "$runtime_tmp" || rc=1
    now=$(_attempt_stage_state_now) || rc=$?
    event_tmp=$(mktemp "$ASTAGE_RESULTS_DIR/.event.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_json prepare-pause \
      "$runtime_tmp" "$node" "$reason" "$now" >"$event_tmp"
    rc=$?
    if (( rc == 10 )); then
      rm -f -- "$event_tmp" "$runtime_tmp"
      _attempt_stage_state_validate_locked "$task" "$attempt"
      rc=$?
      _attempt_state_unlock "$lock_fd"
      return "$rc"
    fi
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_append_locked "$event_tmp"
    rc=$?
  else
    [[ -z "${event_tmp:-}" ]] || rm -f -- "$event_tmp"
  fi
  [[ -z "${runtime_tmp:-}" ]] || rm -f -- "$runtime_tmp"
  if (( rc == 0 )); then
    _attempt_stage_state_validate_locked "$task" "$attempt"
    rc=$?
  fi
  _attempt_state_unlock "$lock_fd"
  return "$rc"
}

attempt_stage_state_commit_v2() {
  local task attempt node outcome root lock_fd runtime_tmp transition_tmp event_tmp now rc
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  node=$(_attempt_stage_state_node_id "${3:-}") || return
  outcome=$(_attempt_stage_state_outcome "${4:-}") || return
  root=$(attempt_state_v2_task_root "$task") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_stage_state_load_locked "$task" "$attempt" ""
  rc=$?
  if (( rc == 0 )); then
    runtime_tmp=$(mktemp "$ASTAGE_ATTEMPT_DIR/.runtime-read.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_validate_internal_locked "$task" "$attempt" >"$runtime_tmp"
    rc=$?
  fi
  if (( rc == 0 )); then
    chmod 400 "$runtime_tmp" || rc=1
    transition_tmp=$(mktemp "$ASTAGE_RESULTS_DIR/.transition.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    "$(_attempt_state_route_tool)" \
      --routes-dir "$ASTAGE_ROUTES_DIR" \
      --profile "$ASTAGE_PROFILE" \
      transition \
      --catalog-hash "$ASTAGE_CATALOG_HASH" \
      --route "$ASTAGE_ROUTE" \
      --node "$node" \
      --outcome "$outcome" >"$transition_tmp"
    rc=$?
  fi
  if (( rc == 0 )); then
    now=$(_attempt_stage_state_now) || rc=$?
    event_tmp=$(mktemp "$ASTAGE_RESULTS_DIR/.event.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_json prepare-commit \
      "$runtime_tmp" "$transition_tmp" "$ASTAGE_RESULTS_DIR" "$node" "$outcome" "$now" >"$event_tmp"
    rc=$?
    if (( rc == 10 )); then
      rm -f -- "$event_tmp" "$transition_tmp" "$runtime_tmp"
      _attempt_stage_state_validate_locked "$task" "$attempt"
      rc=$?
      _attempt_state_unlock "$lock_fd"
      return "$rc"
    fi
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_append_locked "$event_tmp"
    rc=$?
  else
    [[ -z "${event_tmp:-}" ]] || rm -f -- "$event_tmp"
  fi
  [[ -z "${transition_tmp:-}" ]] || rm -f -- "$transition_tmp"
  [[ -z "${runtime_tmp:-}" ]] || rm -f -- "$runtime_tmp"
  if (( rc == 0 )); then
    _attempt_stage_state_validate_locked "$task" "$attempt"
    rc=$?
  fi
  _attempt_state_unlock "$lock_fd"
  return "$rc"
}
