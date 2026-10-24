#!/usr/bin/env bash
# Доверенный диспетчер неизменяемой попытки route-v2.
#
# Этот файл подключается после профиля проекта и core.sh. Он намеренно не знает,
# как проект формирует типизированный контекст: хостовая обёртка должна предоставить
# `route_v2_context_for_node TASK ATTEMPT NODE RUN_KEY OUTPUT`.
#
# Публичный API:
#   route_v2_dispatch_bootstrap TASK ATTEMPT
#   route_v2_dispatch_next TASK ATTEMPT
#   route_v2_dispatch_until_pause TASK ATTEMPT [MAX_STEPS]
#   route_v2_gate_decide TASK ATTEMPT NODE approved|rejected [REJECT_FEEDBACK]
#   route_v2_work_time TASK ATTEMPT
#
# Коды возврата:
#   0   зафиксирован один узел / цикл достиг запрошенной границы
#   20  пауза на человеческих воротах
#   21  маршрут уже достиг терминальной остановки (включая rewind-limit)
#   75  конфликт доверенного CAS, рабочего дерева или транзакции
#   78  недопустимое или неподдерживаемое состояние исполняющей среды
#
# Обязательный контракт хоста:
#   FACTORY_ROUTE_STATE_DIR — существующий абсолютный каталог, совпадающий с STATE_DIR.
#   route_v2_context_for_node ... записывает обычный типизированный JSON-файл.
#   route_v2_workspace_roots выводит точные корни изолированных рабочих деревьев Git.

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/attempt-stage-state.sh"
source "$FACTORY_HOME/lib/bootstrap-state.sh"
# shellcheck disable=SC1091
source "$FACTORY_HOME/lib/workspace-guard.sh"
# shellcheck disable=SC1091
source "$FACTORY_HOME/lib/instrumentation-transaction.sh"
# shellcheck disable=SC1091
source "$FACTORY_HOME/lib/runtime-analytics.sh"

_route_v2_fail() {
  printf 'route-v2 runtime: %s\n' "$*" >&2
  return 78
}

_route_v2_require_isolation() {
  local declared=${FACTORY_ROUTE_STATE_DIR:-} state=${STATE_DIR:-} canonical
  [[ -n "$declared" && "$declared" == /* && "$declared" == "$state" ]] ||
    _route_v2_fail "FACTORY_ROUTE_STATE_DIR must be explicit and equal STATE_DIR" || return
  [[ -d "$state" && ! -L "$state" ]] ||
    _route_v2_fail "dedicated STATE_DIR is missing or is a symlink" || return
  canonical=$(realpath -e -- "$state" 2>/dev/null) ||
    _route_v2_fail "cannot canonicalize STATE_DIR" || return
  [[ "$canonical" == "$state" && "$canonical" != / ]] ||
    _route_v2_fail "STATE_DIR must be canonical and cannot be /" || return
  factory_control_root >/dev/null ||
    _route_v2_fail "control root overlaps provider-writable state" || return
}

_route_v2_require_runner_invariant() {
  local task=$1
  if declare -F route_v2_runner_invariant >/dev/null; then
    route_v2_runner_invariant "$task" || return 75
  fi
}

_route_v2_json() {
  python3 - "$@" <<'PY'
import json
import os
import re
import stat
import sys

op, path, *args = sys.argv[1:]

def fail():
    raise SystemExit(78)

try:
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        fail()
    with open(path, encoding="utf-8") as source:
        value = json.load(source, parse_constant=lambda _: fail())
except (OSError, UnicodeError, json.JSONDecodeError):
    fail()

if op == "resume":
    if (
        not isinstance(value, dict)
        or value.get("protocolVersion") != 2
        or not isinstance(value.get("profile"), str)
        or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", value["profile"])
        or not re.fullmatch(r"[a-f0-9]{64}", value.get("catalogHash", ""))
    ):
        fail()
    route = value.get("route")
    if (
        not isinstance(route, dict)
        or set(route) != {"id", "hash"}
        or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,40}", route.get("id", ""))
        or not re.fullmatch(r"[a-f0-9]{64}", route.get("hash", ""))
    ):
        fail()
    print(value["profile"], value["catalogHash"], route["id"], route["hash"], sep="\t")
elif op == "bootstrap-policy":
    machine = value.get("machine") if isinstance(value, dict) else None
    if not isinstance(machine, dict) or machine.get("kind") != "route":
        fail()
    policy = machine.get("bootstrap", "required")
    if policy not in ("required", "skip"):
        fail()
    print(policy)
elif op == "loop":
    # Пара режима «цикл» закреплённого маршрута: «ведущий<TAB>исполнитель» либо пустая
    # строка у обычного маршрута. Бандл уже проверен factory-route.
    machine = value.get("machine") if isinstance(value, dict) else None
    if not isinstance(machine, dict):
        fail()
    pair = machine.get("loop")
    if pair is None:
        print("", "", sep="\t")
    else:
        if not isinstance(pair, dict) or set(pair) != {"lead", "worker"}:
            fail()
        for node_id in (pair["lead"], pair["worker"]):
            if not isinstance(node_id, str) or not re.fullmatch(
                r"[a-z0-9][a-z0-9_-]{0,40}", node_id
            ):
                fail()
        print(pair["lead"], pair["worker"], sep="\t")
elif op == "cursor":
    cursor = value
    required = {
        "state", "currentNode", "eventSequence", "profile", "catalogHash",
        "routeId", "routeHash", "attemptId", "taskId",
    }
    if not isinstance(cursor, dict) or not required.issubset(cursor):
        fail()
    state = cursor["state"]
    if state not in {"ready", "paused", "stopped"}:
        fail()
    node = cursor["currentNode"]
    if state == "stopped":
        node = ""
    elif not isinstance(node, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,40}", node):
        fail()
    sequence = cursor["eventSequence"]
    if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 0:
        fail()
    print(state, node, sequence, sep="\t")
elif op == "cursor-stop":
    cursor = value
    required = {"state", "stop", "lastCommit"}
    if not isinstance(cursor, dict) or not required.issubset(cursor):
        fail()
    state = cursor["state"]
    if state not in {"ready", "paused", "stopped"}:
        fail()
    stop = cursor["stop"]
    if stop is not None and stop not in {
        "human", "failed", "done", "rewind-limit", "no-progress", "loop-ceiling"
    }:
        fail()
    last = cursor["lastCommit"]
    last_node = ""
    last_outcome = ""
    if last is not None:
        if not isinstance(last, dict):
            fail()
        last_node = last.get("node") or ""
        last_outcome = last.get("outcome") or ""
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,40}", last_node):
            fail()
        if last_outcome not in {
            "done", "skipped", "failed", "exhausted", "approved", "rejected"
        }:
            fail()
    print(state, stop or "", last_node, last_outcome, sep="\t")
elif op == "node":
    node_id = args[0]
    machine = value.get("machine") if isinstance(value, dict) else None
    nodes = machine.get("nodes") if isinstance(machine, dict) else None
    if not isinstance(nodes, list):
        fail()
    matches = [item for item in nodes if isinstance(item, dict) and item.get("id") == node_id]
    if len(matches) != 1:
        fail()
    node = matches[0]
    executor = node.get("executor")
    run_key = node.get("runKey", "")
    phase = node.get("phase")
    if executor not in {"agent", "command", "gate"}:
        fail()
    if not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", run_key):
        fail()
    if phase not in {"bootstrap", "main", "tail"}:
        fail()
    policy = ""
    fanout_mode = ""
    fanout_max = ""
    fanout_degrade = ""
    browser = "forbid"
    timeout_class = ""
    retry_no_result = ""
    retry_product = ""
    provider_attempts = ""
    provider_strategy = ""
    command_id = ""
    if executor in {"agent", "command"}:
        policy = (node.get("policy") or {}).get("filesystem", "")
        if policy not in {"state-only", "workspace-write", "transactional-write"}:
            fail()
        browser = (node.get("policy") or {}).get("browser", "forbid")
        if browser not in {"forbid", "allow"}:
            fail()
        # Класс времени — необязательное поле бандла: узлы старых ревизий его не
        # объявляли, и им остаётся дефолт движка. Формат совпадает с ENTITY_RE
        # валидатора бандла; здесь проверяем повторно, потому что значение уедет
        # в TAB-контракт и в имя переменной окружения.
        timeout_class = (node.get("policy") or {}).get("timeoutClass", "")
        if timeout_class and not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", timeout_class):
            fail()
        fanout = node.get("fanout")
        retry = node.get("retry")
        if not isinstance(fanout, dict) or not isinstance(retry, dict):
            fail()
        fanout_mode = fanout.get("mode")
        fanout_max = fanout.get("maxExecutors")
        fanout_degrade = fanout.get("degrade")
        provider = retry.get("providerFailure")
        if (
            fanout_mode not in {"single", "parallel"}
            or not isinstance(fanout_max, int) or isinstance(fanout_max, bool)
            or not 1 <= fanout_max <= 64
            or fanout_degrade not in {"forbid", "allow-single"}
            or not isinstance(provider, dict)
        ):
            fail()
        retry_no_result = retry.get("noResult")
        retry_product = retry.get("productFailure")
        provider_attempts = provider.get("attempts")
        provider_strategy = provider.get("strategy")
        for count in (retry_no_result, retry_product, provider_attempts):
            if not isinstance(count, int) or isinstance(count, bool) or not 0 <= count <= 10:
                fail()
        if provider_strategy not in {"none", "same-runner", "runner-failover"}:
            fail()
        if executor == "command":
            command_id = node.get("commandId", "")
            if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,40}", command_id):
                fail()
    print(executor, phase, run_key, policy, fanout_mode, fanout_max, fanout_degrade,
          retry_no_result, retry_product, provider_attempts, provider_strategy,
          browser, timeout_class, command_id, sep="\t")
elif op == "gate-feedback-target":
    node_id = args[0]
    machine = value.get("machine") if isinstance(value, dict) else None
    nodes = machine.get("nodes") if isinstance(machine, dict) else None
    if not isinstance(nodes, list):
        fail()
    matches = [item for item in nodes if isinstance(item, dict) and item.get("id") == node_id]
    if len(matches) != 1 or matches[0].get("executor") != "gate":
        fail()
    on = matches[0].get("on")
    transition = on.get("rejected") if isinstance(on, dict) else None
    if not isinstance(transition, dict):
        fail()
    modes = set(transition) & {"next", "rewind", "stop", "escalate"}
    if len(modes) != 1:
        fail()
    mode = next(iter(modes))
    if mode not in {"next", "rewind"}:
        print(mode)
    else:
        target = transition.get(mode)
        target_matches = [
            item for item in nodes
            if isinstance(item, dict) and item.get("id") == target
        ]
        if len(target_matches) != 1:
            fail()
        executor = target_matches[0].get("executor")
        if executor not in {"agent", "command", "gate"}:
            fail()
        print(mode, target, executor, sep="\t")
elif op == "work-time":
    # Join pinned describe-route (value) со сводкой work-time из журнала: работа
    # узлов без ворот отдельно от ожидания ворот. Классификация — по executor
    # бандла, а не по имени узла; узел журнала вне машины маршрута = порча.
    (ledger_path,) = args
    try:
        info = os.lstat(ledger_path)
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            fail()
        with open(ledger_path, encoding="utf-8") as source:
            ledger = json.load(source, parse_constant=lambda _: fail())
    except (OSError, UnicodeError, json.JSONDecodeError):
        fail()
    machine = value.get("machine") if isinstance(value, dict) else None
    nodes = machine.get("nodes") if isinstance(machine, dict) else None
    if not isinstance(nodes, list):
        fail()
    executors = {}
    for item in nodes:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            fail()
        if item["id"] in executors or item.get("executor") not in {
            "agent", "command", "gate", "status",
        }:
            fail()
        executors[item["id"]] = item["executor"]
    if (
        not isinstance(ledger, dict)
        or ledger.get("schema") != 1
        or not isinstance(ledger.get("nodes"), dict)
    ):
        fail()
    last_event_at = ledger.get("lastEventAt")
    if last_event_at is not None and (
        not isinstance(last_event_at, int)
        or isinstance(last_event_at, bool)
        or last_event_at < 0
    ):
        fail()
    work = 0
    gate = 0
    for node_id, seconds in ledger["nodes"].items():
        # Узел-статус — проекция чужого результата, он никогда не исполняется и
        # не коммитится: интервал на его имени = порча журнала, не «работа».
        if (
            node_id not in executors
            or executors[node_id] == "status"
            or not isinstance(seconds, int)
            or isinstance(seconds, bool)
            or seconds < 0
        ):
            fail()
        if executors[node_id] == "gate":
            gate += seconds
        else:
            work += seconds
    print(work, gate, last_event_at or 0, sep="\t")
else:
    fail()
PY
}

_route_v2_gate_feedback_guard() {
  local description=$1 node=$2 feedback=${3:-} mode target executor
  [[ -n "$feedback" ]] || return 0
  IFS=$'\t' read -r mode target executor \
    < <(_route_v2_json gate-feedback-target "$description" "$node") || return
  if [[ ( "$mode" == rewind || "$mode" == next ) && "$executor" != agent ]]; then
    _route_v2_fail \
      "комментарий rejected нельзя доставить: $mode ведёт в $target (executor=$executor), нужен agent" || return
  fi
  return 0
}

_route_v2_active_result() {
  local file=$1 mode=${2:-result}
  python3 - "$file" "$mode" <<'PY'
import base64
import os
import re
import stat
import sys

path, mode = sys.argv[1:]
try:
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        raise ValueError
    with os.fdopen(fd, encoding="utf-8", closefd=True) as source:
        lines = source.read().splitlines()
except (OSError, UnicodeError, ValueError):
    raise SystemExit(78)

fields = {}
for line in lines:
    if "=" not in line:
        raise SystemExit(78)
    key, field = line.split("=", 1)
    if key in fields:
        raise SystemExit(78)
    fields[key] = field
required = {"SCHEMA", "RUN_ID", "EPOCH", "TOKEN_HASH", "STATE", "RESULT"}
optional = {"COMMENT", "VERDICT_B64"}
if mode == "execution" and fields.get("STATE") == "active":
    fields.setdefault("RESULT", "")
if not required.issubset(fields) or not set(fields).issubset(required | optional):
    raise SystemExit(78)
if (
    fields["SCHEMA"] != "1"
    or (fields["STATE"], fields["RESULT"]) not in {
        ("committed", "done"), ("committed", "skipped"), ("committed", "failed"),
        *(([("active", "")] if mode == "execution" else [])),
    }
    or not re.fullmatch(r"[A-Za-z0-9._-]+", fields["RUN_ID"])
    or not re.fullmatch(r"[0-9]+", fields["EPOCH"])
    or not re.fullmatch(r"[a-f0-9]{64}", fields["TOKEN_HASH"])
):
    raise SystemExit(78)
encoded = fields.get("VERDICT_B64", "")
if encoded and not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", encoded):
    raise SystemExit(78)
parts = [fields["RESULT"] or "no-result", fields["RUN_ID"], encoded or "-"]
if mode in ("identity", "execution"):
    parts.extend([fields["EPOCH"], base64.b64encode(fields.get("COMMENT", "").encode()).decode() or "-"])
print(*parts, sep="\t")
PY
}

_route_v2_require_delivery_context() {
  local context=$1 node=$2
  python3 - "$context" "$node" "$FACTORY_HOME/lib" <<'PY'
import json
import os
import stat
import sys

path, node, library = sys.argv[1:]
sys.dont_write_bytecode = True
sys.path.insert(0, library)
from delivery_contract import validate as validate_strategy
try:
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        raise ValueError
    with os.fdopen(fd, encoding="utf-8", closefd=True) as source:
        value = json.load(source, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
    raise SystemExit(78)

if not isinstance(value, dict):
    raise SystemExit(78)
delivery = value.get("delivery")
if not isinstance(delivery, dict) or delivery.get("mode") not in {"disabled", "publish"}:
    raise SystemExit(78)
actions = delivery.get("actions")
targets = delivery.get("targetBranches")
allowed_actions = {"commit", "push", "pull-request", "task-comment"}
strategy = delivery.get("strategy")
if strategy is not None:
    try:
        validate_strategy(strategy, actions)
    except (ValueError, TypeError):
        raise SystemExit(78)
    allowed_actions.add("merge")
if (
    not isinstance(actions, list)
    or any(not isinstance(action, str) for action in actions)
    or len(actions) != len(set(actions))
    or any(action not in allowed_actions for action in actions)
    or not isinstance(targets, dict)
    or any(
        not isinstance(repo, str)
        or not isinstance(branch, str)
        or not repo
        or not branch
        for repo, branch in targets.items()
    )
):
    raise SystemExit(78)

if node == "ship":
    acceptance = value.get("decisions", {}).get("acceptance")
    if isinstance(acceptance, dict):
        acceptance = acceptance.get("status")
    if (
        delivery["mode"] != "publish"
        or acceptance != "approved"
        or (strategy is None and not {"commit", "push", "pull-request"}.issubset(actions))
        or not targets
    ):
        raise SystemExit(78)
PY
}

# Проверка и запись bootstrap используют один reader, включая findings exporter.
# Версия checkpoint сохраняет прежние свидетельства без реконструкции из active.
_route_v2_bootstrap_record() {
  local op=$1 path=$2 task=$3 attempt=$4 profile=$5 catalog=$6 route=$7 route_hash=$8
  shift 8
  python3 "$FACTORY_HOME/lib/bootstrap_state.py" "$op" "$path" \
    "$task" "$attempt" "$profile" "$catalog" "$route" "$route_hash" \
    "$ROUTE_V2_ROUTES_DIR" "$@"
}

_route_v2_load_attempt() {
  local task=$1 attempt=$2 tmp root attempt_dir routes control
  control=$(factory_control_root) || return
  tmp=$(mktemp "$control/.route-v2-resume.XXXXXX") || return 1
  attempt_state_resume_v2 "$task" "$attempt" >"$tmp" || {
    local rc=$?
    rm -f -- "$tmp"
    return "$rc"
  }
  IFS=$'\t' read -r ROUTE_V2_PROFILE ROUTE_V2_CATALOG ROUTE_V2_ROUTE ROUTE_V2_ROUTE_HASH \
    < <(_route_v2_json resume "$tmp") || {
      rm -f -- "$tmp"
      return 78
    }
  rm -f -- "$tmp"
  root=$(attempt_state_v2_task_root "$task") || return
  attempt_dir="$root/attempts/$attempt"
  routes=$(_attempt_state_json get "$attempt_dir/attempt.json" routesDir) || return
  _attempt_state_routes_dir "$routes" >/dev/null || return 78
  ROUTE_V2_ROUTES_DIR=$routes
  ROUTE_V2_ATTEMPT_DIR=$attempt_dir
  export ROUTE_V2_PROFILE ROUTE_V2_CATALOG ROUTE_V2_ROUTE ROUTE_V2_ROUTE_HASH \
    ROUTE_V2_ROUTES_DIR ROUTE_V2_ATTEMPT_DIR
}

_route_v2_lifecycle_stage_edge() {
  local task=$1 attempt=$2 sequence=$3 event_file hash kind outcome action reason transition
  if [[ "$sequence" == 0 ]]; then
    printf 'initial\t\t\n'
    return 0
  fi
  event_file=$(mktemp "$(factory_control_root)/.route-v2-lifecycle-edge.XXXXXX") || return 1
  attempt_stage_state_latest_event_v2 "$task" "$attempt" >"$event_file" || {
    local rc=$?
    rm -f -- "$event_file"
    return "$rc"
  }
  hash=$(sha256sum -- "$event_file" | awk '{print $1}') || {
    rm -f -- "$event_file"; return 78;
  }
  kind=$(runtime_analytics_json_get_v2 "$event_file" kind 2>/dev/null || true)
  outcome=$(runtime_analytics_json_get_v2 "$event_file" outcome 2>/dev/null || true)
  action=$(runtime_analytics_json_get_v2 "$event_file" action.rewind 2>/dev/null || true)
  if [[ "$kind" == human-rewind ]]; then
    reason=human_rewind
  elif [[ -n "$action" && "$outcome" == rejected ]]; then
    reason=gate_rejected
  elif [[ -n "$action" ]]; then
    reason=route_rewind
  else
    reason=forward_transition
  fi
  transition="tr_${hash:0:32}"
  rm -f -- "$event_file"
  printf '%s\t%s\t%s\n' "$reason" "$transition" "$hash"
}

_route_v2_lifecycle_finish_visit_after_commit() {
  local task=$1 attempt=$2 outcome=$3 event_file hash action rewind transition exit_kind
  local status=succeeded reason=normal
  runtime_lifecycle_enabled_v2 || return 0
  [[ -n "${FACTORY_LIFECYCLE_NODE_VISIT_ID:-}" ]] || return 78
  event_file=$(mktemp "$(factory_control_root)/.route-v2-lifecycle-commit.XXXXXX") || return 1
  attempt_stage_state_latest_event_v2 "$task" "$attempt" >"$event_file" || {
    local rc=$?
    rm -f -- "$event_file"
    return "$rc"
  }
  hash=$(sha256sum -- "$event_file" | awk '{print $1}') || {
    rm -f -- "$event_file"; return 78;
  }
  action=$(runtime_analytics_json_get_v2 "$event_file" action.next 2>/dev/null || true)
  rewind=$(runtime_analytics_json_get_v2 "$event_file" action.rewind 2>/dev/null || true)
  transition="tr_${hash:0:32}"
  if [[ -n "${ROUTE_V2_GATE_DECISION:-}" ]]; then
    local feedback_hash=""
    [[ -z "${ROUTE_V2_GATE_FEEDBACK:-}" ]] || \
      feedback_hash=$(runtime_analytics_hash_string_v2 "$ROUTE_V2_GATE_FEEDBACK") || {
        rm -f -- "$event_file"
        return 78
      }
    runtime_lifecycle_gate_decided_v2 \
      "$FACTORY_LIFECYCLE_NODE_ID" "$ROUTE_V2_GATE_DECISION" "$hash" \
      "$feedback_hash" "$transition" "$hash" >/dev/null || {
        rm -f -- "$event_file"
        return
      }
  fi
  if [[ -n "$action" ]]; then
    exit_kind=forward_transition
  elif [[ -n "$rewind" && "$outcome" == rejected ]]; then
    exit_kind=gate_rejected
  elif [[ -n "$rewind" ]]; then
    exit_kind=route_rewind
  else
    exit_kind=attempt_terminal
  fi
  case "$outcome" in
    failed) status=failed; reason=product_failure ;;
    exhausted) status=failed; reason=exhausted ;;
  esac
  rm -f -- "$event_file"
  runtime_lifecycle_node_visit_finish_v2 "$status" "$reason" "$exit_kind" \
    "$transition" "$hash" >/dev/null
}

_route_v2_lifecycle_gate_wait_after_pause() {
  local task=$1 attempt=$2 gate=$3 event_file hash sequence kind rc
  runtime_lifecycle_enabled_v2 || return 0
  event_file=$(mktemp "$(factory_control_root)/.route-v2-lifecycle-gate.XXXXXX") || return 1
  attempt_stage_state_latest_event_v2 "$task" "$attempt" >"$event_file" || {
    rc=$?
    rm -f -- "$event_file"
    return "$rc"
  }
  hash=$(sha256sum -- "$event_file" | awk '{print $1}') || rc=$?
  sequence=$(runtime_analytics_json_get_v2 "$event_file" sequence) || rc=$?
  kind=$(runtime_analytics_json_get_v2 "$event_file" kind) || rc=$?
  rm -f -- "$event_file"
  (( ${rc:-0} == 0 )) || return "$rc"
  [[ "$kind" == pause && "$sequence" =~ ^[1-9][0-9]*$ && "$hash" =~ ^[a-f0-9]{64}$ ]] ||
    return 78
  runtime_lifecycle_gate_wait_begin_v2 "$gate" "$sequence" "$hash" >/dev/null
}

_route_v2_workspace_roots_array() {
  declare -F route_v2_workspace_roots >/dev/null ||
    _route_v2_fail "route_v2_workspace_roots hook is missing" || return
  local root canonical
  ROUTE_V2_ROOTS=()
  while IFS= read -r root || [[ -n "$root" ]]; do
    [[ -n "$root" && "$root" == /* && -d "$root" && ! -L "$root" ]] || return 78
    canonical=$(realpath -e -- "$root" 2>/dev/null) || return 78
    [[ "$canonical" == "$root" ]] || return 78
    root=$(workspace_guard_repo_root "$root" 2>/dev/null) || return 78
    [[ "$root" == "$canonical" ]] || return 78
    ROUTE_V2_ROOTS+=("$root")
  done < <(route_v2_workspace_roots)
  (( ${#ROUTE_V2_ROOTS[@]} > 0 )) || return 78
}

# Fail-closed: parallel fanout разрешён только read-only agent-узлам. Фактическую
# capability/degrade проверяет multi-runner против выбранного provider: forbid требует
# native fanout, allow-single явно превращается в последовательный разбор одним агентом.
# Command исполняется один раз доверенным hook и потому всегда single.
_route_v2_node_caps_guard() {
  local executor=$1 policy=$2 fanout_mode=$3 fanout_max=$4 fanout_degrade=$5
  local provider_strategy=$6
  [[ "$executor" != gate ]] || return 0
  case "$fanout_mode:$fanout_max:$fanout_degrade" in
    single:1:forbid) ;;
    parallel:*:forbid|parallel:*:allow-single)
      [[ "$executor" == agent && "$policy" == state-only &&
         "$fanout_max" =~ ^([2-9]|1[0-6])$ ]] || {
        _route_v2_fail \
          "parallel fanout разрешён только state-only agent (получено ${executor}/${policy}/${fanout_max})" || return
      }
      ;;
    *)
      _route_v2_fail \
        "недопустимая fanout policy ${fanout_mode}/${fanout_max}/${fanout_degrade}" || return
      ;;
  esac
  if [[ "$provider_strategy" == same-runner ]]; then
    _route_v2_fail \
      "retry strategy same-runner is not implemented (failover is chain-based)" || return
  fi
  return 0
}

# Узел зажигается на доске в момент ВХОДА, а не когда стартовал раннер. До старта успевает
# пройти вечность: рендер промпта, открытие инструментальной транзакции и снимок обоих рабочих
# деревьев. Пока статус оставался pending, доска показывала конвейер замершим на ПРОШЛОМ узле —
# это читалось как «всё встало», хотя движок в это время считал хеши. Поэтому маршрутный
# runtime выставляет running перед run_agent.
#
# run_state_begin выставит running ещё раз, уже вместе с раннером и эпохой: статус узла и
# владение запуском — разные вещи, конкуренции тут нет. Провал пометки узел не валит: это
# витрина, а протокол напишет своё через полсекунды и сам решит, можно ли запускаться.
_route_v2_mark_node_running() {
  local task=$1 node=$2 run_key=$3
  if declare -F run_state_control_update >/dev/null; then
    run_state_control_update "$task" "$run_key" running || true
  fi
  declare -F v2_log >/dev/null && v2_log "узел $node: подготовка к исполнению"
  return 0
}

# Число заходов узла словами — «3 захода», «5 заходов». Идёт в комментарий остановки,
# который человек читает в карточке, поэтому падеж обязан быть правильным.
_route_v2_runs_phrase() {
  local n=$1 word=заходов

  if (( n % 10 == 1 && n % 100 != 11 )); then
    word=заход
  elif (( n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) )); then
    word=захода
  fi
  printf '%s %s' "$n" "$word"
}

# Класс исхода раннера — человеку. Словарь классов живёт в runners/policy.sh; незнакомое
# имя показывается как есть, а не прячется за общим словом.
_route_v2_no_result_label() {
  case "${1:-}" in
    timeout) printf 'убит по лимиту времени этапа' ;;
    missing_status) printf 'не выставил статус' ;;
    crashed) printf 'процесс упал' ;;
    '') printf 'результат не зафиксирован' ;;
    *) printf '%s' "$1" ;;
  esac
}

# Ledger остаётся единственным управляющим состоянием. После его успешного CAS
# хост может синхронно обновить вторичную UI-проекцию из последнего проверенного
# события. Ошибка проекции останавливает dispatch: следующий resume прочитает то
# же immutable событие и безопасно повторит reset до запуска очередного узла.
_route_v2_commit_and_project() {
  local task=$1 attempt=$2 node=$3 outcome=$4 rewind_limit=${5:-0}
  local verdict_b64=${6:-} no_progress_limit=${7:-0} recovery=${8:-0}
  local target_budget=${9:-0} reject_feedback=${10:-} loop_max_rounds=${11:-0} cursor rc
  local expected_sequence=${12:-} expected_hash=${13:-}
  cursor=$(attempt_stage_state_commit_v2 \
    "$task" "$attempt" "$node" "$outcome" "$rewind_limit" \
    "$verdict_b64" "$no_progress_limit" "$recovery" "$target_budget" \
    "$reject_feedback" "$loop_max_rounds" "$expected_sequence" "$expected_hash") || return
  _route_v2_lifecycle_finish_visit_after_commit "$task" "$attempt" "$outcome" || return
  if declare -F route_v2_project_latest_reset >/dev/null; then
    route_v2_project_latest_reset "$task" "$attempt" || {
      rc=$?
      _route_v2_fail "route projection failed after committed ledger event (code $rc)" || true
      return "$rc"
    }
  fi
  if declare -F route_v2_project_work_time >/dev/null; then
    # Витрина таймера: ошибка пересчёта не останавливает маршрут.
    route_v2_project_work_time "$task" "$attempt" || true
  fi
  if (( loop_max_rounds > 0 )) && declare -F route_v2_project_loop >/dev/null; then
    # Витрина цикла (круг, этап, потолок, последний отчёт) и снятие записи с отчёта
    # исполнителя: следующий визит пишет свой отчёт, прошлый остаётся доказательством.
    route_v2_project_loop "$task" "$attempt" "$node" "$outcome" || true
  fi
  printf '%s\n' "$cursor"
}

# Потолок кругов режима «цикл» из профиля — снимок на процесс оркестратора: профиль
# читается при start/resume. Нет строки — 20; каноническое целое 1..300 — заданный
# потолок; пустое значение, 0, 301, дробь и мусор — отказ до запуска модели, чтобы
# опечатка в профиле не превратилась в молчаливое значение по умолчанию.
route_v2_loop_max_rounds() {
  if [[ -z "${PROFILE_LOOP_MAX_ROUNDS+set}" ]]; then
    printf '20\n'
    return 0
  fi
  if [[ "$PROFILE_LOOP_MAX_ROUNDS" =~ ^([1-9][0-9]?|[12][0-9]{2}|300)$ ]]; then
    printf '%s\n' "$PROFILE_LOOP_MAX_ROUNDS"
    return 0
  fi
  _route_v2_fail \
    "PROFILE_LOOP_MAX_ROUNDS: нужно целое 1..300, в профиле «${PROFILE_LOOP_MAX_ROUNDS}»"
}

# Проверка resume ДО любых побочных эффектов: остановка `loop-ceiling`, а потолок
# профиля не поднят (или испорчен). Такой resume обязан отказать раньше, чем откроется
# сессия lifecycle, закроется вмешательство человека, снимется STALLED_HUMAN и поедет
# разведка стенда: иначе журнал попытки стоит на остановке, а реестр и lifecycle уже
# говорят «продолжено», и GrigDesk после выхода демона принимает ожидание человека за
# падение. Только чтение. Код 11 — потолок не поднят, 78 — потолок профиля испорчен
# (причина — в журнал этапов); 0 — это не такая остановка или потолок поднят. Курсор,
# который ещё не читается, — не повод отказывать: строгую проверку сделает общий путь.
route_v2_loop_ceiling_held() {
  local task attempt cursor_tmp event_tmp state stop last_node last_outcome kind rounds
  local max_rounds
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  _route_v2_load_attempt "$task" "$attempt" || return
  cursor_tmp=$(mktemp "$(factory_control_root)/.route-v2-cursor.XXXXXX") || return 1
  if ! attempt_stage_state_read_v2 "$task" "$attempt" >"$cursor_tmp" 2>/dev/null ||
     ! IFS=$'\t' read -r state stop last_node last_outcome \
       < <(_route_v2_json cursor-stop "$cursor_tmp" 2>/dev/null); then
    rm -f -- "$cursor_tmp"
    return 0
  fi
  rm -f -- "$cursor_tmp"
  [[ "$state" == stopped && "$stop" == loop-ceiling ]] || return 0
  max_rounds=$(route_v2_loop_max_rounds 2>&1) || {
    declare -F v2_log >/dev/null && v2_log "${last_node^^}: ${max_rounds#route-v2 runtime: }" \
      "— задача остаётся на остановке по потолку кругов"
    return 78
  }
  event_tmp=$(mktemp "$(factory_control_root)/.route-v2-loop-ceiling.XXXXXX") || return 1
  attempt_stage_state_latest_event_v2 "$task" "$attempt" >"$event_tmp" 2>/dev/null || {
    rm -f -- "$event_tmp"
    return 0
  }
  kind=$(runtime_analytics_json_get_v2 "$event_tmp" kind 2>/dev/null) || kind=""
  rounds=$(runtime_analytics_json_get_v2 "$event_tmp" loop.roundsBefore 2>/dev/null) || rounds=""
  rm -f -- "$event_tmp"
  [[ "$kind" == loop-ceiling && "$rounds" =~ ^[0-9]+$ ]] || return 0
  (( max_rounds > rounds )) && return 0
  declare -F v2_log >/dev/null && v2_log \
    "${last_node^^}: потолок кругов цикла не поднят (PROFILE_LOOP_MAX_ROUNDS=${max_rounds})" \
    "— задача остаётся на остановке"
  return 11
}

# Провал и защитные остановки требуют явного goto с новой гипотезой: resume не
# открывает новый визит и не может повторно открыть вмешательство человека.
# Только чтение до lifecycle и подготовки стенда; 11 означает удержание остановки,
# 0 — остальные случаи. Непрочитанный курсор проверит общий строгий путь resume.
route_v2_failed_stop_held() {
  local task attempt cursor_tmp state stop last_node last_outcome

  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  _route_v2_load_attempt "$task" "$attempt" || return
  cursor_tmp=$(mktemp "$(factory_control_root)/.route-v2-cursor.XXXXXX") || return 1

  if ! attempt_stage_state_read_v2 "$task" "$attempt" >"$cursor_tmp" 2>/dev/null ||
     ! IFS=$'\t' read -r state stop last_node last_outcome \
       < <(_route_v2_json cursor-stop "$cursor_tmp" 2>/dev/null); then
    rm -f -- "$cursor_tmp"
    return 0
  fi

  rm -f -- "$cursor_tmp"
  [[ "$state" == stopped && -n "$last_node" ]] || return 0

  case "$stop" in
    human)
      [[ "$last_outcome" == failed ]] || return 0
      ;;
    rewind-limit|no-progress)
      ;;
    *)
      return 0
      ;;
  esac

  if declare -F v2_log >/dev/null; then
    v2_log "${last_node^^}: маршрут остановлен: $stop" \
      "— сначала вернись на узел через «перейти сюда» (goto) с новой гипотезой"
  fi

  return 11
}

# Продолжение цикла после поднятого потолка кругов — только из resume человека.
# Остановка `loop-ceiling` исполняет ТОТ ЖЕ кандидат ведущего, если потолок профиля
# теперь больше числа исполненных кругов: это не human-rewind, серия сторожей, находки
# и счёт кругов не обнуляются. Печатает узел, куда ушёл курсор; пустой вывод и код 0 —
# это не остановка по потолку. Код 11 — потолок не поднят: в журнал уходит подсказка,
# событие не пишется, и продолжать диспетчер вызывающему нечем.
route_v2_continue_loop_ceiling() {
  local task attempt cursor_tmp event_tmp state stop last_node last_outcome
  local sequence hash max_rounds target rc
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  _route_v2_load_attempt "$task" "$attempt" || return
  cursor_tmp=$(mktemp "$(factory_control_root)/.route-v2-cursor.XXXXXX") || return 1
  attempt_stage_state_read_v2 "$task" "$attempt" >"$cursor_tmp" || {
    rc=$?
    rm -f -- "$cursor_tmp"
    return "$rc"
  }
  IFS=$'\t' read -r state stop last_node last_outcome \
    < <(_route_v2_json cursor-stop "$cursor_tmp") || {
      rm -f -- "$cursor_tmp"
      return 78
    }
  rm -f -- "$cursor_tmp"
  [[ "$state" == stopped && "$stop" == loop-ceiling ]] || return 0
  max_rounds=$(route_v2_loop_max_rounds) || return 78
  event_tmp=$(mktemp "$(factory_control_root)/.route-v2-loop-ceiling.XXXXXX") || return 1
  attempt_stage_state_latest_event_v2 "$task" "$attempt" >"$event_tmp" || {
    rc=$?
    rm -f -- "$event_tmp"
    return "$rc"
  }
  sequence=$(runtime_analytics_json_get_v2 "$event_tmp" sequence) || sequence=""
  target=$(runtime_analytics_json_get_v2 "$event_tmp" action.rewind) || target=""
  hash=$(sha256sum -- "$event_tmp" | awk '{print $1}') || hash=""
  rm -f -- "$event_tmp"
  [[ "$sequence" =~ ^[1-9][0-9]*$ && "$hash" =~ ^[a-f0-9]{64}$ && -n "$target" ]] ||
    return 78
  attempt_stage_state_loop_continue_v2 \
    "$task" "$attempt" "$max_rounds" "$sequence" "$hash" >/dev/null
  rc=$?
  if (( rc == 11 )); then
    declare -F v2_log >/dev/null && v2_log \
      "${last_node^^}: потолок кругов цикла не поднят (PROFILE_LOOP_MAX_ROUNDS=${max_rounds})" \
      "— задача остаётся на остановке"
    return 11
  fi
  (( rc == 0 )) || return "$rc"
  printf '%s\n' "$target"
}

# Runtime-пути проверочного инструментария, объявленные профилем (см. PROFILE-CONTRACT,
# `profile_route_volatile_paths`): untracked-файлы под ними сторож state-only не считает.
# Список пишется рядом со снимком — по нему видно, с каким объявлением снимок снимался.
# Путь вне закреплённых рабочих деревьев — ошибка профиля, и она fail-closed (78):
# послабление, которое дотягивается до чужого репозитория, хуже отсутствия послабления.
_route_v2_guard_volatile_list() {
  local output=$1 declared path root inside
  : >"$output" || return 1
  declare -F route_v2_volatile_paths >/dev/null || return 0
  # Подстановка, а не пайп: отказ хука обязан остановить снимок, а у process
  # substitution код возврата не забрать — частичный список прошёл бы за полный.
  declared=$(route_v2_volatile_paths) || return 78
  while IFS= read -r path || [[ -n "$path" ]]; do
    [[ -n "$path" ]] || continue
    [[ "$path" == /* && "$path" != */../* && "$path" != */.. && "$path" != */ ]] ||
      return 78
    inside=0
    for root in "${ROUTE_V2_ROOTS[@]}"; do
      [[ "$path" == "$root/"* ]] && { inside=1; break; }
    done
    (( inside )) || return 78
    printf '%s\n' "$path" >>"$output" || return 1
  done <<<"$declared"
}

_route_v2_guard_snapshot() {
  local task=$1 attempt=$2 node=$3 sequence=$4 side=$5
  local dir output sensitive volatile
  _route_v2_workspace_roots_array || return
  dir="$(factory_control_root)/guards-v2/t${task}/${attempt}/${node}"
  mkdir -p -- "$dir" || return 1
  [[ -d "$dir" && ! -L "$dir" ]] || return 78
  output="$dir/sequence-${sequence}.${side}.tsv"
  sensitive="$dir/sequence-${sequence}.sensitive.list"
  volatile="$dir/sequence-${sequence}.volatile.list"
  : >"$sensitive" || return 1
  if declare -F route_v2_sensitive_files >/dev/null; then
    route_v2_sensitive_files | awk '/^\// && !seen[$0]++' >"$sensitive" || return 1
  fi
  _route_v2_guard_volatile_list "$volatile" || return
  WORKSPACE_GUARD_SENSITIVE_LIST_FILE="$sensitive" \
  WORKSPACE_GUARD_VOLATILE_LIST_FILE="$volatile" \
    workspace_guard_snapshot "$output" "${ROUTE_V2_ROOTS[@]}" || return
  printf '%s\n' "$output"
}

# Сверка снимков state-only узла. Расхождение — fail-closed 75, но с причиной в журнале:
# раньше сюда писался только `.diff` из base64, а stages.log получал голое «код 75». Три
# задачи подряд вставали на одном и том же переписанном прогоном e2e storage state, и
# каждый раз человек заново раскапывал снимки руками. Сводка — только вид записи и каталог
# с числом файлов, без хешей и содержимого (см. workspace_guard_diff_paths).
_route_v2_guard_verify() {
  local run_key=$1 node=$2 before=$3 after=$4 summary line headline
  workspace_guard_compare "$before" "$after" && return 0
  workspace_guard_diff_summary "$before" "$after" >"${after%.tsv}.diff" 2>/dev/null || true
  declare -F v2_log >/dev/null || return 75
  summary=$(workspace_guard_diff_paths "$before" "$after" 12 2>/dev/null) || summary=""
  headline=$(printf '%s\n' "$summary" | head -n 3 | paste -sd ';' - | sed 's/;/; /g')
  v2_log "$run_key: сторож state-only: узел $node изменил рабочее дерево — ${headline:-снимки разошлись}"
  while IFS= read -r line; do
    [[ -n "$line" ]] && v2_log "  изменено: $line"
  done <<<"$summary"
  v2_log "  runtime-артефакт проверки (storage state, скриншоты) объявляют в" \
    "profile_route_volatile_paths или .gitignore проекта; правку агента возвращают узлу с указанием"
  return 75
}

_route_v2_transaction_active_id() {
  local task=$1 active
  active="$(instrumentation_tx_root "$task")/active.env"
  [[ -f "$active" && ! -L "$active" ]] || return 3
  _instrumentation_tx_get "$active" TRANSACTION_ID
}

_route_v2_transaction_before() {
  local task=$1 attempt=$2 node=$3 sequence=$4 txid scope isolation
  txid=$(_route_v2_transaction_active_id "$task")
  local active_rc=$?
  if [[ "$node" != proof && $active_rc -eq 3 ]]; then
    scope=${ROUTE_V2_INSTRUMENTATION_SCOPE_FILE:-}
    [[ -n "$scope" && -f "$scope" && ! -L "$scope" ]] || return 78
    if declare -F route_v2_instrumentation_scope_invariant >/dev/null; then
      route_v2_instrumentation_scope_invariant \
        "$task" "$attempt" "$scope" || return 75
    fi
    _route_v2_workspace_roots_array || return
    txid="v2-${attempt#*_}-s${sequence}"
    isolation=exclusive-worktree-v1
    if declare -F route_v2_instrumentation_isolation >/dev/null; then
      isolation=$(route_v2_instrumentation_isolation) || return 78
    fi
    [[ "$isolation" == exclusive-worktree-v1 ||
       "$isolation" == exclusive-shared-checkout-v1 ]] || return 78
    FACTORY_INSTRUMENTATION_ISOLATION="$isolation" \
      instrumentation_tx_begin \
        "$task" "$txid" "$scope" "FACTORY-TRACE:t${task}" "${ROUTE_V2_ROOTS[@]}" || return
  elif [[ "$node" == proof && $active_rc -ne 0 ]]; then
    return 78
  elif (( active_rc != 0 && active_rc != 3 )); then
    return "$active_rc"
  fi
}

# Сторож валит прогон fail-closed, а в журнал уходил один код возврата. При мусоре стенда
# причину приходилось выяснять, вручную разбирая
# base64 в снимках транзакции. Пишем причину и каталоги — без хешей и содержимого.
_route_v2_log_transaction_stall() {
  local task=$1 txid=$2 dir reason newest candidate summary
  declare -F v2_log >/dev/null || return 0
  dir=$(instrumentation_tx_dir "$task" "$txid") || return 0
  [[ -d "$dir" ]] || return 0
  reason=$(_instrumentation_tx_get "$dir/state.env" REASON)
  v2_log "транзакция $txid остановлена: ${reason:-без причины}"
  [[ -f "$dir/baseline.tsv" ]] || return 0
  newest=""
  for candidate in "$dir"/checkpoint-*.tsv "$dir/cleanup-current.tsv" \
                   "$dir/cleanup-final.tsv"; do
    [[ -f "$candidate" ]] || continue
    [[ -z "$newest" || "$candidate" -nt "$newest" ]] && newest="$candidate"
  done
  [[ -n "$newest" ]] || return 0
  summary=$(workspace_guard_diff_paths "$dir/baseline.tsv" "$newest" 12) || return 0
  while IFS= read -r line; do
    [[ -n "$line" ]] && v2_log "  вне scope: $line"
  done <<<"$summary"
  return 0
}

_route_v2_transaction_after() {
  local task=$1 node=$2 txid rc
  txid=$(_route_v2_transaction_active_id "$task") || return 78
  instrumentation_tx_checkpoint "$task" "$txid" || {
    rc=$?
    _route_v2_log_transaction_stall "$task" "$txid"
    return "$rc"
  }
  # Топология instrument → proof держит одну транзакцию между двумя узлами. Любой другой
  # транзакционный узел владеет отдельной полной транзакцией; route id здесь не участвует.
  if [[ "$node" != instrument ]]; then
    instrumentation_tx_cleanup "$task" "$txid" || {
      rc=$?
      _route_v2_log_transaction_stall "$task" "$txid"
      return "$rc"
    }
    if declare -F route_v2_instrumentation_restored >/dev/null; then
      route_v2_instrumentation_restored "$task" "$(instrumentation_tx_dir "$task" "$txid")/scope.list" ||
        return
    fi
  fi
}

# Открытые находки для промпта берём из УЖЕ построенного контекста узла, а не отдельным
# чтением журнала: `attempt_stage_state_findings_v2` берёт task lock, а мы внутри
# диспетчера, который этот же лок держит. Контекст-файл содержит секцию evidence всегда —
# её наполняет factory-context, тогда как requiredContext маршрута решает лишь то, что
# попадёт в промпт через render_node. Именно поэтому доставка находок не может зависеть
# от requiredContext: это инвариант движка, а не решение автора схемы.
#
# `closed` — история и в промпт не идёт. `open` — список к ремонту. `deferred` раньше
# считались адресованными человеку на воротах и до узлов не доезжали вовсе — и это стоило
# отдельной беды: проверяющий, не зная о собственной прошлой отложенной находке, НАХОДИЛ ЕЁ
# СНОВА следующим кругом. Замер по журналам всех попыток: 8 попыток из 29 переоткрывают тот
# же отложенный id на том же узле, одна — трижды. Каждый повтор занимает место в лимите
# находок вердикта и требует от человека на воротах повторного «это мы уже отложили».
# Поэтому отложенные тоже едут в промпт, но ОТДЕЛЬНЫМ списком и с обратным смыслом:
# автору «не чини», проверяющему «не открывай заново».
#
# Любой сбой разбора даёт пустую строку и молчание — находки усиливают промпт, но не
# являются условием исполнения узла, и ронять из-за них заход нельзя.
_route_v2_findings_from_context() {
  local context_file=${1:-} section=${2:-open}
  [[ -n "$context_file" && -f "$context_file" && ! -L "$context_file" ]] || return 0
  python3 -c '
import json, sys

try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        context = json.load(handle)
except (OSError, ValueError):
    raise SystemExit(0)
if not isinstance(context, dict):
    raise SystemExit(0)
evidence = context.get("evidence")
findings = evidence.get("findings") if isinstance(evidence, dict) else None
records = findings.get(sys.argv[2]) if isinstance(findings, dict) else None
if isinstance(records, list) and records:
    # Блоки промпта показывают 50 открытых и 30 отложенных: больше в переменную
    # окружения не кладём — одна строка env в Linux не длиннее 128 КиБ.
    limit = 50 if sys.argv[2] == "open" else 30
    json.dump(records[:limit], sys.stdout, ensure_ascii=False)
' "$context_file" "$section" 2>/dev/null || return 0
}

# Причина отказа evidence-хука — его последняя непустая строка: профильные сторожа печатают
# диагноз одной строкой в самом конце (feature-verify, hunt-evidence). Текст поедет в промпт
# повтора, в реестр и в журнал стадий, поэтому здесь он приводится к одной строке без
# управляющих символов и с потолком длины: те же требования, что у comment вердикта.
# Ошибка разбора даёт пустую строку — отсутствие формулировки не отменяет самого отказа.
_route_v2_evidence_reason() {
  printf '%s' "${1:-}" | python3 -c '
import sys

text = sys.stdin.buffer.read().decode("utf-8", errors="replace")
lines = [line.strip() for line in text.splitlines() if line.strip()]
if not lines:
    raise SystemExit(0)
reason = "".join(
    char if ord(char) >= 32 and ord(char) != 127 else " " for char in lines[-1]
)
reason = " ".join(reason.split())
if len(reason) > 500:
    reason = reason[:499] + "…"
sys.stdout.buffer.write(reason.encode("utf-8"))
' 2>/dev/null || true
}

_route_v2_run_agent_node() {
  local task=$1 attempt=$2 node=$3 run_key=$4 policy=$5 sequence=$6
  local _r2_context_file _r2_prompt_file active before_signature after_signature
  local result run_id verdict_b64
  local guard_before="" guard_after=""
  # rc 75 неоднозначен (нет результата ИЛИ guard поймал нарушение) — ретраить
  # можно только первое, поэтому источник помечается флагом.
  ROUTE_V2_NO_RESULT=0
  # Класс исхода раннера у захода без результата (словарь — runners/policy.sh). Повтору
  # после таймаута и после упавшего процесса нужны разные вводные, а комментарий
  # остановки обязан назвать, чем именно кончился последний заход.
  ROUTE_V2_NO_RESULT_CLASS=""
  ROUTE_V2_NO_RESULT_DETAIL=""
  DISPATCH_RESULT_DETAIL=""
  ROUTE_V2_NODE_VERDICT_B64=""
  ROUTE_V2_FINAL_RUN_ID=""
  # Флаг отказа сторожа обнуляется на входе, а не только перед самой проверкой: заход,
  # оборвавшийся раньше неё, не должен унаследовать отказ предыдущего.
  ROUTE_V2_EVIDENCE_REJECTED=0
  ROUTE_V2_EVIDENCE_REASON=""
  declare -F run_agent >/dev/null || _route_v2_fail "run_agent is unavailable" || return
  declare -F route_v2_context_for_node >/dev/null ||
    _route_v2_fail "route_v2_context_for_node hook is missing" || return

  _r2_context_file=$(mktemp "$(factory_control_root)/.route-v2-context.XXXXXX") || return 1
  _r2_prompt_file=$(mktemp "$(factory_control_root)/.route-v2-prompt.XXXXXX") || {
    rm -f -- "$_r2_context_file"
    return 1
  }
  route_v2_context_for_node \
    "$task" "$attempt" "$node" "$run_key" "$_r2_context_file" || {
    local rc=$?
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    return "$rc"
  }
  [[ -f "$_r2_context_file" && ! -L "$_r2_context_file" ]] || {
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    return 78
  }
  _route_v2_require_delivery_context "$_r2_context_file" "$node" || {
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    return 78
  }
  "$FACTORY_HOME/bin/factory-route" \
    --routes-dir "$ROUTE_V2_ROUTES_DIR" \
    --profile "$ROUTE_V2_PROFILE" \
    render-route \
    --catalog-hash "$ROUTE_V2_CATALOG" \
    --route "$ROUTE_V2_ROUTE" \
    --node "$node" \
    --context "$_r2_context_file" >"$_r2_prompt_file" || {
      local rc=$?
      rm -f -- "$_r2_context_file" "$_r2_prompt_file"
      return "$rc"
    }
  chmod 400 "$_r2_context_file" "$_r2_prompt_file" || {
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    return 1
  }

  active=$(run_state_active_file "$task" "$run_key") || {
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    return 78
  }
  if [[ -e "$active" || -L "$active" ]]; then
    [[ -f "$active" && ! -L "$active" ]] || {
      rm -f -- "$_r2_context_file" "$_r2_prompt_file"
      return 78
    }
    before_signature=$(sha256sum -- "$active" | awk '{print $1}') || {
      rm -f -- "$_r2_context_file" "$_r2_prompt_file"
      return 1
    }
  else
    before_signature=missing
  fi

  if [[ "$policy" == state-only ]]; then
    guard_before=$(_route_v2_guard_snapshot "$task" "$attempt" "$node" "$sequence" before) || {
      rm -f -- "$_r2_context_file" "$_r2_prompt_file"
      return 78
    }
  elif [[ "$policy" != transactional-write && "$policy" != workspace-write ]]; then
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    return 78
  fi
  if [[ "$policy" == transactional-write ]]; then
    _route_v2_transaction_before "$task" "$attempt" "$node" "$sequence" || {
      local rc=$?
      rm -f -- "$_r2_context_file" "$_r2_prompt_file"
      return "$rc"
    }
  fi

  mkdir -p -- "$STATE_DIR/logs" || return 1
  local _r2_open_findings _r2_deferred_findings
  _r2_open_findings=$(_route_v2_findings_from_context "$_r2_context_file" open)
  _r2_deferred_findings=$(_route_v2_findings_from_context "$_r2_context_file" deferred)
  # Класс запуска читается после run_agent из глобала диспетчера; след прошлого узла не
  # должен сойти за класс этого захода, если до диспетчера дело не дошло.
  DISPATCH_RESULT_KIND=""
  FACTORY_ROUTE_FILESYSTEM_POLICY="$policy" \
  FACTORY_ROUTE_BROWSER_POLICY="${ROUTE_V2_NODE_BROWSER:-forbid}" \
  FACTORY_ROUTE_TIMEOUT_CLASS="${ROUTE_V2_NODE_TIMEOUT_CLASS:-}" \
  FACTORY_ROUTE_FANOUT_MODE="${ROUTE_V2_NODE_FANOUT_MODE:-single}" \
  FACTORY_ROUTE_FANOUT_MAX="${ROUTE_V2_NODE_FANOUT_MAX:-1}" \
  FACTORY_ROUTE_FANOUT_DEGRADE="${ROUTE_V2_NODE_FANOUT_DEGRADE:-forbid}" \
  FACTORY_STAGE_RETRY="${ROUTE_V2_NODE_RETRY:-1}" \
  FACTORY_STAGE_RETRY_REASON="${ROUTE_V2_NODE_RETRY_REASON:-}" \
  FACTORY_STAGE_RETRY_NOTE="${ROUTE_V2_NODE_RETRY_NOTE:-}" \
  FACTORY_STAGE_HUMAN_NOTE="${ROUTE_V2_NODE_HUMAN_NOTE:-}" \
  FACTORY_STAGE_OPEN_FINDINGS="$_r2_open_findings" \
  FACTORY_STAGE_DEFERRED_FINDINGS="$_r2_deferred_findings" \
  FACTORY_LOOP_ROLE="${ROUTE_V2_NODE_LOOP_ROLE:-}" \
    run_agent "$task" "$(cat "$_r2_prompt_file")" "$run_key" \
      >>"$STATE_DIR/logs/t${task}.route-v2.log" 2>&1
  local agent_rc=$?
  # Диспетчер работает в этом же процессе и оставляет класс последнего запуска в
  # DISPATCH_RESULT_KIND; фейковый run_agent тестов его не ставит — тогда класс пуст.
  ROUTE_V2_NO_RESULT_CLASS=${DISPATCH_RESULT_KIND:-}
  ROUTE_V2_NO_RESULT_DETAIL=${DISPATCH_RESULT_DETAIL:-}

  # 79 — отказ ХОСТА/КОНФИГА (нет свежего coverage, провайдер недоступен, denied),
  # а не «агент не отчитался»: ретраить бессмысленно, а исчерпание бюджета
  # закоммитило бы exhausted и убило попытку из-за временной проблемы окружения.
  # Правка runners.env на ходу может обесценить coverage, после чего скептик сожжёт
  # все попытки и маршрут встанет терминально. Останавливаемся
  # fail-closed, оставляя узел невыполненным: после починки конфига resume продолжит.
  if (( agent_rc == 79 )); then
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    _route_v2_fail "run_agent отказал по конфигурации хоста (код 79): исправь и повтори resume"
    return 75
  fi

  if [[ ! -e "$active" && ! -L "$active" ]]; then
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    # Файл так и не появился: этап ни разу не отчитался — это «результата нет»
    # (ретраится по бюджету), а не повреждение состояния. Исчезновение файла,
    # который до запуска существовал, остаётся fail-closed.
    [[ "$before_signature" == missing ]] || return 78
    ROUTE_V2_NO_RESULT=1
    return 75
  fi
  [[ -f "$active" && ! -L "$active" ]] || {
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    return 78
  }
  after_signature=$(sha256sum -- "$active" | awk '{print $1}') || {
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    return 1
  }
  [[ "$after_signature" != "$before_signature" ]] || {
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    ROUTE_V2_NO_RESULT=1
    return 75
  }
  if ! IFS=$'\t' read -r result run_id verdict_b64 < <(_route_v2_active_result "$active"); then
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    # Незакрытый запуск (STATE=active) — раннер умер, не отчитавшись, например из-за
    # исчерпания лимита у всех провайдеров. Это «результата нет», а не
    # повреждение состояния: ретраим по бюджету, дальше exhausted к человеку.
    if [[ "$(awk -F= '$1 == "STATE" {print $2; exit}' "$active" 2>/dev/null)" == active ]]; then
      ROUTE_V2_NO_RESULT=1
      return 75
    fi
    return 78
  fi
  [[ -n "$run_id" ]] || {
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    return 78
  }
  ROUTE_V2_FINAL_RUN_ID=$run_id
  [[ "$verdict_b64" != - ]] || verdict_b64=""
  run_state_verdict_validate "$result" "$verdict_b64" || {
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    return 78
  }

  if [[ "$policy" == transactional-write ]]; then
    _route_v2_transaction_after "$task" "$node" || {
      local rc=$?
      rm -f -- "$_r2_context_file" "$_r2_prompt_file"
      return "$rc"
    }
  fi
  if [[ "$policy" == state-only ]]; then
    guard_after=$(_route_v2_guard_snapshot "$task" "$attempt" "$node" "$sequence" after) || {
      rm -f -- "$_r2_context_file" "$_r2_prompt_file"
      return 78
    }
    _route_v2_guard_verify "$run_key" "$node" "$guard_before" "$guard_after" || {
      local rc=$?
      rm -f -- "$_r2_context_file" "$_r2_prompt_file"
      return "$rc"
    }
  fi
  # Профиль может потребовать машинное доказательство результата конкретного runId
  # (hunt: declared coverage против tool-use events). Проверка исполняется хостом
  # после readonly guard и не зависит от того, вызвал ли её агент в промпте.
  if declare -F profile_route_node_evidence_check >/dev/null; then
    local evidence_output evidence_rc
    # Вывод хука по-прежнему уезжает в route-v2.log, но через переменную: его последняя
    # строка — единственная формулировка причины отказа, и она нужна не только журналу,
    # а повторному заходу агента и карточке остановки у человека.
    evidence_output=$(profile_route_node_evidence_check \
      "$task" "$ROUTE_V2_ROUTE" "$node" "$run_key" "$result" "$run_id" \
      "$_r2_context_file" 2>&1)
    evidence_rc=$?
    [[ -z "$evidence_output" ]] ||
      printf '%s\n' "$evidence_output" >>"$STATE_DIR/logs/t${task}.route-v2.log"
    if (( evidence_rc != 0 )); then
      printf 'route-v2 runtime: %s evidence rejected runner result (rc=%s)\n' \
        "$run_key" "$evidence_rc" \
        >>"$STATE_DIR/logs/t${task}.route-v2.log"
      # Это продуктовый failed, а не no-result: слепой retry не создаст отсутствующее
      # доказательство задним числом. Но причина отказа — текст, который агент способен
      # устранить сам (t8702: в manifest тестов попал файл, который VERIFY не исполняет),
      # поэтому цикл узла даёт один повтор с её цитатой и лишь потом зовёт человека.
      result=failed
      verdict_b64=""
      ROUTE_V2_EVIDENCE_REJECTED=1
      ROUTE_V2_EVIDENCE_REASON=$(_route_v2_evidence_reason "$evidence_output")
    fi
  fi
  rm -f -- "$_r2_context_file" "$_r2_prompt_file"
  ROUTE_V2_NODE_RESULT=$result
  ROUTE_V2_NODE_VERDICT_B64=$verdict_b64
}

_route_v2_command_result() {
  python3 - "$1" <<'PY'
import base64
import json
import os
import re
import stat
import sys

path = sys.argv[1]
owners = {"build", "tests", "environment", "plan", "human"}
finding_re = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def fail():
    raise SystemExit(78)


def artifact_path(value):
    # Относительный путь артефакта: те же правила, что в run-state и в ядре.
    return (
        isinstance(value, str)
        and 1 <= len(value) <= 200
        and not value.startswith("/")
        and ".." not in value.split("/")
        and not any(ord(char) < 32 or ord(char) == 127 for char in value)
    )


try:
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_size > 64 * 1024:
        fail()
    with os.fdopen(fd, encoding="utf-8", closefd=True) as source:
        value = json.load(source, parse_constant=lambda _: fail())
except (OSError, UnicodeError, json.JSONDecodeError):
    fail()

if not isinstance(value, dict) or not {
    "schema", "outcome", "comment", "failureOwner", "findings"
} <= set(value) or not set(value) <= {
    "schema", "outcome", "comment", "failureOwner", "findings", "reviewed"
}:
    fail()
outcome = value["outcome"]
comment = value["comment"]
owner = value["failureOwner"]
findings = value["findings"]
reviewed_raw = value.get("reviewed")
if (
    value["schema"] != 1
    or outcome not in {"done", "skipped", "failed"}
    or not isinstance(comment, str)
    or not 1 <= len(comment) <= 2000
    or any(ord(char) < 32 or ord(char) == 127 for char in comment)
    or not isinstance(findings, list)
):
    fail()

verdict = None
# `done` со списком замечаний означает приёмку с хвостом: все находки объявлены
# отложенными (severity=deferred), возврата в сборку они не вызывают. Такой исход
# профильный скрипт отдаёт сам — раньше непустой список при done валил узел кодом 78.
if outcome == "failed" or (outcome == "done" and findings):
    if outcome == "failed" and owner not in owners:
        fail()
    if outcome == "done" and owner is not None and owner not in owners:
        fail()
    if not 1 <= len(findings) <= 32:
        fail()
    seen = set()
    normalized = []
    for finding in findings:
        if not isinstance(finding, dict) or not {"id", "summary"} <= set(
            finding
        ) or not set(finding) <= {"id", "summary", "anchor", "severity"}:
            fail()
        finding_id = finding["id"]
        summary = finding["summary"]
        if (
            not isinstance(finding_id, str)
            or not finding_re.fullmatch(finding_id)
            or finding_id in seen
            or not isinstance(summary, str)
            or not 1 <= len(summary) <= 500
            or any(ord(char) < 32 or ord(char) == 127 for char in summary)
        ):
            fail()
        seen.add(finding_id)
        item = {"id": finding_id, "summary": summary}
        # Якорь замечания — тот же необязательный контракт, что и у агентских узлов:
        # относительный путь артефакта, по которому ядро отличает первый проход по
        # новому файлу от претензии к уже просмотренному.
        if "anchor" in finding:
            if not artifact_path(finding["anchor"]):
                fail()
            item["anchor"] = finding["anchor"]
        # Вес замечания. Дефолт `blocking` в payload не пишем: канонический JSON
        # вердикта без отложенных находок остаётся прежним байт-в-байт.
        severity = finding.get("severity", "blocking")
        if severity not in {"blocking", "deferred"}:
            fail()
        if severity != "blocking":
            item["severity"] = severity
        normalized.append(item)
    blocking = [
        item for item in normalized if item.get("severity", "blocking") == "blocking"
    ]
    if outcome == "done" and blocking:
        fail()
    if outcome == "failed" and not blocking:
        # Отказ, в котором не осталось ни одного блокирующего замечания, — не отказ:
        # проверяющий сам объявил всё найденное отложенным. Разворачивать сборку не
        # за что, иначе маршрут упрётся в no-progress по замечаниям, которые никто
        # не просил чинить.
        outcome = "done"
    verdict = {"owner": owner or "build", "findings": normalized}
    if reviewed_raw is not None:
        if not isinstance(reviewed_raw, list) or not 1 <= len(reviewed_raw) <= 64:
            fail()
        if len(set(map(str, reviewed_raw))) != len(reviewed_raw):
            fail()
        for path in reviewed_raw:
            if not artifact_path(path):
                fail()
        verdict["reviewed"] = list(reviewed_raw)
elif owner is not None or findings:
    fail()

comment_b64 = base64.b64encode(comment.encode("utf-8")).decode("ascii")
verdict_b64 = ""
if verdict is not None:
    payload = json.dumps(
        verdict,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    verdict_b64 = base64.b64encode(payload).decode("ascii")
print(outcome, comment_b64, verdict_b64 or "-", sep="\t")
PY
}

# Отвергнутый вердикт command-узла — единственный след причины отказа, а лежал он
# во временном файле и удалялся вместе с ним. Наружу шёл голый код 78: скрипт
# отработал, stderr пуст, артефакты свежие — и ни слова о том, чем не понравился
# JSON. В результате verify мог встать без объяснения, а причину приходилось искать вручную.
# Копия отвергнутого вердикта живёт до следующего отказа этой же задачи.
_route_v2_command_verdict_spill() {
  local task=$1 node=$2 result_file=$3 reason=$4 target
  target="$STATE_DIR/logs/t${task}.command-verdict-rejected.json"
  cp -f -- "$result_file" "$target" 2>/dev/null || true
  printf 'command %s: вердикт отвергнут (%s), копия: %s\n' \
    "$node" "$reason" "$target" >>"$STATE_DIR/logs/t${task}.route-v2.log"
}

# Детерминированный узел исполняется trusted profile hook-ом без model call. Hook
# пишет в stdout ровно JSON verdict; любые диагностические логи отправляет в stderr.
_route_v2_run_command_node() {
  local task=$1 attempt=$2 node=$3 run_key=$4 command_id=$5 policy=$6 sequence=$7
  local context_file result_file guard_before="" guard_after="" rc
  local outcome comment_b64 verdict_b64 comment contract_hash verdict_hash=""
  declare -F profile_route_command >/dev/null ||
    _route_v2_fail "profile_route_command hook is missing for command=$command_id" || return
  declare -F route_v2_context_for_node >/dev/null ||
    _route_v2_fail "route_v2_context_for_node hook is missing" || return
  [[ "$policy" == state-only || "$policy" == workspace-write ]] ||
    _route_v2_fail "command executor does not support filesystem=$policy" || return

  context_file=$(mktemp "$(factory_control_root)/.route-v2-command-context.XXXXXX") || return 1
  result_file=$(mktemp "$(factory_control_root)/.route-v2-command-result.XXXXXX") || {
    rm -f -- "$context_file"
    return 1
  }
  route_v2_context_for_node \
    "$task" "$attempt" "$node" "$run_key" "$context_file" || {
      rc=$?
      rm -f -- "$context_file" "$result_file"
      return "$rc"
    }
  [[ -f "$context_file" && ! -L "$context_file" ]] || {
    rm -f -- "$context_file" "$result_file"
    return 78
  }
  _route_v2_require_delivery_context "$context_file" "$node" || {
    rm -f -- "$context_file" "$result_file"
    return 78
  }
  chmod 400 "$context_file" || {
    rm -f -- "$context_file" "$result_file"
    return 1
  }
  if [[ "$policy" == state-only ]]; then
    guard_before=$(_route_v2_guard_snapshot \
      "$task" "$attempt" "$node" "$sequence" before) || {
        rm -f -- "$context_file" "$result_file"
        return 78
      }
  fi

  mkdir -p -- "$STATE_DIR/logs" || {
    rm -f -- "$context_file" "$result_file"
    return 1
  }
  contract_hash=$(runtime_analytics_hash_string_v2 \
    "$ROUTE_V2_CATALOG|$ROUTE_V2_ROUTE_HASH|$node|$command_id|$policy") || {
      rm -f -- "$context_file" "$result_file"
      return 78
    }
  runtime_lifecycle_command_begin_v2 "$contract_hash" >/dev/null || {
    rm -f -- "$context_file" "$result_file"
    return 78
  }
  profile_route_command \
    "$task" "$ROUTE_V2_ROUTE" "$node" "$run_key" "$command_id" "$context_file" \
    >"$result_file" \
    2>>"$STATE_DIR/logs/t${task}.route-v2.log"
  rc=$?
  if (( rc != 0 )); then
    runtime_lifecycle_command_finish_v2 failed unavailable "$rc" '' >/dev/null || true
    rm -f -- "$context_file" "$result_file"
    _route_v2_fail "profile command=$command_id failed without verdict (code $rc)" || true
    return 75
  fi
  IFS=$'\t' read -r outcome comment_b64 verdict_b64 \
    < <(_route_v2_command_result "$result_file") || {
      runtime_lifecycle_command_finish_v2 failed conflict 0 '' >/dev/null || true
      _route_v2_command_verdict_spill "$task" "$node" "$result_file" "форма JSON"
      rm -f -- "$context_file" "$result_file"
      return 78
    }
  [[ "$verdict_b64" != - ]] || verdict_b64=""
  comment=$(printf '%s' "$comment_b64" | base64 -d 2>/dev/null) || {
    runtime_lifecycle_command_finish_v2 failed conflict 0 '' >/dev/null || true
    _route_v2_command_verdict_spill "$task" "$node" "$result_file" "comment не декодируется"
    rm -f -- "$context_file" "$result_file"
    return 78
  }
  run_state_verdict_validate "$outcome" "$verdict_b64" || {
    runtime_lifecycle_command_finish_v2 failed conflict 0 '' >/dev/null || true
    _route_v2_command_verdict_spill "$task" "$node" "$result_file" "verdict не прошёл валидацию"
    rm -f -- "$context_file" "$result_file"
    return 78
  }
  [[ -z "$verdict_b64" ]] || \
    verdict_hash=$(printf '%s' "$verdict_b64" | base64 -d | sha256sum | awk '{print $1}')
  runtime_lifecycle_command_finish_v2 succeeded normal 0 "$verdict_hash" >/dev/null || {
    rm -f -- "$context_file" "$result_file"
    return 78
  }

  if [[ "$policy" == state-only ]]; then
    guard_after=$(_route_v2_guard_snapshot \
      "$task" "$attempt" "$node" "$sequence" after) || {
        _route_v2_command_verdict_spill "$task" "$node" "$result_file" \
          "снимок workspace guard «после» не снялся"
        rm -f -- "$context_file" "$result_file"
        return 78
      }
    _route_v2_guard_verify "$run_key" "$node" "$guard_before" "$guard_after" || {
      rc=$?
      rm -f -- "$context_file" "$result_file"
      return "$rc"
    }
  fi
  run_state_control_update \
    "$task" "$run_key" "$outcome" "${run_key}_COMMENT" "$comment" || {
      rc=$?
      rm -f -- "$context_file" "$result_file"
      return "$rc"
    }
  rm -f -- "$context_file" "$result_file"
  ROUTE_V2_NODE_RESULT=$outcome
  ROUTE_V2_NODE_VERDICT_B64=$verdict_b64
}

_route_v2_bootstrap_abort_lifecycle_v2() {
  local active=$1 execution_open=$2 retry_after=$3 reason=$4
  (( active )) || return 0
  if (( execution_open )); then
    runtime_lifecycle_node_execution_finish_v2 \
      failed "$reason" "$retry_after" '' none '' "${MULTI_LAST_RUN_ID:-}" \
      >/dev/null || true
  fi
  runtime_lifecycle_node_visit_finish_v2 \
    interrupted "$reason" attempt_interrupted '' '' >/dev/null || true
  runtime_lifecycle_attempt_span_finish_v2 \
    bootstrap_finished "bootstrap:scout" failed "$reason" '' >/dev/null || true
}

route_v2_dispatch_bootstrap() {
  local task attempt artifact description_tmp transition_tmp record_tmp
  local _r2_context_file _r2_prompt_file active before_signature after_signature
  local executor phase run_key policy result run_id verdict_b64 guard_before guard_after rc
  local run_epoch comment_b64 checkpoint_lock
  local visit_json journal_json visit_id runs_file reason_file stop_json decision_file=""
  local execution_status execution_reason verdict_hash=""
  local fanout_mode fanout_max fanout_degrade retry_no_result retry_product
  local provider_attempts provider_strategy browser_policy timeout_class command_id
  local tries_left attempt_no agent_rc
  local bootstrap_details lifecycle_active=0 execution_open=0 retry_after bootstrap_policy
  _route_v2_require_isolation || return
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  _route_v2_require_runner_invariant "$task" || return
  _route_v2_load_attempt "$task" "$attempt" || return

  # Отказ от отдельной разведки принадлежит проверенному immutable-маршруту.
  # На resume читаем тот же pin; mutable-профиль и новый current его не меняют.
  # Пропуск не создаёт фиктивных run/result или записи об успешной работе SCOUT.
  description_tmp=$(mktemp "$(factory_control_root)/.route-v2-bootstrap-policy.XXXXXX") || return 1
  "$FACTORY_HOME/bin/factory-route" \
    --routes-dir "$ROUTE_V2_ROUTES_DIR" --profile "$ROUTE_V2_PROFILE" describe-route \
    --catalog-hash "$ROUTE_V2_CATALOG" --route "$ROUTE_V2_ROUTE" >"$description_tmp" || {
      rc=$?
      rm -f -- "$description_tmp"
      return "$rc"
    }
  bootstrap_policy=$(_route_v2_json bootstrap-policy "$description_tmp") || {
    rc=$?
    rm -f -- "$description_tmp"
    return "$rc"
  }
  rm -f -- "$description_tmp"
  if [[ "$bootstrap_policy" == skip ]]; then
    printf '%s\n' '{"bootstrap":"skipped"}'
    return 0
  fi

  artifact="$ROUTE_V2_ATTEMPT_DIR/artifacts/bootstrap.json"
  if [[ -e "$artifact" || -L "$artifact" ]]; then
    _route_v2_bootstrap_record validate \
      "$artifact" "$task" "$attempt" "$ROUTE_V2_PROFILE" "$ROUTE_V2_CATALOG" \
      "$ROUTE_V2_ROUTE" "$ROUTE_V2_ROUTE_HASH" || return
    journal_json=$(attempt_bootstrap_journal_v2 read "$task" "$attempt" "$ROUTE_V2_PROFILE") || return
    case "$(jq -r .state <<<"$journal_json")" in
      waiting|answered)
        _route_v2_fail "successful checkpoint противоречит ожидающему вопросу"
        return 78
        ;;
      running)
        visit_id=$(jq -r .visit.visitId <<<"$journal_json") || return 78
        attempt_bootstrap_journal_v2 completed \
          "$task" "$attempt" "$ROUTE_V2_PROFILE" "$visit_id" >/dev/null || return
        ;;
    esac
    cat -- "$artifact"
    return
  fi

  journal_json=$(attempt_bootstrap_journal_v2 read "$task" "$attempt" "$ROUTE_V2_PROFILE") || return
  if [[ "$(jq -r .state <<<"$journal_json")" == waiting ]]; then
    printf '%s\n' "$journal_json"
    return 22
  fi

  declare -F run_agent >/dev/null || _route_v2_fail "run_agent is unavailable" || return
  declare -F route_v2_context_for_node >/dev/null ||
    _route_v2_fail "route_v2_context_for_node hook is missing" || return
  description_tmp=$(mktemp "$(factory_control_root)/.route-v2-bootstrap.XXXXXX") || return 1
  "$FACTORY_HOME/bin/factory-route" \
    --routes-dir "$ROUTE_V2_ROUTES_DIR" \
    --profile "$ROUTE_V2_PROFILE" \
    describe-bootstrap \
    --catalog-hash "$ROUTE_V2_CATALOG" >"$description_tmp" || {
      rc=$?
      rm -f -- "$description_tmp"
      return "$rc"
    }
  IFS=$'\t' read -r executor phase run_key policy fanout_mode fanout_max fanout_degrade \
    retry_no_result retry_product provider_attempts provider_strategy browser_policy \
    timeout_class command_id \
    < <(_route_v2_json node "$description_tmp" scout) || {
      rm -f -- "$description_tmp"
      return 78
    }
  attempt_bootstrap_journal_v2 preflight "$task" "$attempt" "$ROUTE_V2_PROFILE" "$description_tmp" || {
    rc=$?
    rm -f -- "$description_tmp"
    return "$rc"
  }
  rm -f -- "$description_tmp"
  [[ "$executor" == agent && "$phase" == bootstrap && "$run_key" == SCOUT &&
     "$policy" == state-only ]] || return 78
  _route_v2_node_caps_guard \
    "$executor" "$policy" "$fanout_mode" "$fanout_max" "$fanout_degrade" \
    "$provider_strategy" || return
  visit_json=$(attempt_bootstrap_journal_v2 begin "$task" "$attempt" "$ROUTE_V2_PROFILE") || return
  visit_id=$(jq -r .visitId <<<"$visit_json") || return 78
  runs_file=$(mktemp "$(factory_control_root)/.bootstrap-runs.XXXXXX") || return 1
  printf '%s\n' '[]' >"$runs_file"
  _route_v2_mark_node_running "$task" scout "$run_key"

  _r2_context_file=$(mktemp "$(factory_control_root)/.route-v2-context.XXXXXX") || return 1
  _r2_prompt_file=$(mktemp "$(factory_control_root)/.route-v2-prompt.XXXXXX") || {
    rm -f -- "$_r2_context_file"
    return 1
  }
  route_v2_context_for_node \
    "$task" "$attempt" scout SCOUT "$_r2_context_file" bootstrap || {
      rc=$?
      rm -f -- "$_r2_context_file" "$_r2_prompt_file"
      return "$rc"
    }
  if [[ "$(jq -r '.decision.answer // empty' <<<"$journal_json")" != "" ]]; then
    decision_file=$(mktemp "$(factory_control_root)/.bootstrap-decision.XXXXXX") || return 1
    printf '%s\n' "$journal_json" >"$decision_file"
    python3 - "$_r2_context_file" "$decision_file" <<'CONTEXT'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
value = json.loads(path.read_text())
journal = json.loads(Path(sys.argv[2]).read_text())
value['evidence']['bootstrapDecision'] = {
    'phase': 'bootstrap', 'node': 'scout', 'question': journal['stop'],
    'decision': journal['decision'],
}
path.write_text(json.dumps(value, ensure_ascii=False) + '\n')
CONTEXT
  fi
  [[ -f "$_r2_context_file" && ! -L "$_r2_context_file" ]] || {
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    return 78
  }
  _route_v2_require_delivery_context "$_r2_context_file" scout || {
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    return 78
  }
  "$FACTORY_HOME/bin/factory-route" \
    --routes-dir "$ROUTE_V2_ROUTES_DIR" \
    --profile "$ROUTE_V2_PROFILE" \
    render-bootstrap \
    --catalog-hash "$ROUTE_V2_CATALOG" \
    --node scout \
    --context "$_r2_context_file" >"$_r2_prompt_file" || {
      rc=$?
      rm -f -- "$_r2_context_file" "$_r2_prompt_file"
      return "$rc"
    }
  chmod 400 "$_r2_context_file" "$_r2_prompt_file" || {
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    return 1
  }
  active=$(run_state_active_file "$task" SCOUT) || return 78
  if [[ -e "$active" || -L "$active" ]]; then
    [[ -f "$active" && ! -L "$active" ]] || return 78
    before_signature=$(sha256sum -- "$active" | awk '{print $1}') || return 1
  else
    before_signature=missing
  fi
  mkdir -p -- "$STATE_DIR/logs" || return 1
  if runtime_lifecycle_enabled_v2; then
    bootstrap_details=$(runtime_analytics_json_v2 \
      bootstrapId string scout catalogHash string "$ROUTE_V2_CATALOG") || return 78
    runtime_lifecycle_attempt_span_begin_v2 \
      bootstrap_started "bootstrap:scout" "$bootstrap_details" >/dev/null || return
    runtime_lifecycle_node_visit_begin_v2 \
      scout SCOUT 0 initial '' '' >/dev/null || {
        rc=$?
        runtime_lifecycle_attempt_span_finish_v2 \
          bootstrap_finished "bootstrap:scout" failed unavailable '' >/dev/null || true
        return "$rc"
      }
    lifecycle_active=1
    ROUTE_V2_BOOTSTRAP_LIFECYCLE_VISIT_ID=$FACTORY_LIFECYCLE_NODE_VISIT_ID
  fi
  # Каждый запуск получает собственные границы guard и exact run/epoch.
  # Исчерпание объявленного бюджета создаёт host outcome, а не вердикт агента.
  tries_left=$(( 1 + retry_no_result + provider_attempts ))
  attempt_no=1
  while :; do
    retry_after=$((tries_left - 1))
    guard_before=$(_route_v2_guard_snapshot "$task" "$attempt" scout "$visit_id-$attempt_no" before) || return
    runtime_lifecycle_node_execution_begin_v2 \
      agent "$((attempt_no - 1))" "$retry_after" \
      "$([[ "$attempt_no" == 1 ]] && printf initial || printf no_result)" >/dev/null || return
    execution_open=1
    unset MULTI_LAST_RUN_ID MULTI_LAST_RUN_EPOCH
    FACTORY_ROUTE_FILESYSTEM_POLICY=state-only \
    FACTORY_ROUTE_BROWSER_POLICY="$browser_policy" \
    FACTORY_ROUTE_TIMEOUT_CLASS="$timeout_class" \
    FACTORY_ROUTE_FANOUT_MODE="$fanout_mode" \
    FACTORY_ROUTE_FANOUT_MAX="$fanout_max" \
    FACTORY_ROUTE_FANOUT_DEGRADE="$fanout_degrade" \
    FACTORY_STAGE_RETRY="$attempt_no" \
    FACTORY_STAGE_RETRY_REASON=no-result \
    FACTORY_STAGE_BOOTSTRAP_DECISION_FILE="$decision_file" \
      run_agent "$task" "$(cat "$_r2_prompt_file")" SCOUT \
        >>"$STATE_DIR/logs/t${task}.route-v2.log" 2>&1
    agent_rc=$?
    guard_after=$(_route_v2_guard_snapshot "$task" "$attempt" scout "$visit_id-$attempt_no" after) || return
    _route_v2_guard_verify SCOUT scout "$guard_before" "$guard_after" || {
      rc=$?
      _route_v2_bootstrap_abort_lifecycle_v2 "$lifecycle_active" "$execution_open" "$retry_after" policy_rejected
      return "$rc"
    }
    if (( agent_rc == 79 )); then
      _route_v2_bootstrap_abort_lifecycle_v2 "$lifecycle_active" "$execution_open" "$retry_after" unavailable
      _route_v2_fail "run_agent отказал по конфигурации хоста (код 79): исправь и повтори resume"
      return 75
    fi
    IFS=$'\t' read -r result run_id verdict_b64 run_epoch comment_b64 \
      < <(_route_v2_active_result "$active" execution) || {
        _route_v2_bootstrap_abort_lifecycle_v2 "$lifecycle_active" "$execution_open" "$retry_after" conflict
        return 78
      }
    if [[ "$run_id" != "${MULTI_LAST_RUN_ID:-}" || "$run_epoch" != "${MULTI_LAST_RUN_EPOCH:-}" ]]; then
      _route_v2_bootstrap_abort_lifecycle_v2 "$lifecycle_active" "$execution_open" "$retry_after" conflict
      return 78
    fi
    [[ "$verdict_b64" != - ]] || verdict_b64=""
    execution_status=succeeded
    execution_reason=normal
    if [[ "$result" == no-result ]]; then
      execution_status=failed
      execution_reason=no_result
    elif [[ "$result" == failed ]]; then
      execution_status=failed
      execution_reason=product_failure
    fi
    if [[ "$result" != no-result ]]; then
      run_state_verdict_validate "$result" "$verdict_b64" || {
        _route_v2_bootstrap_abort_lifecycle_v2 "$lifecycle_active" "$execution_open" "$retry_after" conflict
        return 78
      }
    fi
    [[ -z "$verdict_b64" ]] || verdict_hash=$(printf '%s' "$verdict_b64" | base64 -d | sha256sum | awk '{print $1}')
    runtime_lifecycle_node_execution_finish_v2 \
      "$execution_status" "$execution_reason" "$retry_after" \
      "$([[ "$result" != no-result ]] && printf '%s' "$result")" \
      "$([[ "$result" != no-result ]] && printf typed_verdict || printf none)" \
      "$verdict_hash" "$run_id" >/dev/null || return
    execution_open=0
    if [[ "$result" != done ]]; then
      python3 - "$runs_file" "$run_id" "$run_epoch" "$result" <<'RUNS'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
runs = json.loads(path.read_text())
runs.append({'runId': sys.argv[2], 'epoch': int(sys.argv[3]),
             'result': None if sys.argv[4] == 'no-result' else sys.argv[4]})
path.write_text(json.dumps(runs) + '\n')
RUNS
    fi
    [[ "$result" == no-result ]] || break
    tries_left=$((tries_left - 1))
    if (( tries_left == 0 )); then
      result=exhausted
      break
    fi
    attempt_no=$((attempt_no + 1))
  done
  rm -f -- "$_r2_context_file" "$_r2_prompt_file"
  [[ -z "$decision_file" ]] || rm -f -- "$decision_file"
  if [[ "$result" != done ]]; then
    reason_file=$(mktemp "$(factory_control_root)/.bootstrap-reason.XXXXXX") || return 1
    if [[ "$result" == exhausted ]]; then
      printf 'SCOUT: исчерпан бюджет повторов — %s исполнений без результата (%s)' \
        "$attempt_no" "${MULTI_LAST_OUTCOME_CLASS:-no_result}" >"$reason_file"
    elif [[ "$comment_b64" != - ]]; then
      printf '%s' "$comment_b64" | base64 -d >"$reason_file" || return 78
    fi
    if [[ ! -s "$reason_file" ]]; then
      printf 'SCOUT: исход %s требует решения человека' "$result" >"$reason_file"
    fi
    stop_json=$(attempt_bootstrap_journal_v2 stop "$task" "$attempt" "$ROUTE_V2_PROFILE" \
      "$visit_id" "$result" "$reason_file" "$verdict_b64" "$runs_file") || return
    rm -f -- "$reason_file" "$runs_file"
    runtime_lifecycle_node_visit_finish_v2 \
      "$execution_status" "$([[ "$result" == exhausted ]] && printf exhausted || printf '%s' "$execution_reason")" \
      forward_transition "tr_$(jq -r '.recordHash[:32]' <<<"$stop_json")" '' >/dev/null || return
    runtime_lifecycle_attempt_span_finish_v2 \
      bootstrap_finished "bootstrap:scout" "$execution_status" "$execution_reason" '' >/dev/null || return
    printf '%s\n' "$stop_json"
    return 22
  fi
  rm -f -- "$runs_file"

  transition_tmp=$(mktemp "$(factory_control_root)/.route-v2-transition.XXXXXX") || {
    _route_v2_bootstrap_abort_lifecycle_v2 \
      "$lifecycle_active" 0 "$retry_after" unavailable
    return 1
  }
  "$FACTORY_HOME/bin/factory-route" \
    --routes-dir "$ROUTE_V2_ROUTES_DIR" \
    --profile "$ROUTE_V2_PROFILE" \
    transition-bootstrap \
    --catalog-hash "$ROUTE_V2_CATALOG" \
    --node scout \
    --outcome done >"$transition_tmp" || {
      rc=$?
      rm -f -- "$transition_tmp"
      _route_v2_bootstrap_abort_lifecycle_v2 \
        "$lifecycle_active" 0 "$retry_after" unavailable
      return "$rc"
    }
  record_tmp=$(mktemp "$ROUTE_V2_ATTEMPT_DIR/artifacts/.bootstrap.XXXXXX") || {
    rm -f -- "$transition_tmp"
    _route_v2_bootstrap_abort_lifecycle_v2 \
      "$lifecycle_active" 0 "$retry_after" unavailable
    return 1
  }
  _route_v2_bootstrap_record make \
    "$transition_tmp" "$task" "$attempt" "$ROUTE_V2_PROFILE" "$ROUTE_V2_CATALOG" \
    "$ROUTE_V2_ROUTE" "$ROUTE_V2_ROUTE_HASH" "$run_id" "$run_epoch" "$verdict_b64" "$record_tmp" || {
      rc=$?
      rm -f -- "$transition_tmp" "$record_tmp"
      _route_v2_bootstrap_abort_lifecycle_v2 \
        "$lifecycle_active" 0 "$retry_after" conflict
      return "$rc"
    }
  chmod 400 "$record_tmp" || {
    rm -f -- "$transition_tmp" "$record_tmp"
    _route_v2_bootstrap_abort_lifecycle_v2 \
      "$lifecycle_active" 0 "$retry_after" unavailable
    return 1
  }
  _attempt_state_lock "$task" checkpoint_lock || {
    rm -f -- "$transition_tmp" "$record_tmp"
    return 1
  }
  _attempt_stage_state_load_locked "$task" "$attempt" "$ROUTE_V2_ROUTE"
  rc=$?
  if (( rc == 0 )); then
    if [[ -e "$artifact" || -L "$artifact" ]]; then
      _route_v2_bootstrap_record validate \
        "$artifact" "$task" "$attempt" "$ROUTE_V2_PROFILE" "$ROUTE_V2_CATALOG" \
        "$ROUTE_V2_ROUTE" "$ROUTE_V2_ROUTE_HASH"
      rc=$?
      if (( rc == 0 )) && ! cmp -s -- "$record_tmp" "$artifact"; then
        rc=75
      fi
    else
      mv -- "$record_tmp" "$artifact" || rc=$?
      sync -f "$ROUTE_V2_ATTEMPT_DIR/artifacts" 2>/dev/null || true
    fi
  fi
  _attempt_state_unlock "$checkpoint_lock"
  rm -f -- "$transition_tmp" "$record_tmp"
  if (( rc != 0 )); then
    _route_v2_bootstrap_abort_lifecycle_v2 \
      "$lifecycle_active" 0 "$retry_after" conflict
    return "$rc"
  fi
  # Узел закрыт — черновик подписываем исходом, а не стираем (см. `_stage_checkpoint_seal`):
  # заход сюда бывает и вторым, и тогда его заметки о том, что уже осмотрено, дешевле
  # любого повторного обхода дерева.
  declare -F _stage_checkpoint_seal >/dev/null &&
    _stage_checkpoint_seal "$task" SCOUT done
  attempt_bootstrap_journal_v2 completed "$task" "$attempt" "$ROUTE_V2_PROFILE" "$visit_id" >/dev/null || return
  runtime_lifecycle_node_visit_finish_v2 succeeded normal forward_transition '' '' >/dev/null || return
  runtime_lifecycle_attempt_span_finish_v2 bootstrap_finished "bootstrap:scout" succeeded normal '' >/dev/null || return
  cat -- "$artifact"
}

route_v2_dispatch_next() {
  local task attempt cursor_tmp description_tmp state node sequence
  local executor phase run_key policy rc
  local fanout_mode fanout_max fanout_degrade retry_no_result retry_product
  local provider_attempts provider_strategy browser_policy timeout_class command_id
  local visit_reason visit_transition visit_stage_hash execution_reason retry_before
  local execution_status execution_finish_reason execution_outcome execution_source
  local verdict_hash final_run
  _route_v2_require_isolation || return
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  _route_v2_require_runner_invariant "$task" || return
  _route_v2_load_attempt "$task" "$attempt" || return

  cursor_tmp=$(mktemp "$(factory_control_root)/.route-v2-cursor.XXXXXX") || return 1
  attempt_stage_state_read_v2 "$task" "$attempt" >"$cursor_tmp" || {
    rc=$?
    rm -f -- "$cursor_tmp"
    return "$rc"
  }
  IFS=$'\t' read -r state node sequence < <(_route_v2_json cursor "$cursor_tmp") || {
    rm -f -- "$cursor_tmp"
    return 78
  }
  rm -f -- "$cursor_tmp"
  [[ "$state" != stopped ]] || return 21
  [[ "$state" != paused ]] || return 20

  description_tmp=$(mktemp "$(factory_control_root)/.route-v2-machine.XXXXXX") || return 1
  "$FACTORY_HOME/bin/factory-route" \
    --routes-dir "$ROUTE_V2_ROUTES_DIR" \
    --profile "$ROUTE_V2_PROFILE" \
    describe-route \
    --catalog-hash "$ROUTE_V2_CATALOG" \
    --route "$ROUTE_V2_ROUTE" >"$description_tmp" || {
      rc=$?
      rm -f -- "$description_tmp"
      return "$rc"
    }
  IFS=$'\t' read -r executor phase run_key policy fanout_mode fanout_max fanout_degrade \
    retry_no_result retry_product provider_attempts provider_strategy browser_policy \
    timeout_class command_id \
    < <(_route_v2_json node "$description_tmp" "$node") || {
      rm -f -- "$description_tmp"
      return 78
    }
  local loop_lead="" loop_worker="" loop_role="" loop_max_rounds=0
  IFS=$'\t' read -r loop_lead loop_worker < <(_route_v2_json loop "$description_tmp") || {
    rm -f -- "$description_tmp"
    return 78
  }
  rm -f -- "$description_tmp"
  # Режим «цикл»: потолок кругов проверяется до запуска любой модели, чтобы опечатка
  # в профиле не превратилась в молчаливое значение по умолчанию посреди работы.
  if [[ -n "$loop_lead" ]]; then
    loop_max_rounds=$(route_v2_loop_max_rounds) || return 78
    if [[ "$node" == "$loop_lead" ]]; then
      loop_role=lead
    elif [[ "$node" == "$loop_worker" ]]; then
      loop_role=worker
    fi
  fi

  if [[ "$executor" == gate ]]; then
    IFS=$'\t' read -r visit_reason visit_transition visit_stage_hash \
      < <(_route_v2_lifecycle_stage_edge "$task" "$attempt" "$sequence") || return 78
    runtime_lifecycle_node_visit_begin_v2 "$node" "$run_key" "$sequence" \
      "$visit_reason" "$visit_transition" "$visit_stage_hash" >/dev/null || return
    attempt_stage_state_pause_v2 \
      "$task" "$attempt" "$node" "human gate: $node" >/dev/null || {
        rc=$?
        runtime_lifecycle_node_visit_finish_v2 \
          interrupted conflict attempt_interrupted '' '' >/dev/null || true
        return "$rc"
      }
    _route_v2_lifecycle_gate_wait_after_pause "$task" "$attempt" "$node" || {
      rc=$?
      runtime_lifecycle_node_visit_finish_v2 \
        interrupted unavailable attempt_interrupted '' '' >/dev/null || true
      return "$rc"
    }
    if declare -F route_v2_project_work_time >/dev/null; then
      # Метка последнего события = вход в ворота: по ней доска дотикивает
      # ожидание решения. Витрина: ошибка пересчёта не удерживает диспетчер.
      route_v2_project_work_time "$task" "$attempt" || true
    fi
    return 20
  fi
  [[ "$executor" == agent || "$executor" == command ]] ||
    _route_v2_fail "executor=$executor is not implemented by route-v2 runtime" || return
  _route_v2_node_caps_guard \
    "$executor" "$policy" "$fanout_mode" "$fanout_max" "$fanout_degrade" \
    "$provider_strategy" || return
  if [[ "$executor" == command &&
        ( "$retry_no_result" != 0 || "$retry_product" != 0 ||
          "$provider_attempts" != 0 || "$provider_strategy" != none ) ]]; then
    _route_v2_fail "command=$command_id must declare zero/none retry policy" || return
  fi
  IFS=$'\t' read -r visit_reason visit_transition visit_stage_hash \
    < <(_route_v2_lifecycle_stage_edge "$task" "$attempt" "$sequence") || return 78
  runtime_lifecycle_node_visit_begin_v2 "$node" "$run_key" "$sequence" \
    "$visit_reason" "$visit_transition" "$visit_stage_hash" >/dev/null || return
  _route_v2_mark_node_running "$task" "$node" "$run_key"

  # Ретраи по контракту бандла. Попытки без результата (no-result и провайдерский
  # сбой на этой границе неразличимы: multi-runner уже исчерпал failover-цепочку
  # внутри run_agent, поэтому бюджеты noResult и providerFailure суммируются)
  # повторяются; исчерпание бюджета — синтетический исход exhausted, который
  # вырабатывает ДОВЕРЕННЫЙ рантайм, а не агент. Committed failed повторяется
  # только в пределах productFailure-бюджета.
  # Номер захода и причина повтора уезжают агенту: повтор, не знающий о следах
  # предыдущего захода, переделывает работу с нуля.
  local outcome="" cleanup_rc attempt_no=1 retry_reason="" retry_note="" verdict_b64=""
  local hard_rewind_limit=2 no_progress_limit=0
  # Суммарный предохранитель по target за попытку: per-arc лимиты не ловят
  # чередование дуг в один узел (на 8162 в build шесть раз возвращал review и
  # один раз lint, не исчерпав ни одной дуги). Решением человека не обнуляется.
  local target_rewind_budget=10
  local tries_left=$(( 1 + retry_no_result + provider_attempts ))
  # Причина исчерпания бюджета — человеку: сколько заходов ушло впустую и чем кончился
  # последний. Её читают карточка остановки (комментарий узла) и строка остановки в
  # журнале стадий; без цифр остановка выглядела как «узел вернул решение человеку».
  local exhausted_reason="исчерпан бюджет повторов: раннер не зафиксировал результат"
  local product_left=$retry_product
  # Отказ evidence-хука хоста — отдельный бюджет, не зависящий от productFailure бандла:
  # агент отчитался done, а хост не принял доказательства. Один повтор с цитатой причины
  # чинит ровно такие сдачи (t8702: лишний файл в manifest тестов); второй отказ подряд
  # значит, что цитаты агенту не хватило, и решает уже человек. Причина последнего отказа
  # уходит в реестр и в журнал стадий, чтобы человек не собирал её по route-v2.log.
  local evidence_left=1
  ROUTE_V2_EVIDENCE_STOP_REASON=""
  # Указание человека при возврате курсора сюда. Читаем ОДИН раз на вход в узел, а не
  # на каждый заход: журнал за время узла не меняется, а каждое чтение — обход всех
  # событий попытки под локом. Держится до коммита узла, поэтому повторы его тоже видят.
  local human_note=""
  if [[ "$executor" == command ]]; then
    runtime_lifecycle_node_execution_begin_v2 command 0 0 initial >/dev/null || {
      rc=$?
      runtime_lifecycle_node_visit_finish_v2 \
        interrupted unavailable attempt_interrupted '' '' >/dev/null || true
      return "$rc"
    }
    _route_v2_run_command_node \
      "$task" "$attempt" "$node" "$run_key" "$command_id" "$policy" "$sequence"
    rc=$?
    if (( rc != 0 )); then
      runtime_lifecycle_node_execution_finish_v2 failed unavailable 0 '' none '' '' \
        >/dev/null || return
      runtime_lifecycle_node_visit_finish_v2 interrupted unavailable attempt_interrupted '' '' \
        >/dev/null || return
      return "$rc"
    fi
    outcome=$ROUTE_V2_NODE_RESULT
    verdict_b64=${ROUTE_V2_NODE_VERDICT_B64:-}
    verdict_hash=""
    [[ -z "$verdict_b64" ]] || verdict_hash=$(printf '%s' "$verdict_b64" | base64 -d | sha256sum | awk '{print $1}')
    execution_status=succeeded
    execution_finish_reason=normal
    [[ "$outcome" != failed ]] || { execution_status=failed; execution_finish_reason=product_failure; }
    runtime_lifecycle_node_execution_finish_v2 "$execution_status" "$execution_finish_reason" \
      0 "$outcome" command_verdict "$verdict_hash" '' >/dev/null || {
        rc=$?
        runtime_lifecycle_node_visit_finish_v2 \
          interrupted unavailable attempt_interrupted '' '' >/dev/null || true
        return "$rc"
      }
  else
    human_note=$(attempt_stage_state_human_note_v2 "$task" "$attempt" "$node") || {
      rc=$?
      runtime_lifecycle_node_visit_finish_v2 \
        interrupted unavailable attempt_interrupted '' '' >/dev/null || true
      return "$rc"
    }
    while :; do
      case "$retry_reason" in
        '') execution_reason=initial ;;
        no-result) execution_reason=no_result ;;
        # Отказ сторожа для lifecycle — тот же продуктовый отказ: словарь причин
        # исполнения закреплён аналитикой, а различие живёт в цитате промпта.
        failed|evidence-rejected) execution_reason=product_failure ;;
        *) execution_reason=manual_resume ;;
      esac
      retry_before=$((tries_left + product_left + evidence_left - 1))
      (( retry_before >= 0 )) || retry_before=0
      runtime_lifecycle_node_execution_begin_v2 agent "$((attempt_no - 1))" \
        "$retry_before" "$execution_reason" >/dev/null || {
          rc=$?
          runtime_lifecycle_node_visit_finish_v2 \
            interrupted unavailable attempt_interrupted '' '' >/dev/null || true
          return "$rc"
        }
      ROUTE_V2_FINAL_RUN_ID=""
      ROUTE_V2_NODE_BROWSER="$browser_policy" \
      ROUTE_V2_NODE_TIMEOUT_CLASS="$timeout_class" \
      ROUTE_V2_NODE_FANOUT_MODE="$fanout_mode" \
      ROUTE_V2_NODE_FANOUT_MAX="$fanout_max" \
      ROUTE_V2_NODE_FANOUT_DEGRADE="$fanout_degrade" \
      ROUTE_V2_NODE_RETRY="$attempt_no" \
      ROUTE_V2_NODE_HUMAN_NOTE="$human_note" \
      ROUTE_V2_NODE_RETRY_NOTE="$retry_note" \
      ROUTE_V2_NODE_LOOP_ROLE="$loop_role" \
      ROUTE_V2_NODE_RETRY_REASON="$retry_reason" _route_v2_run_agent_node \
        "$task" "$attempt" "$node" "$run_key" "$policy" "$sequence"
      rc=$?
      if (( rc == 75 )) && [[ "${ROUTE_V2_NO_RESULT:-0}" == 1 ]]; then
        runtime_lifecycle_node_execution_finish_v2 failed no_result \
          "$(( tries_left > 0 ? tries_left - 1 : 0 ))" '' none '' \
          "${ROUTE_V2_FINAL_RUN_ID:-}" >/dev/null || return
        route_v2_cleanup_active_instrumentation "$task" "$attempt"
        cleanup_rc=$?
        (( cleanup_rc == 0 || cleanup_rc == 3 )) || {
          runtime_lifecycle_node_visit_finish_v2 \
            interrupted cleanup_failed attempt_interrupted '' '' >/dev/null || true
          return "$cleanup_rc"
        }
        tries_left=$(( tries_left - 1 ))
        if (( tries_left > 0 )); then
          attempt_no=$(( attempt_no + 1 ))
          retry_reason=no-result
          # Класс исхода уезжает в блок повтора: «убит по лимиту времени» и «процесс упал»
          # требуют от повтора разного. После таймаута бюджет времени съеден целиком, и
          # повтор с прежним веером ролей съест его снова (t7989: три захода по 30 минут,
          # каждый заново поднимал три роли и был убит перед stage-result). Узел, который
          # допускает одиночный режим, на таком повторе идёт без веера: заметки ролей уже
          # лежат в черновике и артефактах, заходу остаётся свести их и отчитаться.
          retry_note=${ROUTE_V2_NO_RESULT_CLASS:-}
          if [[ "$retry_note" == timeout && "$fanout_degrade" == allow-single ]]; then
            fanout_mode=single
          fi
          continue
        fi
        outcome=exhausted
        verdict_b64=""
        exhausted_reason="исчерпан бюджет повторов: $(_route_v2_runs_phrase "$attempt_no")"
        exhausted_reason+=" без результата, последний —"
        if [[ -n "${ROUTE_V2_NO_RESULT_DETAIL:-}" ]]; then
          exhausted_reason+=" ${ROUTE_V2_NO_RESULT_DETAIL}"
        else
          exhausted_reason+=" $(_route_v2_no_result_label "${ROUTE_V2_NO_RESULT_CLASS:-}")"
        fi
        break
      fi
      if (( rc != 0 )); then
        runtime_lifecycle_node_execution_finish_v2 interrupted unavailable \
          "$retry_before" '' none '' "${ROUTE_V2_FINAL_RUN_ID:-}" >/dev/null || return
        runtime_lifecycle_node_visit_finish_v2 interrupted unavailable attempt_interrupted '' '' \
          >/dev/null || return
        route_v2_cleanup_active_instrumentation "$task" "$attempt"
        cleanup_rc=$?
        (( cleanup_rc == 0 || cleanup_rc == 3 )) || {
          runtime_lifecycle_node_visit_finish_v2 \
            interrupted cleanup_failed attempt_interrupted '' '' >/dev/null || true
          return "$cleanup_rc"
        }
        return "$rc"
      fi
      verdict_hash=""
      [[ -z "${ROUTE_V2_NODE_VERDICT_B64:-}" ]] || \
        verdict_hash=$(printf '%s' "$ROUTE_V2_NODE_VERDICT_B64" | base64 -d | sha256sum | awk '{print $1}')
      execution_status=succeeded
      execution_finish_reason=normal
      execution_source=typed_verdict
      [[ "$ROUTE_V2_NODE_RESULT" != failed ]] || {
        execution_status=failed
        execution_finish_reason=product_failure
      }
      runtime_lifecycle_node_execution_finish_v2 "$execution_status" \
        "$execution_finish_reason" "$retry_before" "$ROUTE_V2_NODE_RESULT" \
        "$execution_source" "$verdict_hash" "${ROUTE_V2_FINAL_RUN_ID:-}" >/dev/null || {
          rc=$?
          runtime_lifecycle_node_visit_finish_v2 \
            interrupted unavailable attempt_interrupted '' '' >/dev/null || true
          return "$rc"
        }
      if [[ "$ROUTE_V2_NODE_RESULT" == failed && "${ROUTE_V2_EVIDENCE_REJECTED:-0}" == 1 ]]; then
        # Отказ сторожа не тратит productFailure-бюджет бандла: тот повтор идёт без
        # цитаты причины и был бы слепым — ровно тем, чего сторож не лечит.
        if (( evidence_left > 0 )); then
          route_v2_cleanup_active_instrumentation "$task" "$attempt"
          cleanup_rc=$?
          (( cleanup_rc == 0 || cleanup_rc == 3 )) || {
            runtime_lifecycle_node_visit_finish_v2 \
              interrupted cleanup_failed attempt_interrupted '' '' >/dev/null || true
            return "$cleanup_rc"
          }
          evidence_left=$(( evidence_left - 1 ))
          attempt_no=$(( attempt_no + 1 ))
          retry_reason=evidence-rejected
          retry_note=${ROUTE_V2_EVIDENCE_REASON:-}
          declare -F v2_log >/dev/null &&
            v2_log "${run_key}: сторож отверг сдачу — ${retry_note:-причина не названа}; повтор с её цитатой"
        else
          ROUTE_V2_EVIDENCE_STOP_REASON="сторож отверг сдачу — ${ROUTE_V2_EVIDENCE_REASON:-причина не названа}"
          declare -F v2_log >/dev/null &&
            v2_log "${run_key}: ${ROUTE_V2_EVIDENCE_STOP_REASON}; повтор не помог"
          outcome=$ROUTE_V2_NODE_RESULT
          verdict_b64=${ROUTE_V2_NODE_VERDICT_B64:-}
          break
        fi
        continue
      fi
      if [[ "$ROUTE_V2_NODE_RESULT" == failed ]] && (( product_left > 0 )); then
        route_v2_cleanup_active_instrumentation "$task" "$attempt"
        cleanup_rc=$?
        (( cleanup_rc == 0 || cleanup_rc == 3 )) || {
          runtime_lifecycle_node_visit_finish_v2 \
            interrupted cleanup_failed attempt_interrupted '' '' >/dev/null || true
          return "$cleanup_rc"
        }
        product_left=$(( product_left - 1 ))
        attempt_no=$(( attempt_no + 1 ))
        retry_reason=failed
        continue
      fi
      outcome=$ROUTE_V2_NODE_RESULT
      verdict_b64=${ROUTE_V2_NODE_VERDICT_B64:-}
      break
    done
  fi
  # Агент сдал done, сторож отверг и повтор не помог: реестр до этой строки хранит
  # `done` и победный отчёт агента (их записал stage-result), а маршрут встал. Узел
  # переводится в failed, причина — в комментарий поверх отчёта: карточка остановки
  # и модалка узла читают именно его, а не route-v2.log.
  if [[ "$executor" == agent && "$outcome" == failed && -n "$ROUTE_V2_EVIDENCE_STOP_REASON" ]]; then
    local agent_comment
    agent_comment=$(pipeline_store_get "$task" "${run_key}_COMMENT" 2>/dev/null) || agent_comment=""
    run_state_control_update \
      "$task" "$run_key" failed \
      "${run_key}_COMMENT" \
      "${ROUTE_V2_EVIDENCE_STOP_REASON}${agent_comment:+ · отчёт агента: $agent_comment}" \
      || {
        rc=$?
        runtime_lifecycle_node_visit_finish_v2 \
          interrupted conflict attempt_interrupted '' '' >/dev/null || true
        return "$rc"
      }
  fi
  if [[ "$executor" == agent && ( "$outcome" == failed || "$outcome" == exhausted ) ]]; then
    route_v2_cleanup_active_instrumentation "$task" "$attempt"
    rc=$?
    (( rc == 0 || rc == 3 )) || {
      runtime_lifecycle_node_visit_finish_v2 \
        interrupted cleanup_failed attempt_interrupted '' '' >/dev/null || true
      return "$rc"
    }
  fi
  # Legacy failed без typed verdict сохраняет прежний бюджет двух возвратов. Typed
  # verdict получает широкий hard ceiling, но останавливается раньше при расширении
  # замкнутого набора finding id, при первом повторе того же набора после ремонта
  # или A↔B-осцилляции.
  # На дуге закреплённого цикла эти эвристики и предел серии не применяются:
  # решение ведущего ограничивает loop_max_rounds в доверенном коммите.
  if [[ -n "$verdict_b64" ]]; then
    hard_rewind_limit=6
    no_progress_limit=2
  fi
  # exhausted синтезирует host после серии запусков без terminal status. Последний
  # run-state поэтому всё ещё active, а вторичная проекция — running: на доске это
  # выглядит как живой агент после фактической остановки маршрута. Закрываем exact
  # fencing record доверенным control-path и показываем узел как failed; run id/epoch
  # остаются на месте, чтобы следующий запуск получил строго большую эпоху.
  if [[ "$outcome" == exhausted ]]; then
    run_state_control_update \
      "$task" "$run_key" failed \
      "${run_key}_COMMENT" "$exhausted_reason" \
      || {
        rc=$?
        runtime_lifecycle_node_visit_finish_v2 \
          interrupted conflict attempt_interrupted '' '' >/dev/null || true
        return "$rc"
      }
  fi
  _route_v2_commit_and_project \
    "$task" "$attempt" "$node" "$outcome" "$hard_rewind_limit" \
    "$verdict_b64" "$no_progress_limit" 0 "$target_rewind_budget" "" \
    "$loop_max_rounds" || {
      rc=$?
      runtime_lifecycle_node_visit_finish_v2 \
        interrupted conflict attempt_interrupted '' '' >/dev/null || true
      return "$rc"
    }
  # Черновик хода после терминального коммита НЕ стирается, а подписывается исходом
  # (`_stage_checkpoint_seal`): узел, закрытый `done`, критик отклоняет штатно, и второй
  # заход обязан начать с того, что уже сделано, — иначе он получает промпт, побайтово
  # равный первому, и заново выводит ту же разведку с повторным расходом контекста.
  # failed/exhausted — тем более не «закрыто», а «остановлено и передано человеку»: узел
  # ещё будут переигрывать, и черновик — единственная запись о том, где именно застряли.
  # Если TESTS отчитается «детали и остаток — t<TASK>.tests.checkpoint.md», а движок сотрёт
  # файл следующей строкой, человек у остановленного маршрута останется с одним
  # предложением комментария вместо разбора (что доказано, что нет, что осталось сделать).
  # Такой заход подписи не получает: он ничем не закончился, и блок промпта обязан назвать
  # это обрывом, а не завёрнутой работой.
  if [[ "$outcome" != failed && "$outcome" != exhausted ]]; then
    declare -F _stage_checkpoint_seal >/dev/null &&
      _stage_checkpoint_seal "$task" "$run_key" "$outcome"
  fi
  return 0
}

route_v2_dispatch_until_pause() {
  local task=${1:-} attempt=${2:-} max=${3:-100} step rc
  [[ "$max" =~ ^[1-9][0-9]{0,3}$ ]] || return 2
  for (( step=0; step<max; step++ )); do
    route_v2_dispatch_next "$task" "$attempt"
    rc=$?
    case "$rc" in
      0) ;;
      20|21) return "$rc" ;;
      *) return "$rc" ;;
    esac
  done
  _route_v2_fail "maximum step count reached"
}

# Цепочка сброса для возврата курсора на узел: сам узел и всё, что идёт после
# него по последовательности ЗАКРЕПЛЁННОГО маршрута, — результаты пройденного
# хвоста обязаны сняться вместе с переигрываемым узлом.
_route_v2_reset_chain() {
  local node
  node=$(_attempt_stage_state_node_id "${1:-}") || return
  "$FACTORY_HOME/bin/factory-route" \
    --routes-dir "$ROUTE_V2_ROUTES_DIR" \
    --profile "$ROUTE_V2_PROFILE" \
    describe-route \
    --catalog-hash "$ROUTE_V2_CATALOG" \
    --route "$ROUTE_V2_ROUTE" |
  python3 -c '
import json
import sys

machine = json.load(sys.stdin)["machine"]
target = sys.argv[1]
chain = list(machine["sequence"]["main"]) + list(machine["sequence"]["tail"])
if target not in chain:
    raise SystemExit(2)
print(",".join(chain[chain.index(target):]))
' "$node"
}

# Лежит ли узел ВНУТРИ транзакционной зоны маршрута: строго после instrument и не
# дальше proof. Ровно этот отрезок исполняется внутри ОДНОЙ транзакции инструментации —
# её открывает instrument, намеренно не закрывает, и закрывает за собой proof.
#
# Зона СЧИТАЕТСЯ ПО ЗАКРЕПЛЁННОЙ ЦЕПОЧКЕ, а не перечисляется именами узлов. Перечисление
# уже стоило прогона: список `diagnose|hyposkeptic|proof` в восстановлении был слепком
# топологии маршрута `debug`, а консилиум поставил в ту же зону ещё пять узлов (три
# мнения, свод и председателя). Обрыв на председателе восстановление не узнавало, прогон
# продолжался и через час работы падал на proof кодом 78 без единого слова о причине.
#
# Печатает `inside` либо `outside`. Маршрут без пары instrument/proof зоны не имеет.
# Ненулевой код — цепочку прочитать не удалось; оба потребителя считают это `outside`,
# потому что выдуманный возврат хуже отсутствующего.
_route_v2_transaction_zone() {
  local node=$1 chain_json
  node=$(_attempt_stage_state_node_id "$node") || return 1
  chain_json=$("$FACTORY_HOME/bin/factory-route" \
    --routes-dir "$ROUTE_V2_ROUTES_DIR" \
    --profile "$ROUTE_V2_PROFILE" \
    describe-route \
    --catalog-hash "$ROUTE_V2_CATALOG" \
    --route "$ROUTE_V2_ROUTE") || return 1
  printf '%s' "$chain_json" | python3 -c '
import json
import sys

machine = json.load(sys.stdin)["machine"]
target = sys.argv[1]
chain = list(machine["sequence"]["main"]) + list(machine["sequence"]["tail"])
if "instrument" not in chain or "proof" not in chain or target not in chain:
    print("outside")
    raise SystemExit(0)
first = chain.index("instrument")
last = chain.index("proof")
index = chain.index(target)
print("inside" if first < index <= last else "outside")
' "$node"
}

# Возврат курсора в зону instrument→proof при закрытой транзакции делает proof
# НЕИСПОЛНИМЫМ. Топология такая: instrument открывает транзакцию инструментации и
# намеренно её не закрывает (`_route_v2_transaction_after`), proof работает внутри
# неё и закрывает за собой. Значит после первого прохода proof транзакции больше
# нет, а переоткрыть её может только instrument — он остаётся `done` и в reset
# возврата на промежуточный узел не попадает.
#
# Без этого гарда отказ приходил не в момент решения человека, а через 12 минут
# работы промежуточных узлов вхолостую: диспетчер доходил до proof и валился
# fail-closed кодом 78 без единого слова о причине. Гард переносит отказ на нажатие
# кнопки и называет оба
# выхода — иначе человек видит только «прогон опять встал».
#
# Возвращает 0, если возврат безопасен; 1 — если цель лежит в зоне, а транзакции
# нет. Третий аргумент (опционально) — имя переменной для текста отказа.
_route_v2_goto_transaction_guard() {
  local task=$1 node=$2 out_var=${3:-} zone
  node=$(_attempt_stage_state_node_id "$node") || return 0
  # Транзакция открыта — возврат куда угодно безопасен, proof её унаследует.
  _route_v2_transaction_active_id "$task" >/dev/null 2>&1 && return 0
  zone=$(_route_v2_transaction_zone "$node") || return 0
  [[ "$zone" == inside ]] || return 0
  if [[ -n "$out_var" ]]; then
    printf -v "$out_var" '%s' "возврат на «$node» невозможен: узел proof обязан исполняться внутри
транзакции инструментации, а её открывает только instrument. Транзакцию закрыл
предыдущий проход proof, поэтому маршрут дошёл бы до него и упал fail-closed.
Выходы два: вернуть курсор на instrument (переиграется весь хвост за ним, включая
консилиум) либо вернуть за proof — на translator или дальше, оставив прошлое
доказательство в силе."
  fi
  return 1
}

# Продолжение после остановки «исчерпан бюджет повторов». Курсор стоит на
# stop=human с последним коммитом exhausted: раннер результата не зафиксировал
# (лежал провайдер или окружение), поэтому разбирать исход агента нечего, а
# бюджет повторов локален заходу в узел и заводится заново самим диспетчером.
# «Продолжить» в такой остановке — решение человека переиграть узел; фиксируем
# его тем же доверенным событием human-rewind, что и goto: курсор возвращается
# на узел, результаты хвоста маршрута сбрасываются, автоматические счётчики
# возвратов начинают новую серию. Остановки rewind-limit/no-progress и исход
# failed сюда не попадают: они по-прежнему ждут явного goto с новой гипотезой,
# а терминальный stop=failed ledger отклонит сам.
# Печатает узел, на который вернулся курсор; пустой вывод — возврат не нужен.
route_v2_rewind_exhausted_stop() {
  local task attempt cursor_tmp state stop last_node last_outcome reset rc
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  _route_v2_load_attempt "$task" "$attempt" || return
  cursor_tmp=$(mktemp "$(factory_control_root)/.route-v2-cursor.XXXXXX") || return 1
  attempt_stage_state_read_v2 "$task" "$attempt" >"$cursor_tmp" || {
    rc=$?
    rm -f -- "$cursor_tmp"
    return "$rc"
  }
  IFS=$'\t' read -r state stop last_node last_outcome \
    < <(_route_v2_json cursor-stop "$cursor_tmp") || {
      rm -f -- "$cursor_tmp"
      return 78
    }
  rm -f -- "$cursor_tmp"
  [[ "$state" == stopped && "$stop" == human && "$last_outcome" == exhausted ]] ||
    return 0
  reset=$(_route_v2_reset_chain "$last_node") || return
  # Решает здесь ДВИЖОК, а не человек: бюджет повторов исчерпан, и рантайм сам двигает
  # курсор дальше. Пока исполнитель события не назывался, такой возврат лежал в журнале
  # неотличимо от человеческого `goto`.
  attempt_stage_state_human_rewind_v2 \
    "$task" "$attempt" "$last_node" "$reset" \
    "продолжение после исчерпанного бюджета повторов" engine >/dev/null || return
  printf '%s\n' "$last_node"
}

# Суффикс строки остановки для `human`, который объявил не вердикт агента, а сам runtime
# узла: исчерпанный бюджет повторов. Причина уже лежит в комментарии узла (см.
# `exhausted_reason` в исполнении узла), но GrigDesk читает причину остановки из ПОСЛЕДНЕЙ
# строки окна журнала стадий — без суффикса исчерпание показывалось как «узел вернул
# решение человеку» с советом прочитать замечание, которого агент не писал (t7989).
# Печатает суффикс с ведущим « — » либо ничего: у остановки с другим исходом своя причина.
route_v2_stop_line_suffix() {
  local task attempt cursor_tmp state stop last_node last_outcome reason rc

  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  cursor_tmp=$(mktemp "$(factory_control_root)/.route-v2-cursor.XXXXXX") || return 1
  attempt_stage_state_read_v2 "$task" "$attempt" >"$cursor_tmp" || {
    rc=$?
    rm -f -- "$cursor_tmp"
    return "$rc"
  }
  IFS=$'\t' read -r state stop last_node last_outcome \
    < <(_route_v2_json cursor-stop "$cursor_tmp") || {
      rm -f -- "$cursor_tmp"
      return 78
    }
  rm -f -- "$cursor_tmp"
  [[ "$state" == stopped && "$stop" == human && "$last_outcome" == exhausted ]] ||
    return 0
  [[ "$last_node" =~ ^[a-z0-9][a-z0-9_]{0,40}$ ]] || return 0
  reason=$(pipeline_store_get "$task" "${last_node^^}_COMMENT" 2>/dev/null) || reason=""
  printf ' — %s' "${reason:-исчерпан бюджет повторов}"
}

route_v2_gate_decide() {
  local task attempt node outcome reject_feedback description_tmp executor phase run_key policy rc
  local fanout_mode fanout_max fanout_degrade retry_no_result retry_product provider_attempts
  local provider_strategy browser_policy timeout_class command_id
  _route_v2_require_isolation || return
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  node=$(_attempt_stage_state_node_id "${3:-}") || return
  outcome=${4:-}
  reject_feedback=${5:-}
  local expected_sequence=${6:-} expected_hash=${7:-}
  [[ "$outcome" == approved || "$outcome" == rejected ]] || return 2
  [[ "$outcome" == rejected ]] || reject_feedback=
  # Ошибка получения списка не позволяет принять ворота вслепую.
  # Пустая успешно проверенная проекция остаётся обычной допустимой приёмкой.
  if [[ "$node" == gate_accept && "$outcome" == approved ]]; then
    attempt_stage_state_findings_v2 "$task" "$attempt" >/dev/null || {
      _route_v2_fail "приёмка удержана: находки попытки не удалось проверить" || return
    }
  fi
  _route_v2_require_runner_invariant "$task" || return
  _route_v2_load_attempt "$task" "$attempt" || return
  description_tmp=$(mktemp "$(factory_control_root)/.route-v2-machine.XXXXXX") || return 1
  "$FACTORY_HOME/bin/factory-route" \
    --routes-dir "$ROUTE_V2_ROUTES_DIR" \
    --profile "$ROUTE_V2_PROFILE" \
    describe-route \
    --catalog-hash "$ROUTE_V2_CATALOG" \
    --route "$ROUTE_V2_ROUTE" >"$description_tmp" || {
      rc=$?
      rm -f -- "$description_tmp"
      return "$rc"
    }
  IFS=$'\t' read -r executor phase run_key policy fanout_mode fanout_max fanout_degrade \
    retry_no_result retry_product provider_attempts provider_strategy browser_policy \
    timeout_class command_id \
    < <(_route_v2_json node "$description_tmp" "$node") || {
      rm -f -- "$description_tmp"
      return 78
    }
  _route_v2_gate_feedback_guard "$description_tmp" "$node" "$reject_feedback" || {
    rc=$?
    rm -f -- "$description_tmp"
    return "$rc"
  }
  rm -f -- "$description_tmp"
  [[ "$executor" == gate ]] || return 78
  if runtime_lifecycle_enabled_v2; then
    runtime_lifecycle_restore_open_visit_v2 "$node" || return
    runtime_lifecycle_restore_open_gate_v2 "$node" || return
  fi
  local ROUTE_V2_GATE_DECISION=$outcome ROUTE_V2_GATE_FEEDBACK=$reject_feedback
  _route_v2_commit_and_project \
    "$task" "$attempt" "$node" "$outcome" 0 '' 0 0 0 "$reject_feedback" 0 \
    "$expected_sequence" "$expected_hash"
}

# Сводка учтённого времени попытки: работа узлов без ворот отдельно от ожидания
# ворот. Секунды по узлам даёт журнальная проекция attempt_stage_state_work_time_v2,
# классификацию (ворота ли узел) — executor из закреплённого describe-route.
# Вывод TSV: WORK_S, GATE_WAIT_S, LAST_EVENT_EPOCH (0 — событий ещё нет).
route_v2_work_time() {
  local task attempt description_tmp ledger_tmp rc
  _route_v2_require_isolation || return
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  _route_v2_load_attempt "$task" "$attempt" || return
  description_tmp=$(mktemp "$(factory_control_root)/.route-v2-machine.XXXXXX") || return 1
  "$FACTORY_HOME/bin/factory-route" \
    --routes-dir "$ROUTE_V2_ROUTES_DIR" \
    --profile "$ROUTE_V2_PROFILE" \
    describe-route \
    --catalog-hash "$ROUTE_V2_CATALOG" \
    --route "$ROUTE_V2_ROUTE" >"$description_tmp" || {
      rc=$?
      rm -f -- "$description_tmp"
      return "$rc"
    }
  ledger_tmp=$(mktemp "$(factory_control_root)/.route-v2-work-time.XXXXXX") || {
    rm -f -- "$description_tmp"
    return 1
  }
  attempt_stage_state_work_time_v2 "$task" "$attempt" >"$ledger_tmp" || {
    rc=$?
    rm -f -- "$description_tmp" "$ledger_tmp"
    return "$rc"
  }
  _route_v2_json work-time "$description_tmp" "$ledger_tmp"
  rc=$?
  rm -f -- "$description_tmp" "$ledger_tmp"
  return "$rc"
}

# Отменяет транзакцию, которой владеет именно эта попытка. Сначала свежая контрольная точка
# относит к прерванному провайдеру только записи в заявленной области; любая запись вне
# области приводит к закрытому отказу. Устойчивое состояние `cleaning` продолжается после
# SIGKILL напрямую, а `completed` лишь исправляет устаревший указатель active.
_route_v2_cleanup_active_instrumentation_impl() {
  local task attempt txid dir state rc
  _route_v2_require_isolation || return
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  _route_v2_load_attempt "$task" "$attempt" || return
  txid=$(_route_v2_transaction_active_id "$task")
  rc=$?
  (( rc == 3 )) && return 3
  (( rc == 0 )) || return "$rc"
  [[ "$txid" =~ ^v2-${attempt#*_}-s[0-9]+$ ]] || return 75
  dir=$(instrumentation_tx_dir "$task" "$txid") || return
  [[ -d "$dir" && ! -L "$dir" && -f "$dir/state.env" &&
     ! -L "$dir/state.env" ]] || return 78
  state=$(_instrumentation_tx_get "$dir/state.env" STATE)
  # Причину stalled журналу отдаёт и этот путь. Раньше её писал только
  # _route_v2_transaction_after, поэтому остановка на снятии инструментации упавшего узла
  # оставляла в журнале одну строку «код 75»: REASON приходилось доставать из state.env
  # руками, не зная даже, что дело в транзакции, а не в раннере.
  case "$state" in
    active)
      instrumentation_tx_checkpoint "$task" "$txid" || {
        rc=$?
        _route_v2_log_transaction_stall "$task" "$txid"
        return "$rc"
      }
      ;;
    cleaning|completed)
      ;;
    *)
      _route_v2_log_transaction_stall "$task" "$txid"
      return 75
      ;;
  esac
  instrumentation_tx_cleanup "$task" "$txid" || {
    rc=$?
    _route_v2_log_transaction_stall "$task" "$txid"
    return "$rc"
  }
  if declare -F route_v2_instrumentation_restored >/dev/null; then
    route_v2_instrumentation_restored "$task" "$dir/scope.list" || return
  fi
  return 0
}

route_v2_cleanup_active_instrumentation() {
  local task=${1:-} attempt=${2:-} target_hash evidence rc=0
  local status=succeeded reason=normal released=0 retained=0
  if ! runtime_lifecycle_enabled_v2; then
    _route_v2_cleanup_active_instrumentation_impl "$task" "$attempt"
    return
  fi
  target_hash=$(runtime_analytics_hash_string_v2 \
    "instrumentation-transaction:t${task#t}:$attempt") || return 78
  runtime_lifecycle_cleanup_begin_v2 instrumentation_transaction "$target_hash" \
    >/dev/null || return
  _route_v2_cleanup_active_instrumentation_impl "$task" "$attempt" || rc=$?
  case "$rc" in
    0) released=1 ;;
    3) released=0 ;;
    *) status=failed; reason=cleanup_failed; retained=1 ;;
  esac
  evidence=$(runtime_analytics_hash_string_v2 \
    "instrumentation-transaction:t${task#t}:$attempt:rc=$rc") || evidence=""
  runtime_lifecycle_cleanup_finish_v2 instrumentation_transaction \
    "$status" "$reason" "$released" "$retained" "$evidence" >/dev/null || {
      (( rc != 0 )) && return "$rc"
      return
    }
  return "$rc"
}

_route_v2_completed_instrumentation_for_attempt() {
  local task=$1 attempt=$2 root candidate name state found="" suffix best=-1
  root=$(instrumentation_tx_root "$task") || return
  [[ -e "$root" || -L "$root" ]] || return 3
  [[ -d "$root" && ! -L "$root" ]] || return 78
  shopt -s nullglob
  local -a candidates=("$root"/"v2-${attempt#*_}-s"*)
  shopt -u nullglob
  for candidate in "${candidates[@]}"; do
    name=${candidate##*/}
    [[ "$name" =~ ^v2-${attempt#*_}-s([0-9]+)$ ]] || return 78
    suffix=${BASH_REMATCH[1]}
    [[ -d "$candidate" && ! -L "$candidate" &&
       -f "$candidate/state.env" && ! -L "$candidate/state.env" ]] || return 78
    state=$(_instrumentation_tx_get "$candidate/state.env" STATE)
    [[ "$state" == completed ]] || continue
    if (( 10#$suffix > best )); then
      found=$name
      best=$((10#$suffix))
    fi
  done
  [[ -n "$found" ]] || return 3
  printf '%s\n' "$found"
}

# После SIGKILL может последовать resume, поэтому нельзя считать, что сработали EXIT-trap
# или обычный путь возврата runner-launch. Если запускатель уже опубликовал точную
# идентичность процесса, перед проверкой или восстановлением инструментации нужно завершить
# всю эту группу раннера. Окно до публикации закрывает обязательный доверенный жизненный
# цикл control-group systemd; доступный провайдеру PID-файл никогда не используется.
_route_v2_quiesce_runner_before_recovery() {
  local task=$1 root identity_file rc grace_s=${FACTORY_RECOVERY_GRACE_SECONDS:-5}
  [[ "$grace_s" =~ ^[0-9]+$ ]] || return 78
  root=$(factory_control_root) || return
  identity_file="$root/runner-processes/t${task}.active"
  [[ -e "$identity_file" || -L "$identity_file" ]] || return 0
  declare -F runtime_interrupt_trusted_active >/dev/null || return 78
  runtime_interrupt_trusted_active "$task" "" "" "" "$grace_s"
  rc=$?
  (( rc == 0 || rc == 3 )) || return "$rc"
}

# Вызывается только из явных путей resume/gate. Функция не создаёт попытку и перед
# обращением к транзакции загружает точные активные пины. Если сбой произошёл в окне
# инструментации, сначала завершается очистка, затем переход `failed` закреплённого
# маршрута CAS-возвратом переводит курсор на `instrument`.
route_v2_recover_instrumentation() {
  local task attempt cleanup_rc cursor_tmp state node sequence completed rc reset
  _route_v2_require_isolation || return
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  _route_v2_load_attempt "$task" "$attempt" || return

  _route_v2_quiesce_runner_before_recovery "$task" || return
  route_v2_cleanup_active_instrumentation "$task" "$attempt"
  cleanup_rc=$?
  (( cleanup_rc == 0 || cleanup_rc == 3 )) || return "$cleanup_rc"

  cursor_tmp=$(mktemp "$(factory_control_root)/.route-v2-recovery-cursor.XXXXXX") ||
    return 1
  attempt_stage_state_read_v2 "$task" "$attempt" >"$cursor_tmp" || {
    rc=$?
    rm -f -- "$cursor_tmp"
    return "$rc"
  }
  IFS=$'\t' read -r state node sequence < <(_route_v2_json cursor "$cursor_tmp") || {
    rm -f -- "$cursor_tmp"
    return 78
  }
  rm -f -- "$cursor_tmp"

  # Сбой до фиксации instrument оставляет курсор на instrument: чистая базовая линия уже
  # является правильной точкой повтора, поэтому фиктивный переход журнала не нужен.
  [[ "$state" == ready ]] || return 0
  [[ "$node" != instrument ]] || return 0
  [[ "$(_route_v2_transaction_zone "$node")" == inside ]] || return 0
  if (( cleanup_rc == 3 )); then
    completed=$(_route_v2_completed_instrumentation_for_attempt "$task" "$attempt")
    rc=$?
    (( rc == 0 )) || return "$rc"
    [[ "$completed" =~ ^v2-${attempt#*_}-s[0-9]+$ ]] || return 78
  fi
  # Курсор возвращается на instrument НАПРЯМУЮ, а не через коммит `failed` на текущем узле.
  # Разница принципиальная: `failed` означает «работа узла не удалась», и каждый маршрут
  # ведёт этот исход по-своему — у консилиума `council_a` по failed идёт ВПЕРЁД (`next`),
  # то есть глубже в зону, чьей транзакции уже нет, а `chairman` встаёт на человеке. Совпал
  # с нужным поведением только маршрут `debug`, где все узлы зоны и так возвращаются на
  # instrument. Здесь же случилось не «узел не справился», а «транзакцию, внутри которой он
  # работал, сняли после обрыва», и законный адрес у этого один — instrument, единственный,
  # кто открывает транзакцию заново.
  #
  # Указание человека при этом переживает возврат само: оно живёт в журнале событием
  # human-rewind на своём узле и снимается ПЕРВЫМ КОММИТОМ этого узла, а мы его не
  # коммитим вовсе. Прежнему пути ради того же свойства нужен был отдельный флаг
  # восстановительного коммита.
  reset=$(_route_v2_reset_chain instrument) || return
  attempt_stage_state_human_rewind_v2 \
    "$task" "$attempt" instrument "$reset" \
    "инструментация снята после обрыва прогона на узле $node: зона instrument→proof переигрывается" \
    engine >/dev/null || return
  declare -F v2_log >/dev/null &&
    v2_log "восстановление: инструментация снята, курсор возвращён на instrument (был $node)"
  return 0
}
