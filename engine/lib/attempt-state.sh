#!/usr/bin/env bash
# Trusted immutable состояние попыток route protocol. После cutover это единственный
# исполняемый state layer; исторические tNN.pipeline читаются только как UI-проекция.
# Суффикс `_v2` у внутренних shell API сохранён как версия формата ledger, не как второй launcher.
#
# Публичный API:
#   attempt_state_begin_v2 TASK PROFILE ABS_ROUTES_DIR [EXPECTED_CATALOG_HASH]
#                          [QUEUE_DISPATCH_ID] [RUNNER_PRIMARY_OVERRIDE]
#   attempt_state_select_route_v2 TASK ATTEMPT_ID ROUTE_ID
#   attempt_state_resume_v2 TASK [EXPECTED_ATTEMPT_ID]
#   attempt_state_finish_v2 TASK ATTEMPT_ID
#   attempt_state_abandon_v2 TASK ATTEMPT_ID REASON
#   attempt_state_recover_v2 TASK PREVIOUS_ATTEMPT_ID REASON [LEGACY_RUNNER_OVERRIDE]
#   attempt_state_contract_drift_v2 PINNED_TSV ACTUAL_TSV PINNED_JSON ACTUAL_JSON
#
# Коды ошибок: 2 — неверный аргумент/путь, 73 — уже существует/активно,
# 75 — CAS-конфликт active pointer, 78 — повреждённое или несовместимое состояние.

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/run-state.sh"

_attempt_state_task_id() {
  local task=${1:-}
  task=${task#[tT]}
  [[ "$task" =~ ^[1-9][0-9]{0,18}$ ]] || return 2
  printf '%s\n' "$task"
}

_attempt_state_profile_id() {
  local profile=${1:-}
  [[ "$profile" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || return 2
  printf '%s\n' "$profile"
}

_attempt_state_route_id() {
  local route=${1:-}
  [[ "$route" =~ ^[a-z0-9][a-z0-9_-]{0,40}$ && "$route" != catalog ]] || return 2
  printf '%s\n' "$route"
}

_attempt_state_attempt_id() {
  local attempt=${1:-}
  [[ "$attempt" =~ ^a_[a-f0-9]{32}$ ]] || return 2
  printf '%s\n' "$attempt"
}

_attempt_state_catalog_hash() {
  local hash=${1:-}
  [[ "$hash" =~ ^[a-f0-9]{64}$ ]] || return 2
  printf '%s\n' "$hash"
}

_attempt_state_dispatch_id() {
  local dispatch=${1:-}
  [[ "$dispatch" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] ||
    return 2
  printf '%s\n' "$dispatch"
}

_attempt_state_runner_override() {
  local runner=${1:-}
  [[ -z "$runner" || "$runner" =~ ^[a-z][a-z0-9_-]{0,63}$ ]] || return 2
  printf '%s\n' "$runner"
}

# Причина ручного вмешательства (abandon/recover/goto/pause) ложится в доверенный
# журнал и едет в промпт следующего агента — то есть это ТЕКСТ ЗАДАНИЯ, а не подпись
# к действию. Однострочный лимит в 500 символов стоил ровно того, ради чего канал и
# заведён: развёрнутое замечание человека (таблица замеров, перечень точек правки,
# запреты) резалось на первом же абзаце, и агент входил в узел с обрубком. Поэтому
# многострочность разрешена, а потолок поднят до 20 000 символов: причина едет
# аргументом execFile и переменной окружения, обе упираются в MAX_ARG_STRLEN 128 КБ,
# а 20 000 символов кириллицы в UTF-8 — 40 КБ, то есть троекратный запас.
# `\r` по-прежнему запрещён: журнал держит один перевод строки, CR нормализует
# HTTP-слой GrigDesk (textarea браузера шлёт CRLF).
# Отказ обязан называть нарушенное правило: молчащий код 2 стоит захода. Так уже
# было с вердиктом этапа (lib/run-state.sh) — человек за CLI и агент видели «код 2»
# и не понимали, что упёрлись в лимит длины, а не в состояние ledger.
_attempt_state_reason() {
  python3 - "${1-}" <<'PY'
import sys

REASON_LIMIT = 20000
value = sys.argv[1]


def fail(reason):
    print(f"reason: {reason}", file=sys.stderr)
    raise SystemExit(2)


if not value:
    fail("причина обязательна и не может быть пустой")
if len(value) > REASON_LIMIT:
    fail(
        f"причина {len(value)} символов, допустимо 1..{REASON_LIMIT}; "
        "развёрнутый разбор кладётся в файл этапа, в причину идёт ссылка на него"
    )
for position, char in enumerate(value, start=1):
    code = ord(char)
    if char != "\n" and (code < 32 or code == 127):
        name = "возврат каретки" if char == "\r" else f"управляющий символ U+{code:04X}"
        fail(
            f"причина содержит {name} в позиции {position}; "
            "допустимы печатные символы и перевод строки"
        )
PY
}

_attempt_state_state_dir() {
  local control canonical
  control=$(factory_control_root) || return
  mkdir -p "$control" || return 1
  [[ -d "$control" && ! -L "$control" ]] || return 78
  canonical=$(realpath -e -- "$control") || return 78
  [[ "$canonical" == "$control" && -O "$control" ]] || return 78
  chmod 700 -- "$control" 2>/dev/null || return 78
  printf '%s\n' "$control"
}

attempt_state_v2_task_root() {
  local task state
  task=$(_attempt_state_task_id "${1:-}") || return
  state=$(_attempt_state_state_dir) || return
  printf '%s/protocol-v2/tasks/t%s\n' "$state" "$task"
}

_attempt_state_routes_dir() {
  local routes=${1:-} canonical
  [[ -n "$routes" && "$routes" == /* &&
     "$routes" != *$'\n'* && "$routes" != *$'\t'* ]] || return 2
  [[ -d "$routes" && ! -L "$routes" ]] || return 2
  canonical=$(realpath -e -- "$routes") || return 2
  [[ "$canonical" == "$routes" ]] || return 2
  printf '%s\n' "$routes"
}

_attempt_state_route_tool() {
  local tool="${FACTORY_HOME:?}/bin/factory-route" canonical
  [[ "$tool" == /* && -f "$tool" && -x "$tool" && ! -L "$tool" ]] || return 2
  canonical=$(realpath -e -- "$tool") || return 2
  [[ "$canonical" == "$tool" ]] || return 2
  printf '%s\n' "$tool"
}

_attempt_state_prepare_root() {
  local root=$1 state base tasks dir canonical
  state=$(_attempt_state_state_dir) || return
  base="$state/protocol-v2"
  tasks="$base/tasks"
  for dir in "$base" "$tasks" "$root" "$root/attempts"; do
    if [[ -e "$dir" || -L "$dir" ]]; then
      [[ -d "$dir" && ! -L "$dir" ]] || return 78
    else
      mkdir -m 700 -- "$dir" 2>/dev/null || {
        [[ -d "$dir" && ! -L "$dir" ]] || return 1
      }
    fi
    canonical=$(realpath -e -- "$dir" 2>/dev/null) || return 78
    [[ "$canonical" == "$dir" && -O "$dir" ]] || return 78
    # protocol-v2 мог впервые появиться через orchestrator/shared lock под umask
    # 0002 и остаться 0775. Trusted ledger fail-closed требует приватную lineage;
    # существующий канонический каталог текущего uid безопасно сужаем до 0700.
    chmod 700 -- "$dir" 2>/dev/null || return 78
  done
}

_attempt_state_json() {
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
PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
ROUTE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")
HASH_RE = re.compile(r"^[a-f0-9]{64}$")
DISPATCH_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
)
RUNNER_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
TASK_RE = re.compile(r"^[1-9][0-9]{0,18}$")
TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def fail(code=78):
    raise SystemExit(code)


def exact(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        fail()


def regular_json(path):
    try:
        info = os.lstat(path)
    except OSError:
        fail()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        fail()
    try:
        with open(path, encoding="utf-8") as source:
            return json.load(source, parse_constant=lambda _: fail())
    except (OSError, UnicodeError, json.JSONDecodeError):
        fail()


def identifier(value, regexp):
    if not isinstance(value, str) or not regexp.fullmatch(value):
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


def reason(value, nullable=False):
    # Границы те же, что у _attempt_state_reason: многострочный текст до 20 000
    # символов. Ослабление обратносовместимо — прежние однострочные причины
    # из старых журналов проходят проверку без изменений.
    if nullable and value is None:
        return value
    if not isinstance(value, str) or not 1 <= len(value) <= 20000:
        fail()
    if any(char != "\n" and (ord(char) < 32 or ord(char) == 127) for char in value):
        fail()
    return value


def dump(value):
    json.dump(value, sys.stdout, ensure_ascii=False, sort_keys=True, indent=2)
    sys.stdout.write("\n")


def validate_attempt(value, task, attempt):
    schema_v1 = {
        "schema", "protocolVersion", "attemptId", "taskId", "profile", "createdAt",
        "routesDir", "catalogHash", "origin", "previousAttemptId", "recoveryReason",
    }
    schema_v2 = schema_v1 | {"queueDispatchId", "runnerPrimaryOverride"}
    if not isinstance(value, dict) or value.get("schema") not in {1, 2}:
        fail()
    exact(value, schema_v1 if value["schema"] == 1 else schema_v2)
    if value["protocolVersion"] != 2:
        fail()
    if identifier(value["attemptId"], ATTEMPT_RE) != attempt:
        fail()
    if identifier(value["taskId"], TASK_RE) != task:
        fail()
    identifier(value["profile"], PROFILE_RE)
    timestamp(value["createdAt"])
    if (
        not isinstance(value["routesDir"], str)
        or not value["routesDir"].startswith("/")
        or "\n" in value["routesDir"]
        or "\t" in value["routesDir"]
    ):
        fail()
    identifier(value["catalogHash"], HASH_RE)
    if value["schema"] == 2:
        dispatch = value["queueDispatchId"]
        if dispatch is not None:
            identifier(dispatch, DISPATCH_RE)
        runner = value["runnerPrimaryOverride"]
        if not isinstance(runner, str) or (runner and not RUNNER_RE.fullmatch(runner)):
            fail()
    if value["origin"] == "fresh":
        if value["previousAttemptId"] is not None or value["recoveryReason"] is not None:
            fail()
    elif value["origin"] == "recovery":
        identifier(value["previousAttemptId"], ATTEMPT_RE)
        if value["previousAttemptId"] == attempt:
            fail()
        reason(value["recoveryReason"])
        if value["schema"] == 2 and value["queueDispatchId"] is not None:
            fail()
    else:
        fail()


def validate_pins(value, task, attempt, profile, catalog):
    exact(value, {
        "schema", "protocolVersion", "attemptId", "taskId", "profile",
        "catalogHash", "bootstrap",
    })
    if value["schema"] != 1 or value["protocolVersion"] != 2:
        fail()
    if value["attemptId"] != attempt or value["taskId"] != task or value["profile"] != profile:
        fail()
    if value["catalogHash"] != catalog:
        fail()
    exact(value["bootstrap"], {"id", "catalogHash"})
    if value["bootstrap"] != {"id": "scout", "catalogHash": catalog}:
        fail()


if OP == "make-protocol":
    dump({"protocolVersion": 2, "schema": 1})
elif OP == "validate-protocol":
    value = regular_json(ARGS[0])
    exact(value, {"schema", "protocolVersion"})
    if value != {"schema": 1, "protocolVersion": 2}:
        fail()
elif OP == "make-attempt":
    (
        attempt, task, profile, created, routes, catalog, origin, previous,
        recovery, dispatch, runner,
    ) = ARGS
    value = {
        "schema": 2,
        "protocolVersion": 2,
        "attemptId": attempt,
        "taskId": task,
        "profile": profile,
        "createdAt": created,
        "routesDir": routes,
        "catalogHash": catalog,
        "origin": origin,
        "previousAttemptId": previous or None,
        "recoveryReason": recovery or None,
        "queueDispatchId": dispatch or None,
        "runnerPrimaryOverride": runner,
    }
    validate_attempt(value, task, attempt)
    dump(value)
elif OP == "validate-attempt":
    path, task, attempt = ARGS
    validate_attempt(regular_json(path), task, attempt)
elif OP == "make-pins":
    attempt, task, profile, catalog = ARGS
    value = {
        "schema": 1,
        "protocolVersion": 2,
        "attemptId": attempt,
        "taskId": task,
        "profile": profile,
        "catalogHash": catalog,
        "bootstrap": {"id": "scout", "catalogHash": catalog},
    }
    validate_pins(value, task, attempt, profile, catalog)
    dump(value)
elif OP == "validate-pins":
    path, task, attempt, profile, catalog = ARGS
    validate_pins(regular_json(path), task, attempt, profile, catalog)
elif OP == "make-active":
    attempt, task = ARGS
    dump({
        "schema": 1,
        "protocolVersion": 2,
        "taskId": task,
        "attemptId": attempt,
    })
elif OP == "validate-active":
    path, task = ARGS
    value = regular_json(path)
    exact(value, {"schema", "protocolVersion", "taskId", "attemptId"})
    if value["schema"] != 1 or value["protocolVersion"] != 2 or value["taskId"] != task:
        fail()
    identifier(value["attemptId"], ATTEMPT_RE)
elif OP == "make-route-pin":
    attempt, task, profile, catalog, route_id, route_hash, selected = ARGS
    value = {
        "schema": 1,
        "protocolVersion": 2,
        "attemptId": attempt,
        "taskId": task,
        "profile": profile,
        "catalogHash": catalog,
        "routeId": route_id,
        "routeHash": route_hash,
        "selectedAt": selected,
    }
    dump(value)
elif OP == "validate-route-pin":
    path, task, attempt, profile, catalog = ARGS
    value = regular_json(path)
    exact(value, {
        "schema", "protocolVersion", "attemptId", "taskId", "profile",
        "catalogHash", "routeId", "routeHash", "selectedAt",
    })
    if (
        value["schema"] != 1
        or value["protocolVersion"] != 2
        or value["attemptId"] != attempt
        or value["taskId"] != task
        or value["profile"] != profile
        or value["catalogHash"] != catalog
    ):
        fail()
    identifier(value["routeId"], ROUTE_RE)
    if value["routeId"] == "catalog":
        fail()
    identifier(value["routeHash"], HASH_RE)
    timestamp(value["selectedAt"])
elif OP == "make-terminal":
    attempt, task, state, closed, terminal_reason = ARGS
    if state not in {"finished", "abandoned"}:
        fail(2)
    value = {
        "schema": 1,
        "protocolVersion": 2,
        "attemptId": attempt,
        "taskId": task,
        "state": state,
        "closedAt": closed,
        "reason": terminal_reason or None,
    }
    timestamp(closed)
    if state == "finished" and value["reason"] is not None:
        fail(2)
    if state == "abandoned":
        reason(value["reason"])
    dump(value)
elif OP == "validate-terminal":
    path, task, attempt = ARGS
    value = regular_json(path)
    exact(value, {
        "schema", "protocolVersion", "attemptId", "taskId",
        "state", "closedAt", "reason",
    })
    if (
        value["schema"] != 1
        or value["protocolVersion"] != 2
        or value["attemptId"] != attempt
        or value["taskId"] != task
        or value["state"] not in {"finished", "abandoned"}
    ):
        fail()
    timestamp(value["closedAt"])
    if value["state"] == "finished":
        if value["reason"] is not None:
            fail()
    else:
        reason(value["reason"])
elif OP == "parse-current":
    path, profile = ARGS
    value = regular_json(path)
    exact(value, {"schema", "profile", "catalogHash", "routes"})
    if value["schema"] != 2 or value["profile"] != profile:
        fail()
    identifier(value["catalogHash"], HASH_RE)
    if not isinstance(value["routes"], dict) or not value["routes"]:
        fail()
    for route_id, route_hash in value["routes"].items():
        identifier(route_id, ROUTE_RE)
        if route_id == "catalog":
            fail()
        identifier(route_hash, HASH_RE)
    sys.stdout.write(value["catalogHash"] + "\n")
elif OP == "parse-catalog":
    path, profile, catalog = ARGS
    value = regular_json(path)
    exact(value, {"schema", "profile", "catalogHash", "routes"})
    if value["schema"] != 2 or value["profile"] != profile or value["catalogHash"] != catalog:
        fail()
    if not isinstance(value["routes"], dict) or not value["routes"]:
        fail()
    for route_id, route_hash in value["routes"].items():
        identifier(route_id, ROUTE_RE)
        if route_id == "catalog":
            fail()
        identifier(route_hash, HASH_RE)
elif OP == "make-resume":
    pins_path, route_path = ARGS
    pins = regular_json(pins_path)
    route = None
    if route_path:
        selected = regular_json(route_path)
        route = {"id": selected["routeId"], "hash": selected["routeHash"]}
    dump({**pins, "route": route})
elif OP == "get":
    path, key = ARGS
    value = regular_json(path)
    if key not in value:
        fail()
    field = value[key]
    if field is None:
        sys.stdout.write("\n")
    elif isinstance(field, (str, int)):
        sys.stdout.write(str(field) + "\n")
    else:
        fail()
else:
    fail(2)
PY
}

_attempt_state_write_json() {
  local output=$1 operation=$2
  shift 2
  local tmp rc
  tmp=$(mktemp "$(dirname "$output")/.json.XXXXXX") || return 1
  _attempt_state_json "$operation" "$@" >"$tmp"
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
  mv -f -- "$tmp" "$output"
}

_attempt_state_write_checksum() {
  local file=$1 output=$2 hash
  hash=$(sha256sum -- "$file" | awk '{print $1}') || return 1
  printf '%s\n' "$hash" >"$output" || return 1
  chmod 400 "$output" || return 1
}

_attempt_state_verify_checksum() {
  local file=$1 checksum=$2 expected actual
  [[ -f "$file" && ! -L "$file" && -f "$checksum" && ! -L "$checksum" ]] || return 78
  IFS= read -r expected <"$checksum" || return 78
  [[ "$expected" =~ ^[a-f0-9]{64}$ && $(wc -l <"$checksum") -eq 1 ]] || return 78
  actual=$(sha256sum -- "$file" | awk '{print $1}') || return 78
  [[ "$actual" == "$expected" ]] || return 78
}

_attempt_state_lock() {
  local task=$1 output_var=$2 root fd
  root=$(attempt_state_v2_task_root "$task") || return
  _attempt_state_prepare_root "$root" || return
  # Лочим fd самого task-каталога. Отдельный lock-файл пришлось бы открывать
  # с защитой от symlink race; directory inode даёт тот же kernel flock без
  # pathname, который можно подменить между lstat и open.
  exec {fd}<"$root" || return 1
  flock "$fd" || {
    eval "exec ${fd}>&-"
    return 1
  }
  printf -v "$output_var" '%s' "$fd"
}

_attempt_state_unlock() {
  local fd=${1:-}
  [[ "$fd" =~ ^[0-9]+$ ]] || return 2
  flock -u "$fd" 2>/dev/null || true
  eval "exec ${fd}>&-"
}

_attempt_state_protocol_locked() {
  local root=$1 protocol="$root/protocol.json" tmp
  if [[ -e "$protocol" || -L "$protocol" ]]; then
    [[ -f "$protocol" && ! -L "$protocol" ]] || return 78
    _attempt_state_json validate-protocol "$protocol"
    return
  fi
  tmp=$(mktemp "$root/.protocol.XXXXXX") || return 1
  _attempt_state_json make-protocol >"$tmp" || {
    local rc=$?
    rm -f -- "$tmp"
    return "$rc"
  }
  chmod 400 "$tmp" || {
    rm -f -- "$tmp"
    return 1
  }
  mv -f -- "$tmp" "$protocol"
}

_attempt_state_active_id_locked() {
  local root=$1 task=$2 pointer="$root/active-attempt.json"
  [[ -e "$pointer" || -L "$pointer" ]] || return 3
  [[ -f "$pointer" && ! -L "$pointer" ]] || return 78
  _attempt_state_json validate-active "$pointer" "$task" || return
  _attempt_state_json get "$pointer" attemptId
}

_attempt_state_require_active_locked() {
  local root=$1 task=$2 expected=${3:-} active rc
  active=$(_attempt_state_active_id_locked "$root" "$task")
  rc=$?
  (( rc == 0 )) || {
    (( rc == 3 )) && return 75
    return "$rc"
  }
  if [[ -n "$expected" && "$active" != "$expected" ]]; then
    return 75
  fi
  printf '%s\n' "$active"
}

_attempt_state_generate_id() {
  local random id
  if [[ -n "${ATTEMPT_STATE_ID_OVERRIDE:-}" ]]; then
    [[ "${FACTORY_TESTING:-0}" == 1 ]] || return 2
    _attempt_state_attempt_id "$ATTEMPT_STATE_ID_OVERRIDE"
    return
  fi
  random=$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n') || return 1
  id="a_${random}"
  _attempt_state_attempt_id "$id"
}

_attempt_state_attempt_dir() {
  local root=$1 attempt
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  printf '%s/attempts/%s\n' "$root" "$attempt"
}

_attempt_state_validate_attempt_locked() {
  local root=$1 task=$2 attempt=$3 dir
  dir=$(_attempt_state_attempt_dir "$root" "$attempt") || return
  [[ -d "$dir" && ! -L "$dir" ]] || return 78
  _attempt_state_verify_checksum "$dir/attempt.json" "$dir/attempt.sha256" || return
  _attempt_state_json validate-attempt "$dir/attempt.json" "$task" "$attempt" || return
  printf '%s\n' "$dir"
}

_attempt_state_validate_pins_locked() {
  local dir=$1 task=$2 attempt=$3 profile=$4 catalog=$5
  _attempt_state_verify_checksum "$dir/pins.json" "$dir/pins.sha256" || return
  _attempt_state_json validate-pins \
    "$dir/pins.json" "$task" "$attempt" "$profile" "$catalog"
}

_attempt_state_route_pin_locked() {
  local dir=$1 task=$2 attempt=$3 profile=$4 catalog=$5 file name expected actual
  local nullglob_was_off=0
  shopt -q nullglob || nullglob_was_off=1
  shopt -s nullglob
  local -a files=("$dir"/route-pin.*.json)
  (( nullglob_was_off == 0 )) || shopt -u nullglob
  (( ${#files[@]} <= 1 )) || return 78
  (( ${#files[@]} == 1 )) || return 3
  file=${files[0]}
  name=${file##*/}
  [[ "$name" =~ ^route-pin\.([a-f0-9]{64})\.json$ ]] || return 78
  expected=${BASH_REMATCH[1]}
  [[ -f "$file" && ! -L "$file" ]] || return 78
  actual=$(sha256sum -- "$file" | awk '{print $1}') || return 78
  [[ "$actual" == "$expected" ]] || return 78
  _attempt_state_json validate-route-pin "$file" "$task" "$attempt" "$profile" "$catalog" ||
    return
  printf '%s\n' "$file"
}

_attempt_state_terminal_locked() {
  local dir=$1 task=$2 attempt=$3 file name expected actual
  local nullglob_was_off=0
  shopt -q nullglob || nullglob_was_off=1
  shopt -s nullglob
  local -a files=("$dir"/terminal.*.json)
  (( nullglob_was_off == 0 )) || shopt -u nullglob
  (( ${#files[@]} <= 1 )) || return 78
  (( ${#files[@]} == 1 )) || return 3
  file=${files[0]}
  name=${file##*/}
  [[ "$name" =~ ^terminal\.([a-f0-9]{64})\.json$ ]] || return 78
  expected=${BASH_REMATCH[1]}
  [[ -f "$file" && ! -L "$file" ]] || return 78
  actual=$(sha256sum -- "$file" | awk '{print $1}') || return 78
  [[ "$actual" == "$expected" ]] || return 78
  _attempt_state_json validate-terminal "$file" "$task" "$attempt" || return
  printf '%s\n' "$file"
}

_attempt_state_read_current_locked() {
  local profile=$1 routes=$2 output=$3 tool rc
  tool=$(_attempt_state_route_tool) || return
  "$tool" --routes-dir "$routes" --profile "$profile" current >"$output"
  rc=$?
  (( rc == 0 )) || return "$rc"
  _attempt_state_json parse-current "$output" "$profile"
}

# ENOENT у canonical current — доказанный catalog transition в `none`, если
# вызывающий принёс valid expected hash. Повреждение файла, symlink или
# нечитаемая иерархия сюда не попадают: их нельзя маскировать под безопасный CAS
# mismatch, они сохраняют исходный integrity rc от factory-route.
_attempt_state_current_absent() {
  local profile=$1 routes=$2 profile_dir catalog_dir current
  profile_dir="$routes/$profile"
  catalog_dir="$profile_dir/catalog"
  current="$catalog_dir/current.json"
  [[ -d "$profile_dir" && ! -L "$profile_dir" && -x "$profile_dir" &&
     -d "$catalog_dir" && ! -L "$catalog_dir" &&
     -r "$catalog_dir" && -x "$catalog_dir" &&
     ! -e "$current" && ! -L "$current" ]]
}

# ID генерирует только движок, а immutable final публикуется прежде mutable active pointer.
# Runtime bind между ними сохраняет reservation при отказе и не допускает первый provider.
_attempt_state_create_locked() {
  local root=$1 task=$2 profile=$3 routes=$4 origin=$5 previous=$6 recovery=$7
  local expected=${8:-} dispatch=${9:-} runner=${10:-}
  local attempt current catalog created staging final pointer_tmp rc
  attempt=$(_attempt_state_generate_id) || return
  final=$(_attempt_state_attempt_dir "$root" "$attempt") || return
  [[ ! -e "$final" && ! -L "$final" ]] || return 73

  if [[ -n "$expected" ]] && _attempt_state_current_absent "$profile" "$routes"; then
    printf 'FACTORY_ERROR=catalog_changed EXPECTED=%s ACTUAL=none\n' \
      "$expected" >&2
    return 75
  fi
  current=$(mktemp "$root/.current.XXXXXX") || return 1
  catalog=$(_attempt_state_read_current_locked "$profile" "$routes" "$current")
  rc=$?
  rm -f -- "$current"
  if (( rc != 0 )); then
    if [[ -n "$expected" ]] &&
       _attempt_state_current_absent "$profile" "$routes"; then
      printf 'FACTORY_ERROR=catalog_changed EXPECTED=%s ACTUAL=none\n' \
        "$expected" >&2
      return 75
    fi
    return "$rc"
  fi
  if [[ -n "$expected" && "$catalog" != "$expected" ]]; then
    printf 'FACTORY_ERROR=catalog_changed EXPECTED=%s ACTUAL=%s\n' \
      "$expected" "$catalog" >&2
    return 75
  fi

  created=$(date -u +%Y-%m-%dT%H:%M:%SZ) || return 1
  staging=$(mktemp -d "$root/attempts/.new.XXXXXX") || return 1
  chmod 700 "$staging"
  mkdir -m 700 "$staging/stage-results" "$staging/artifacts" "$staging/transactions" || {
    rm -rf -- "$staging"
    return 1
  }
  _attempt_state_write_json "$staging/attempt.json" make-attempt \
    "$attempt" "$task" "$profile" "$created" "$routes" "$catalog" \
    "$origin" "$previous" "$recovery" "$dispatch" "$runner" || {
      rc=$?
      rm -rf -- "$staging"
      return "$rc"
    }
  _attempt_state_write_checksum "$staging/attempt.json" "$staging/attempt.sha256" || {
    rm -rf -- "$staging"
    return 1
  }
  _attempt_state_write_json "$staging/pins.json" make-pins \
    "$attempt" "$task" "$profile" "$catalog" || {
      rc=$?
      rm -rf -- "$staging"
      return "$rc"
    }
  _attempt_state_write_checksum "$staging/pins.json" "$staging/pins.sha256" || {
    rm -rf -- "$staging"
    return 1
  }
  mv -- "$staging" "$final" || {
    rm -rf -- "$staging"
    return 1
  }

  # Runtime sidecar привязывается после immutable final, но до active pointer.
  # Ошибка сохраняет orphan directory/reservation и не даёт первому provider стартовать.
  if [[ -n "${GRIGDESK_SERVER_RUNTIME_RESERVATION:-}" ||
        -n "${GRIGDESK_SERVER_RUNTIME_NODE:-}" ||
        -n "${GRIGDESK_SERVER_RUNTIME_PIN_HELPER:-}" ]]; then
    if [[ "${GRIGDESK_SERVER_RUNTIME_NODE:-}" != /* ||
          "${GRIGDESK_SERVER_RUNTIME_PIN_HELPER:-}" != /* ||
          "${GRIGDESK_SERVER_RUNTIME_RESERVATION:-}" != /* ]]; then
      return 78
    fi

    _attempt_state_validate_attempt_locked "$root" "$task" "$attempt" >/dev/null || return "$?"

    "$GRIGDESK_SERVER_RUNTIME_NODE" "$GRIGDESK_SERVER_RUNTIME_PIN_HELPER" bind \
      --reservation "$GRIGDESK_SERVER_RUNTIME_RESERVATION" \
      --task "$task" --attempt "$attempt" --attempt-dir "$final" || return "$?"
  fi

  pointer_tmp=$(mktemp "$root/.active.XXXXXX") || return 1
  _attempt_state_json make-active "$attempt" "$task" >"$pointer_tmp" || {
    rc=$?
    rm -f -- "$pointer_tmp"
    return "$rc"
  }
  chmod 400 "$pointer_tmp" || {
    rm -f -- "$pointer_tmp"
    return 1
  }
  sync -f "$pointer_tmp" 2>/dev/null || true
  if [[ -e "$root/active-attempt.json" || -L "$root/active-attempt.json" ]]; then
    rm -f -- "$pointer_tmp"
    return 75
  fi
  mv -- "$pointer_tmp" "$root/active-attempt.json" || {
    rm -f -- "$pointer_tmp"
    return 1
  }
  printf '%s\n' "$attempt"
}

attempt_state_begin_v2() {
  local task profile routes expected=${4:-} dispatch=${5:-} runner=${6:-}
  local root lock_fd rc
  task=$(_attempt_state_task_id "${1:-}") || return
  profile=$(_attempt_state_profile_id "${2:-}") || return
  routes=$(_attempt_state_routes_dir "${3:-}") || return
  if [[ -n "$expected" ]]; then
    expected=$(_attempt_state_catalog_hash "$expected") || return
  fi
  if [[ -n "$dispatch" ]]; then
    dispatch=$(_attempt_state_dispatch_id "$dispatch") || return
    [[ -n "$expected" ]] || return 2
  fi
  runner=$(_attempt_state_runner_override "$runner") || return
  _attempt_state_route_tool >/dev/null || return
  root=$(attempt_state_v2_task_root "$task") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_state_protocol_locked "$root"
  rc=$?
  if (( rc == 0 )); then
    _attempt_state_active_id_locked "$root" "$task" >/dev/null
    rc=$?
    if (( rc == 0 )); then
      rc=73
    elif (( rc == 3 )); then
      rc=0
    fi
  fi
  if (( rc == 0 )); then
    _attempt_state_create_locked "$root" "$task" "$profile" "$routes" \
      fresh "" "" "$expected" "$dispatch" "$runner"
    rc=$?
  fi
  _attempt_state_unlock "$lock_fd"
  return "$rc"
}

attempt_state_select_route_v2() {
  local task attempt route root lock_fd dir profile routes catalog
  local terminal_rc pin_rc route_file route_hash selected tmp content_hash final rc
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  route=$(_attempt_state_route_id "${3:-}") || return
  root=$(attempt_state_v2_task_root "$task") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_state_protocol_locked "$root"
  rc=$?
  if (( rc == 0 )); then
    _attempt_state_require_active_locked "$root" "$task" "$attempt" >/dev/null
    rc=$?
  fi
  if (( rc == 0 )); then
    dir=$(_attempt_state_validate_attempt_locked "$root" "$task" "$attempt")
    rc=$?
  fi
  if (( rc == 0 )); then
    profile=$(_attempt_state_json get "$dir/attempt.json" profile) || rc=$?
    routes=$(_attempt_state_json get "$dir/attempt.json" routesDir) || rc=$?
    catalog=$(_attempt_state_json get "$dir/attempt.json" catalogHash) || rc=$?
  fi
  if (( rc == 0 )); then
    _attempt_state_routes_dir "$routes" >/dev/null || rc=78
    _attempt_state_validate_pins_locked \
      "$dir" "$task" "$attempt" "$profile" "$catalog" || rc=$?
  fi
  if (( rc == 0 )); then
    _attempt_state_terminal_locked "$dir" "$task" "$attempt" >/dev/null
    terminal_rc=$?
    (( terminal_rc == 3 )) || {
      (( terminal_rc == 0 )) && rc=73 || rc=$terminal_rc
    }
  fi
  if (( rc == 0 )); then
    _attempt_state_route_pin_locked \
      "$dir" "$task" "$attempt" "$profile" "$catalog" >/dev/null
    pin_rc=$?
    (( pin_rc == 3 )) || {
      (( pin_rc == 0 )) && rc=73 || rc=$pin_rc
    }
  fi
  if (( rc == 0 )); then
    route_file=$(mktemp "$dir/.route-hash.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    "$(_attempt_state_route_tool)" \
      --routes-dir "$routes" \
      --profile "$profile" \
      route-hash \
      --catalog-hash "$catalog" \
      --route "$route" >"$route_file"
    rc=$?
  fi
  if (( rc == 0 )); then
    IFS= read -r route_hash <"$route_file" || rc=78
    [[ "$route_hash" =~ ^[a-f0-9]{64}$ &&
       $(wc -l <"$route_file") -eq 1 ]] || rc=78
  fi
  [[ -z "${route_file:-}" ]] || rm -f -- "$route_file"
  if (( rc == 0 )); then
    selected=$(date -u +%Y-%m-%dT%H:%M:%SZ) || rc=1
    tmp=$(mktemp "$dir/.route-pin.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_state_json make-route-pin \
      "$attempt" "$task" "$profile" "$catalog" "$route" "$route_hash" "$selected" >"$tmp" ||
      rc=$?
  fi
  if (( rc == 0 )); then
    chmod 400 "$tmp" || rc=1
    content_hash=$(sha256sum -- "$tmp" | awk '{print $1}') || rc=1
    final="$dir/route-pin.${content_hash}.json"
    [[ "$content_hash" =~ ^[a-f0-9]{64}$ && ! -e "$final" && ! -L "$final" ]] || rc=78
  fi
  if (( rc == 0 )); then
    mv -- "$tmp" "$final" || rc=1
  else
    [[ -z "${tmp:-}" ]] || rm -f -- "$tmp"
  fi
  _attempt_state_unlock "$lock_fd"
  (( rc == 0 )) && printf '%s\n' "$route_hash"
  return "$rc"
}

attempt_state_resume_v2() {
  local task expected=${2:-} root lock_fd attempt dir profile routes catalog
  local terminal_rc route_rc catalog_output route_file route_id route_hash verified_hash rc
  task=$(_attempt_state_task_id "${1:-}") || return
  if [[ -n "$expected" ]]; then
    expected=$(_attempt_state_attempt_id "$expected") || return
  fi
  root=$(attempt_state_v2_task_root "$task") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_state_protocol_locked "$root"
  rc=$?
  if (( rc == 0 )); then
    attempt=$(_attempt_state_require_active_locked "$root" "$task" "$expected")
    rc=$?
  fi
  if (( rc == 0 )); then
    dir=$(_attempt_state_validate_attempt_locked "$root" "$task" "$attempt")
    rc=$?
  fi
  if (( rc == 0 )); then
    profile=$(_attempt_state_json get "$dir/attempt.json" profile) || rc=$?
    routes=$(_attempt_state_json get "$dir/attempt.json" routesDir) || rc=$?
    catalog=$(_attempt_state_json get "$dir/attempt.json" catalogHash) || rc=$?
  fi
  if (( rc == 0 )); then
    _attempt_state_routes_dir "$routes" >/dev/null || rc=78
    _attempt_state_validate_pins_locked \
      "$dir" "$task" "$attempt" "$profile" "$catalog" || rc=$?
  fi
  if (( rc == 0 )); then
    _attempt_state_terminal_locked "$dir" "$task" "$attempt" >/dev/null
    terminal_rc=$?
    (( terminal_rc == 3 )) || {
      (( terminal_rc == 0 )) && rc=75 || rc=$terminal_rc
    }
  fi
  if (( rc == 0 )); then
    route_file=$(_attempt_state_route_pin_locked \
      "$dir" "$task" "$attempt" "$profile" "$catalog")
    route_rc=$?
    (( route_rc == 0 || route_rc == 3 )) || rc=$route_rc
    (( route_rc == 3 )) && route_file=""
  fi
  if (( rc == 0 )); then
    catalog_output=$(mktemp "$root/.catalog.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    "$(_attempt_state_route_tool)" \
      --routes-dir "$routes" \
      --profile "$profile" \
      catalog \
      --catalog-hash "$catalog" >"$catalog_output"
    rc=$?
  fi
  if (( rc == 0 )); then
    _attempt_state_json parse-catalog "$catalog_output" "$profile" "$catalog" || rc=$?
  fi
  [[ -z "${catalog_output:-}" ]] || rm -f -- "$catalog_output"
  if (( rc == 0 )) && [[ -n "$route_file" ]]; then
    route_id=$(_attempt_state_json get "$route_file" routeId) || rc=$?
    route_hash=$(_attempt_state_json get "$route_file" routeHash) || rc=$?
  fi
  if (( rc == 0 )) && [[ -n "$route_file" ]]; then
    verified_hash=$("$(_attempt_state_route_tool)" \
      --routes-dir "$routes" \
      --profile "$profile" \
      route-hash \
      --catalog-hash "$catalog" \
      --route "$route_id")
    rc=$?
    [[ "$verified_hash" == "$route_hash" ]] || rc=78
  fi
  if (( rc == 0 )); then
    _attempt_state_json make-resume "$dir/pins.json" "$route_file"
    rc=$?
  fi
  _attempt_state_unlock "$lock_fd"
  return "$rc"
}

_attempt_state_close_v2() {
  local state=$1 task attempt reason=${4:-} root lock_fd dir terminal_rc=3
  local profile catalog route_pin_rc closed tmp content_hash final rc
  local terminal_state terminal_reason
  task=$(_attempt_state_task_id "${2:-}") || return
  attempt=$(_attempt_state_attempt_id "${3:-}") || return
  if [[ "$state" == abandoned ]]; then
    _attempt_state_reason "$reason" || return
  elif [[ "$state" != finished || -n "$reason" ]]; then
    return 2
  fi
  root=$(attempt_state_v2_task_root "$task") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_state_protocol_locked "$root"
  rc=$?
  if (( rc == 0 )); then
    _attempt_state_require_active_locked "$root" "$task" "$attempt" >/dev/null
    rc=$?
  fi
  if (( rc == 0 )); then
    dir=$(_attempt_state_validate_attempt_locked "$root" "$task" "$attempt")
    rc=$?
  fi
  if (( rc == 0 )); then
    profile=$(_attempt_state_json get "$dir/attempt.json" profile) || rc=$?
    catalog=$(_attempt_state_json get "$dir/attempt.json" catalogHash) || rc=$?
  fi
  if (( rc == 0 )); then
    _attempt_state_validate_pins_locked \
      "$dir" "$task" "$attempt" "$profile" "$catalog" || rc=$?
  fi
  if (( rc == 0 )); then
    _attempt_state_route_pin_locked \
      "$dir" "$task" "$attempt" "$profile" "$catalog" >/dev/null
    route_pin_rc=$?
    if (( route_pin_rc == 3 )); then
      # Abandon допустим ещё во время bootstrap, successful finish — только
      # после одноразового выбора route из pinned catalog.
      [[ "$state" == abandoned ]] || rc=73
    elif (( route_pin_rc != 0 )); then
      rc=$route_pin_rc
    fi
  fi
  if (( rc == 0 )); then
    final=$(_attempt_state_terminal_locked "$dir" "$task" "$attempt")
    terminal_rc=$?
    if (( terminal_rc == 0 )); then
      # Durable terminal мог появиться до crash, а mutable active pointer остаться.
      # Совпадающий повтор close завершает только CAS-cleanup; другой terminal
      # нельзя переинтерпретировать новым outcome/reason.
      terminal_state=$(_attempt_state_json get "$final" state) || rc=$?
      terminal_reason=$(_attempt_state_json get "$final" reason) || rc=$?
      [[ "$terminal_state" == "$state" && "$terminal_reason" == "$reason" ]] || rc=73
    elif (( terminal_rc != 3 )); then
      rc=$terminal_rc
    fi
  fi
  if (( rc == 0 && terminal_rc == 3 )); then
    closed=$(date -u +%Y-%m-%dT%H:%M:%SZ) || rc=1
    tmp=$(mktemp "$dir/.terminal.XXXXXX") || rc=1
  fi
  if (( rc == 0 && terminal_rc == 3 )); then
    _attempt_state_json make-terminal \
      "$attempt" "$task" "$state" "$closed" "$reason" >"$tmp" || rc=$?
  fi
  if (( rc == 0 && terminal_rc == 3 )); then
    chmod 400 "$tmp" || rc=1
    content_hash=$(sha256sum -- "$tmp" | awk '{print $1}') || rc=1
    final="$dir/terminal.${content_hash}.json"
    [[ "$content_hash" =~ ^[a-f0-9]{64}$ && ! -e "$final" && ! -L "$final" ]] || rc=78
  fi
  if (( rc == 0 && terminal_rc == 3 )); then
    mv -- "$tmp" "$final" || rc=1
  elif (( terminal_rc == 3 )); then
    [[ -z "${tmp:-}" ]] || rm -f -- "$tmp"
  fi
  if (( rc == 0 )); then
    _attempt_state_require_active_locked "$root" "$task" "$attempt" >/dev/null
    rc=$?
  fi
  if (( rc == 0 )); then
    rm -- "$root/active-attempt.json" || rc=1
  fi
  _attempt_state_unlock "$lock_fd"
  (( rc == 0 )) && printf '%s\n' "$final"
  return "$rc"
}

attempt_state_finish_v2() {
  _attempt_state_close_v2 finished "${1:-}" "${2:-}" ""
}

attempt_state_abandon_v2() {
  _attempt_state_close_v2 abandoned "${1:-}" "${2:-}" "${3:-}"
}

# Артефакты этапов живут в общем для задачи namespace <state>/t<TASK>.* и переживают
# abandon: новая попытка находила бы на диске выводы предшественницы. Write у CLI
# отказывается перезаписывать файл, который в этой сессии не читали, поэтому SCOUT может
# не переписать чужой t<TASK>.recon.md, принять его за свой и закрыть этап done, а PLAN —
# обойти отказ склейкой и приклеить к свежему плану хвост прошлой попытки с разделами
# SKEPTIC/TRANSLATOR/TCRITIC, которых в этой попытке не было. Поэтому recovery уносит
# их в архив предшественницы: восстановить можно, наткнуться нельзя.
# Движок не знает имён проектных артефактов (бандл их не объявляет), зато знает свои —
# всё остальное в namespace задачи по определению чужой выход этапа.
# Печатает имена унесённых файлов; вызывающий их логирует.
attempt_state_quarantine_artifacts_v2() {
  local task attempt state root vault f base
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  state=${3:-}
  [[ -n "$state" && "$state" == /* && "$state" != *$'\n'* ]] || return 2
  [[ -d "$state" && ! -L "$state" ]] || return 2
  root=$(attempt_state_v2_task_root "$task") || return
  [[ -d "$root/attempts/$attempt" && ! -L "$root/attempts/$attempt" ]] || return 2
  vault="$root/attempts/$attempt/state-artifacts"
  for f in "$state/t${task}."*; do
    [[ -f "$f" && ! -L "$f" ]] || continue
    base=${f##*/}
    case "${base#"t${task}."}" in
      active|env|instrumentation|lock|orch.log|pipeline|pipeline.lock|route) continue ;;
    esac
    mkdir -p "$vault" || return 78
    mv -f -- "$f" "$vault/$base" || return 78
    printf '%s\n' "$base"
  done
  return 0
}

# Какие поля закреплённого контракта попытки разошлись с текущим профилем.
#
# Профиль — локальный код и правится между командами; resume обязан упереться в
# расхождение, иначе активная попытка молча уедет в другой worktree или под другие
# guardrails. Но голый код 75 — тупик: человек видит «нужен человек» и идёт читать
# движок. Возвращаем ИМЕНА разошедшихся полей и только их: значения бывают
# многострочными и длинными (guardrails), а для решения хватает адреса.
#
# Вывод — одна строка для журнала; сам по себе он ничего не решает и не является
# основанием пропустить расхождение.
attempt_state_contract_drift_v2() {
  local pinned_manifest=${1:-} actual_manifest=${2:-} pinned_context=${3:-} actual_context=${4:-}
  local manifest_fields context_fields parts=() joined
  manifest_fields=$(awk -F'\t' '
    FNR == NR { pinned[$1] = pinned[$1] $0 "\n"; next }
    { actual[$1] = actual[$1] $0 "\n" }
    END {
      for (key in pinned) if (pinned[key] != actual[key]) print key
      for (key in actual) if (!(key in pinned)) print key
    }' "$pinned_manifest" "$actual_manifest" 2>/dev/null | sort -u | paste -sd, -)
  context_fields=$(python3 - "$pinned_context" "$actual_context" <<'PY' 2>/dev/null
import json
import sys


def load(path):
    try:
        with open(path, encoding="utf-8") as source:
            return json.load(source)
    except (OSError, ValueError):
        return None


pinned, actual = load(sys.argv[1]), load(sys.argv[2])
if not isinstance(pinned, dict) or not isinstance(actual, dict):
    print("нечитаем" if pinned != actual else "")
else:
    keys = sorted(k for k in set(pinned) | set(actual) if pinned.get(k) != actual.get(k))
    print(",".join(keys))
PY
  )
  [[ -n "$manifest_fields" ]] && parts+=("profile-contract: $manifest_fields")
  [[ -n "$context_fields" ]] && parts+=("project-context: $context_fields")
  (( ${#parts[@]} )) || parts=("расхождение не локализовано")
  printf -v joined '%s; ' "${parts[@]}"
  printf '%s\n' "${joined%'; '}"
}

attempt_state_recover_v2() {
  local task previous reason root lock_fd previous_dir terminal terminal_state
  local active_rc profile routes catalog route_pin_rc previous_schema runner rc
  task=$(_attempt_state_task_id "${1:-}") || return
  previous=$(_attempt_state_attempt_id "${2:-}") || return
  reason=${3:-}
  runner=${4:-}
  _attempt_state_reason "$reason" || return
  root=$(attempt_state_v2_task_root "$task") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_state_protocol_locked "$root"
  rc=$?
  if (( rc == 0 )); then
    _attempt_state_active_id_locked "$root" "$task" >/dev/null
    active_rc=$?
    if (( active_rc == 0 )); then
      rc=73
    elif (( active_rc != 3 )); then
      rc=$active_rc
    fi
  fi
  if (( rc == 0 )); then
    previous_dir=$(_attempt_state_validate_attempt_locked "$root" "$task" "$previous")
    rc=$?
  fi
  if (( rc == 0 )); then
    terminal=$(_attempt_state_terminal_locked "$previous_dir" "$task" "$previous")
    rc=$?
    (( rc == 3 )) && rc=75
  fi
  if (( rc == 0 )); then
    terminal_state=$(_attempt_state_json get "$terminal" state) || rc=$?
    [[ "$terminal_state" == abandoned ]] || rc=75
  fi
  if (( rc == 0 )); then
    profile=$(_attempt_state_json get "$previous_dir/attempt.json" profile) || rc=$?
    routes=$(_attempt_state_json get "$previous_dir/attempt.json" routesDir) || rc=$?
    catalog=$(_attempt_state_json get "$previous_dir/attempt.json" catalogHash) || rc=$?
    previous_schema=$(_attempt_state_json get "$previous_dir/attempt.json" schema) || rc=$?
    if (( rc == 0 && previous_schema == 2 )); then
      # Queue provenance принадлежит единственному launch side effect и никогда
      # не переезжает в recovery. Выбор runner-а, напротив, остаётся фактической
      # task-level политикой нового прогона и берётся из trusted предшественницы.
      runner=$(_attempt_state_json get \
        "$previous_dir/attempt.json" runnerPrimaryOverride) || rc=$?
    fi
    if (( rc == 0 )); then
      runner=$(_attempt_state_runner_override "$runner") || rc=$?
    fi
    _attempt_state_routes_dir "$routes" >/dev/null || rc=78
  fi
  if (( rc == 0 )); then
    _attempt_state_validate_pins_locked \
      "$previous_dir" "$task" "$previous" "$profile" "$catalog" || rc=$?
  fi
  if (( rc == 0 )); then
    _attempt_state_route_pin_locked \
      "$previous_dir" "$task" "$previous" "$profile" "$catalog" >/dev/null
    route_pin_rc=$?
    (( route_pin_rc == 0 || route_pin_rc == 3 )) || rc=$route_pin_rc
  fi
  if (( rc == 0 )); then
    _attempt_state_create_locked \
      "$root" "$task" "$profile" "$routes" recovery "$previous" "$reason" \
      "" "" "$runner"
    rc=$?
  fi
  _attempt_state_unlock "$lock_fd"
  return "$rc"
}
