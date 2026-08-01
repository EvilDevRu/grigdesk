#!/usr/bin/env bash
# Trusted dispatcher for an immutable route-v2 attempt.
#
# This file is sourced after the project profile and core.sh.  It intentionally
# does not know how a project builds typed context: the host wrapper must provide
# `route_v2_context_for_node TASK ATTEMPT NODE RUN_KEY OUTPUT`.
#
# Public API:
#   route_v2_dispatch_bootstrap TASK ATTEMPT
#   route_v2_dispatch_next TASK ATTEMPT
#   route_v2_dispatch_until_pause TASK ATTEMPT [MAX_STEPS]
#   route_v2_gate_decide TASK ATTEMPT NODE approved|rejected
#
# Return codes:
#   0   one node was committed / loop reached its requested boundary
#   20  paused at a human gate
#   21  route already reached a terminal stop
#   75  trusted CAS/workspace/transaction conflict
#   78  invalid or unsupported runtime state
#
# Required host contract:
#   FACTORY_V2_STATE_DIR is an existing, dedicated absolute directory and equals
#   STATE_DIR.  It must not be the legacy ~/.factory/state.
#   route_v2_context_for_node ... writes a regular typed-context JSON file.
#   route_v2_workspace_roots prints the exact isolated git worktree roots.

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/attempt-stage-state.sh"
# shellcheck disable=SC1091
source "$FACTORY_HOME/lib/workspace-guard.sh"
# shellcheck disable=SC1091
source "$FACTORY_HOME/lib/instrumentation-transaction.sh"

_route_v2_fail() {
  printf 'route-v2 runtime: %s\n' "$*" >&2
  return 78
}

_route_v2_require_isolation() {
  local declared=${FACTORY_V2_STATE_DIR:-} state=${STATE_DIR:-} canonical legacy
  [[ -n "$declared" && "$declared" == /* && "$declared" == "$state" ]] ||
    _route_v2_fail "FACTORY_V2_STATE_DIR must be explicit and equal STATE_DIR" || return
  [[ -d "$state" && ! -L "$state" ]] ||
    _route_v2_fail "dedicated STATE_DIR is missing or is a symlink" || return
  canonical=$(realpath -e -- "$state" 2>/dev/null) ||
    _route_v2_fail "cannot canonicalize STATE_DIR" || return
  [[ "$canonical" == "$state" && "$canonical" != / ]] ||
    _route_v2_fail "STATE_DIR must be canonical and cannot be /" || return
  legacy="${FACTORY_LEGACY_STATE_DIR:-${HOME:-/nonexistent}/.factory/state}"
  legacy=$(realpath -m -- "$legacy" 2>/dev/null) ||
    _route_v2_fail "cannot canonicalize legacy state path" || return
  [[ "$state" != "$legacy" && "$state" != "$legacy/"* ]] ||
    _route_v2_fail "legacy canonical state is forbidden" || return
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
    browser = "forbid"
    timeout_class = ""
    retry_no_result = ""
    retry_product = ""
    provider_attempts = ""
    provider_strategy = ""
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
        provider = retry.get("providerFailure")
        if (
            fanout_mode not in {"single", "parallel"}
            or not isinstance(fanout_max, int) or isinstance(fanout_max, bool)
            or not 1 <= fanout_max <= 64
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
    print(executor, phase, run_key, policy, fanout_mode, fanout_max,
          retry_no_result, retry_product, provider_attempts, provider_strategy,
          browser, timeout_class, sep="\t")
else:
    fail()
PY
}

_route_v2_active_result() {
  local file=$1
  python3 - "$file" <<'PY'
import os
import re
import stat
import sys

path = sys.argv[1]
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
if set(fields) not in (required, required | {"COMMENT"}):
    raise SystemExit(78)
if (
    fields["SCHEMA"] != "1"
    or fields["STATE"] != "committed"
    or fields["RESULT"] not in {"done", "skipped", "failed"}
    or not re.fullmatch(r"[A-Za-z0-9._-]+", fields["RUN_ID"])
    or not re.fullmatch(r"[0-9]+", fields["EPOCH"])
    or not re.fullmatch(r"[a-f0-9]{64}", fields["TOKEN_HASH"])
):
    raise SystemExit(78)
print(fields["RESULT"], fields["RUN_ID"], sep="\t")
PY
}

_route_v2_require_delivery_context() {
  local context=$1 node=$2
  python3 - "$context" "$node" <<'PY'
import json
import os
import stat
import sys

path, node = sys.argv[1:]
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
        or not {"commit", "push", "pull-request"}.issubset(actions)
        or not targets
    ):
        raise SystemExit(78)
PY
}

_route_v2_bootstrap_record() {
  python3 - "$@" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys

op, path, task, attempt, profile, catalog, route, route_hash, *rest = sys.argv[1:]

def fail():
    raise SystemExit(78)

def read(path_value):
    try:
        fd = os.open(path_value, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            fail()
        with os.fdopen(fd, encoding="utf-8", closefd=True) as source:
            return json.load(source, parse_constant=lambda _: fail())
    except (OSError, UnicodeError, json.JSONDecodeError):
        fail()

expected = {
    "schema": 1,
    "protocolVersion": 2,
    "taskId": task,
    "attemptId": attempt,
    "profile": profile,
    "catalogHash": catalog,
    "routeId": route,
    "routeHash": route_hash,
    "node": "scout",
    "runKey": "SCOUT",
    "result": "done",
}

if op == "validate":
    value = read(path)
    if not isinstance(value, dict) or set(value) != set(expected) | {
        "runId", "transitionHash"
    }:
        fail()
    for key, field in expected.items():
        if value.get(key) != field:
            fail()
    if (
        not re.fullmatch(r"[A-Za-z0-9._-]+", value.get("runId", ""))
        or not re.fullmatch(r"[a-f0-9]{64}", value.get("transitionHash", ""))
    ):
        fail()
elif op == "make":
    if len(rest) != 2:
        fail()
    run_id, output = rest
    transition = read(path)
    action = transition.get("action")
    routes = action.get("escalate", {}).get("routes") if isinstance(action, dict) else None
    if (
        not isinstance(transition, dict)
        or transition.get("schema") != 2
        or transition.get("catalogHash") != catalog
        or transition.get("phase") != "bootstrap"
        or transition.get("node") != "scout"
        or transition.get("outcome") != "done"
        or not isinstance(routes, list)
        or route not in routes
        or len(routes) != len(set(routes))
    ):
        fail()
    policy = transition.get("escalationPolicy")
    if (
        not isinstance(policy, dict)
        or policy.get("from") != "scout"
        or policy.get("allowedRoutes") != routes
        or policy.get("requiresHumanWhenPinned") is not True
    ):
        fail()
    if not re.fullmatch(r"[A-Za-z0-9._-]+", run_id):
        fail()
    with open(path, "rb") as source:
        transition_hash = hashlib.sha256(source.read()).hexdigest()
    value = {
        **expected,
        "runId": run_id,
        "transitionHash": transition_hash,
    }
    with open(output, "w", encoding="utf-8", newline="\n") as target:
        json.dump(value, target, ensure_ascii=False, sort_keys=True, indent=2)
        target.write("\n")
else:
    fail()
PY
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

# Fail-closed: рантайм не имеет права молча исполнять меньше, чем обещает
# опубликованный бандл. Всё описанное, но не реализованное — parallel fanout,
# ретраи same-runner — останавливает попытку ДО запуска агента. Runner-failover
# при этом реализован: цепочку провайдеров с обязательным coverage перебирает
# multi-runner внутри каждого вызова run_agent.
_route_v2_node_caps_guard() {
  local executor=$1 fanout_mode=$2 fanout_max=$3 provider_strategy=$4
  [[ "$executor" != gate ]] || return 0
  if [[ "$fanout_mode" != single || "$fanout_max" != 1 ]]; then
    _route_v2_fail \
      "fanout ${fanout_mode}/${fanout_max} is not implemented by route-v2 runtime" || return
  fi
  if [[ "$provider_strategy" == same-runner ]]; then
    _route_v2_fail \
      "retry strategy same-runner is not implemented (failover is chain-based)" || return
  fi
  return 0
}

# Узел зажигается на доске в момент ВХОДА, а не когда стартовал раннер. До старта успевает
# пройти вечность: рендер промпта, открытие инструментальной транзакции и снимок обоих рабочих
# деревьев. Пока статус оставался pending, доска показывала конвейер замершим на ПРОШЛОМ узле —
# на приёмке t8165 после REVIEW было двадцать минут тишины, и это читалось как «всё встало»,
# хотя движок в это время считал хеши. v1 так и делал (run_stage выставляет running перед
# run_agent); v2 потерял пометку, когда диспетчером стал маршрутный рантайм.
#
# run_state_begin выставит running ещё раз, уже вместе с раннером и эпохой: статус узла и
# владение запуском — разные вещи, конкуренции тут нет. Провал пометки узел не валит: это
# витрина, а протокол напишет своё через полсекунды и сам решит, можно ли запускаться.
_route_v2_mark_node_running() {
  local task=$1 node=$2 run_key=$3
  if declare -F run_state_control_update >/dev/null; then
    run_state_control_update "$task" "$run_key" running || true
  fi
  declare -F v2_log >/dev/null && v2_log "узел $node: подготовка к запуску агента"
  return 0
}

_route_v2_guard_snapshot() {
  local task=$1 attempt=$2 node=$3 sequence=$4 side=$5
  local dir output sensitive
  _route_v2_workspace_roots_array || return
  dir="$(factory_control_root)/guards-v2/t${task}/${attempt}/${node}"
  mkdir -p -- "$dir" || return 1
  [[ -d "$dir" && ! -L "$dir" ]] || return 78
  output="$dir/sequence-${sequence}.${side}.tsv"
  sensitive="$dir/sequence-${sequence}.sensitive.list"
  : >"$sensitive" || return 1
  if declare -F route_v2_sensitive_files >/dev/null; then
    route_v2_sensitive_files | awk '/^\// && !seen[$0]++' >"$sensitive" || return 1
  fi
  WORKSPACE_GUARD_SENSITIVE_LIST_FILE="$sensitive" \
    workspace_guard_snapshot "$output" "${ROUTE_V2_ROOTS[@]}" || return
  printf '%s\n' "$output"
}

_route_v2_transaction_active_id() {
  local task=$1 active
  active="$(instrumentation_tx_root "$task")/active.env"
  [[ -f "$active" && ! -L "$active" ]] || return 3
  _instrumentation_tx_get "$active" TRANSACTION_ID
}

_route_v2_transaction_before() {
  local task=$1 attempt=$2 node=$3 sequence=$4 txid scope
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
    FACTORY_INSTRUMENTATION_ISOLATION=exclusive-worktree-v1 \
      instrumentation_tx_begin \
        "$task" "$txid" "$scope" "FACTORY-TRACE:t${task}" "${ROUTE_V2_ROOTS[@]}" || return
  elif [[ "$node" == proof && $active_rc -ne 0 ]]; then
    return 78
  elif (( active_rc != 0 && active_rc != 3 )); then
    return "$active_rc"
  fi
}

# Сторож валит прогон fail-closed, а в журнал уходил один код возврата. Приёмка t8165
# встала на 181 записи мусора стенда, и чтобы это увидеть, пришлось руками разбирать
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
  # Debug keeps one transaction open from INSTRUMENT through PROOF. Any other
  # transactional node (for example feature TRACE) owns a complete transaction.
  if [[ "$node" != instrument ]]; then
    instrumentation_tx_cleanup "$task" "$txid" || {
      rc=$?
      _route_v2_log_transaction_stall "$task" "$txid"
      return "$rc"
    }
  fi
}

_route_v2_run_agent_node() {
  local task=$1 attempt=$2 node=$3 run_key=$4 policy=$5 sequence=$6
  local _r2_context_file _r2_prompt_file active before_signature after_signature result run_id
  local guard_before="" guard_after=""
  # rc 75 неоднозначен (нет результата ИЛИ guard поймал нарушение) — ретраить
  # можно только первое, поэтому источник помечается флагом.
  ROUTE_V2_NO_RESULT=0
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
  "$FACTORY_HOME/bin/factory-route-v2" \
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
  FACTORY_ROUTE_FILESYSTEM_POLICY="$policy" \
  FACTORY_ROUTE_BROWSER_POLICY="${ROUTE_V2_NODE_BROWSER:-forbid}" \
  FACTORY_ROUTE_TIMEOUT_CLASS="${ROUTE_V2_NODE_TIMEOUT_CLASS:-}" \
  FACTORY_STAGE_RETRY="${ROUTE_V2_NODE_RETRY:-1}" \
  FACTORY_STAGE_RETRY_REASON="${ROUTE_V2_NODE_RETRY_REASON:-}" \
  FACTORY_STAGE_HUMAN_NOTE="${ROUTE_V2_NODE_HUMAN_NOTE:-}" \
    run_agent "$task" "$(cat "$_r2_prompt_file")" "$run_key" \
      >>"$STATE_DIR/logs/t${task}.route-v2.log" 2>&1
  local agent_rc=$?

  # 79 — отказ ХОСТА/КОНФИГА (нет свежего coverage, провайдер недоступен, denied),
  # а не «агент не отчитался»: ретраить бессмысленно, а исчерпание бюджета
  # закоммитило бы exhausted и убило попытку из-за временной проблемы окружения.
  # Так и вышло на прогоне t8165: правка runners.env на ходу обесценила coverage,
  # скептик сжёг три попытки и маршрут встал терминально. Останавливаемся
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
  if ! IFS=$'\t' read -r result run_id < <(_route_v2_active_result "$active"); then
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    # Незакрытый запуск (STATE=active) — раннер умер, не отчитавшись: у обоих
    # провайдеров кончился лимит (прогон t8165). Это «результата нет», а не
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
    if ! workspace_guard_compare "$guard_before" "$guard_after"; then
      workspace_guard_diff_summary "$guard_before" "$guard_after" \
        >"${guard_after%.tsv}.diff" 2>/dev/null || true
      rm -f -- "$_r2_context_file" "$_r2_prompt_file"
      return 75
    fi
  fi
  rm -f -- "$_r2_context_file" "$_r2_prompt_file"
  ROUTE_V2_NODE_RESULT=$result
}

route_v2_dispatch_bootstrap() {
  local task attempt artifact description_tmp transition_tmp record_tmp
  local _r2_context_file _r2_prompt_file active before_signature after_signature
  local executor phase run_key policy result run_id guard_before guard_after rc
  local fanout_mode fanout_max retry_no_result retry_product
  local provider_attempts provider_strategy browser_policy timeout_class
  local tries_left attempt_no agent_rc
  _route_v2_require_isolation || return
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  _route_v2_require_runner_invariant "$task" || return
  _route_v2_load_attempt "$task" "$attempt" || return
  artifact="$ROUTE_V2_ATTEMPT_DIR/artifacts/bootstrap.json"
  if [[ -e "$artifact" || -L "$artifact" ]]; then
    _route_v2_bootstrap_record validate \
      "$artifact" "$task" "$attempt" "$ROUTE_V2_PROFILE" "$ROUTE_V2_CATALOG" \
      "$ROUTE_V2_ROUTE" "$ROUTE_V2_ROUTE_HASH" || return
    cat -- "$artifact"
    return
  fi

  declare -F run_agent >/dev/null || _route_v2_fail "run_agent is unavailable" || return
  declare -F route_v2_context_for_node >/dev/null ||
    _route_v2_fail "route_v2_context_for_node hook is missing" || return
  description_tmp=$(mktemp "$(factory_control_root)/.route-v2-bootstrap.XXXXXX") || return 1
  "$FACTORY_HOME/bin/factory-route-v2" \
    --routes-dir "$ROUTE_V2_ROUTES_DIR" \
    --profile "$ROUTE_V2_PROFILE" \
    describe-bootstrap \
    --catalog-hash "$ROUTE_V2_CATALOG" >"$description_tmp" || {
      rc=$?
      rm -f -- "$description_tmp"
      return "$rc"
    }
  IFS=$'\t' read -r executor phase run_key policy fanout_mode fanout_max \
    retry_no_result retry_product provider_attempts provider_strategy browser_policy \
    timeout_class \
    < <(_route_v2_json node "$description_tmp" scout) || {
      rm -f -- "$description_tmp"
      return 78
    }
  rm -f -- "$description_tmp"
  [[ "$executor" == agent && "$phase" == bootstrap && "$run_key" == SCOUT &&
     "$policy" == state-only ]] || return 78
  _route_v2_node_caps_guard \
    "$executor" "$fanout_mode" "$fanout_max" "$provider_strategy" || return
  _route_v2_mark_node_running "$task" scout "$run_key"

  _r2_context_file=$(mktemp "$(factory_control_root)/.route-v2-context.XXXXXX") || return 1
  _r2_prompt_file=$(mktemp "$(factory_control_root)/.route-v2-prompt.XXXXXX") || {
    rm -f -- "$_r2_context_file"
    return 1
  }
  route_v2_context_for_node \
    "$task" "$attempt" scout SCOUT "$_r2_context_file" || {
      rc=$?
      rm -f -- "$_r2_context_file" "$_r2_prompt_file"
      return "$rc"
    }
  [[ -f "$_r2_context_file" && ! -L "$_r2_context_file" ]] || {
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    return 78
  }
  _route_v2_require_delivery_context "$_r2_context_file" scout || {
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    return 78
  }
  "$FACTORY_HOME/bin/factory-route-v2" \
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
  guard_before=$(
    _route_v2_guard_snapshot "$task" "$attempt" scout bootstrap before
  ) || {
    rm -f -- "$_r2_context_file" "$_r2_prompt_file"
    return 78
  }
  mkdir -p -- "$STATE_DIR/logs" || return 1
  # Ретраи bootstrap по контракту бандла: бюджеты noResult и providerFailure
  # суммируются (см. комментарий в route_v2_dispatch_next). Scout обязан
  # закончиться done, поэтому исчерпание бюджета остаётся отказом 75, а не
  # синтетическим exhausted.
  tries_left=$(( 1 + retry_no_result + provider_attempts ))
  attempt_no=1
  while :; do
    FACTORY_ROUTE_FILESYSTEM_POLICY=state-only \
    FACTORY_ROUTE_BROWSER_POLICY="$browser_policy" \
    FACTORY_ROUTE_TIMEOUT_CLASS="$timeout_class" \
    FACTORY_STAGE_RETRY="$attempt_no" \
    FACTORY_STAGE_RETRY_REASON=no-result \
      run_agent "$task" "$(cat "$_r2_prompt_file")" SCOUT \
        >>"$STATE_DIR/logs/t${task}.route-v2.log" 2>&1
    agent_rc=$?
    if (( agent_rc == 79 )); then
      _route_v2_fail "run_agent отказал по конфигурации хоста (код 79): исправь и повтори resume"
      return 75
    fi
    if [[ ! -e "$active" && ! -L "$active" ]]; then
      # Файла нет и не было: Scout ни разу не отчитался — «результата нет».
      [[ "$before_signature" == missing ]] || return 78
      after_signature=$before_signature
    else
      [[ -f "$active" && ! -L "$active" ]] || {
        return 78
      }
      after_signature=$(sha256sum -- "$active" | awk '{print $1}') || {
        return 1
      }
    fi
    [[ "$after_signature" == "$before_signature" ]] || break
    tries_left=$(( tries_left - 1 ))
    (( tries_left > 0 )) || return 75
    attempt_no=$(( attempt_no + 1 ))
  done
  IFS=$'\t' read -r result run_id < <(_route_v2_active_result "$active") || {
    return 78
  }
  [[ "$result" == done && -n "$run_id" ]] || {
    return 78
  }
  guard_after=$(
    _route_v2_guard_snapshot "$task" "$attempt" scout bootstrap after
  ) || return 78
  if ! workspace_guard_compare "$guard_before" "$guard_after"; then
    workspace_guard_diff_summary "$guard_before" "$guard_after" \
      >"${guard_after%.tsv}.diff" 2>/dev/null || true
    return 75
  fi

  transition_tmp=$(mktemp "$(factory_control_root)/.route-v2-transition.XXXXXX") || return 1
  "$FACTORY_HOME/bin/factory-route-v2" \
    --routes-dir "$ROUTE_V2_ROUTES_DIR" \
    --profile "$ROUTE_V2_PROFILE" \
    transition-bootstrap \
    --catalog-hash "$ROUTE_V2_CATALOG" \
    --node scout \
    --outcome done >"$transition_tmp" || {
      rc=$?
      rm -f -- "$transition_tmp"
      return "$rc"
    }
  record_tmp=$(mktemp "$ROUTE_V2_ATTEMPT_DIR/artifacts/.bootstrap.XXXXXX") || return 1
  _route_v2_bootstrap_record make \
    "$transition_tmp" "$task" "$attempt" "$ROUTE_V2_PROFILE" "$ROUTE_V2_CATALOG" \
    "$ROUTE_V2_ROUTE" "$ROUTE_V2_ROUTE_HASH" "$run_id" "$record_tmp" || {
      rc=$?
      rm -f -- "$transition_tmp" "$record_tmp"
      return "$rc"
    }
  chmod 400 "$record_tmp" || return 1
  if ! ln -- "$record_tmp" "$artifact" 2>/dev/null; then
    _route_v2_bootstrap_record validate \
      "$artifact" "$task" "$attempt" "$ROUTE_V2_PROFILE" "$ROUTE_V2_CATALOG" \
      "$ROUTE_V2_ROUTE" "$ROUTE_V2_ROUTE_HASH" || return
  fi
  rm -f -- "$transition_tmp" "$record_tmp" "$_r2_context_file" "$_r2_prompt_file"
  _route_v2_bootstrap_record validate \
    "$artifact" "$task" "$attempt" "$ROUTE_V2_PROFILE" "$ROUTE_V2_CATALOG" \
    "$ROUTE_V2_ROUTE" "$ROUTE_V2_ROUTE_HASH" || return
  # Узел закрыт: черновик хода относился к нему и живым больше не является.
  declare -F _stage_checkpoint_clear >/dev/null &&
    _stage_checkpoint_clear "$task" SCOUT
  cat -- "$artifact"
}

route_v2_dispatch_next() {
  local task attempt cursor_tmp description_tmp state node sequence
  local executor phase run_key policy rc
  local fanout_mode fanout_max retry_no_result retry_product
  local provider_attempts provider_strategy browser_policy timeout_class
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
  "$FACTORY_HOME/bin/factory-route-v2" \
    --routes-dir "$ROUTE_V2_ROUTES_DIR" \
    --profile "$ROUTE_V2_PROFILE" \
    describe-route \
    --catalog-hash "$ROUTE_V2_CATALOG" \
    --route "$ROUTE_V2_ROUTE" >"$description_tmp" || {
      rc=$?
      rm -f -- "$description_tmp"
      return "$rc"
    }
  IFS=$'\t' read -r executor phase run_key policy fanout_mode fanout_max \
    retry_no_result retry_product provider_attempts provider_strategy browser_policy \
    timeout_class \
    < <(_route_v2_json node "$description_tmp" "$node") || {
      rm -f -- "$description_tmp"
      return 78
    }
  rm -f -- "$description_tmp"

  if [[ "$executor" == gate ]]; then
    attempt_stage_state_pause_v2 \
      "$task" "$attempt" "$node" "human gate: $node" >/dev/null || return
    return 20
  fi
  [[ "$executor" == agent ]] ||
    _route_v2_fail "executor=$executor is not implemented by route-v2 runtime" || return
  _route_v2_node_caps_guard \
    "$executor" "$fanout_mode" "$fanout_max" "$provider_strategy" || return
  _route_v2_mark_node_running "$task" "$node" "$run_key"

  # Ретраи по контракту бандла. Попытки без результата (no-result и провайдерский
  # сбой на этой границе неразличимы: multi-runner уже исчерпал failover-цепочку
  # внутри run_agent, поэтому бюджеты noResult и providerFailure суммируются)
  # повторяются; исчерпание бюджета — синтетический исход exhausted, который
  # вырабатывает ДОВЕРЕННЫЙ рантайм, а не агент. Committed failed повторяется
  # только в пределах productFailure-бюджета.
  # Номер захода и причина повтора уезжают агенту: повтор, не знающий о следах
  # предыдущего захода, переделывает работу с нуля (t8165, 26 минут второго BUILD).
  local outcome="" cleanup_rc attempt_no=1 retry_reason=""
  local tries_left=$(( 1 + retry_no_result + provider_attempts ))
  local product_left=$retry_product
  # Указание человека при возврате курсора сюда. Читаем ОДИН раз на вход в узел, а не
  # на каждый заход: журнал за время узла не меняется, а каждое чтение — обход всех
  # событий попытки под локом. Держится до коммита узла, поэтому повторы его тоже видят.
  local human_note=""
  human_note=$(attempt_stage_state_human_note_v2 "$task" "$attempt" "$node") || return
  while :; do
    ROUTE_V2_NODE_BROWSER="$browser_policy" \
    ROUTE_V2_NODE_TIMEOUT_CLASS="$timeout_class" \
    ROUTE_V2_NODE_RETRY="$attempt_no" \
    ROUTE_V2_NODE_HUMAN_NOTE="$human_note" \
    ROUTE_V2_NODE_RETRY_REASON="$retry_reason" _route_v2_run_agent_node \
      "$task" "$attempt" "$node" "$run_key" "$policy" "$sequence"
    rc=$?
    if (( rc == 75 )) && [[ "${ROUTE_V2_NO_RESULT:-0}" == 1 ]]; then
      route_v2_cleanup_active_instrumentation "$task" "$attempt"
      cleanup_rc=$?
      (( cleanup_rc == 0 || cleanup_rc == 3 )) || return "$cleanup_rc"
      tries_left=$(( tries_left - 1 ))
      if (( tries_left > 0 )); then
        attempt_no=$(( attempt_no + 1 ))
        retry_reason=no-result
        continue
      fi
      outcome=exhausted
      break
    fi
    if (( rc != 0 )); then
      route_v2_cleanup_active_instrumentation "$task" "$attempt"
      cleanup_rc=$?
      (( cleanup_rc == 0 || cleanup_rc == 3 )) || return "$cleanup_rc"
      return "$rc"
    fi
    if [[ "$ROUTE_V2_NODE_RESULT" == failed ]] && (( product_left > 0 )); then
      route_v2_cleanup_active_instrumentation "$task" "$attempt"
      cleanup_rc=$?
      (( cleanup_rc == 0 || cleanup_rc == 3 )) || return "$cleanup_rc"
      product_left=$(( product_left - 1 ))
      attempt_no=$(( attempt_no + 1 ))
      retry_reason=failed
      continue
    fi
    outcome=$ROUTE_V2_NODE_RESULT
    break
  done
  if [[ "$outcome" == failed || "$outcome" == exhausted ]]; then
    route_v2_cleanup_active_instrumentation "$task" "$attempt"
    rc=$?
    (( rc == 0 || rc == 3 )) || return "$rc"
  fi
  attempt_stage_state_commit_v2 \
    "$task" "$attempt" "$node" "$outcome" || return
  # Черновик хода снимаем ТОЛЬКО после УСПЕШНОГО терминального коммита: между заходами он
  # нужен (обрыв на t8165), а после закрытого узла становится чужими заметками для того,
  # кто вернётся сюда по человеческому goto.
  # failed/exhausted — не «закрыто», а «остановлено и передано человеку»: узел ещё будут
  # переигрывать, и черновик — единственная запись о том, где именно застряли. Приёмочный
  # прогон t8165: TESTS отчитался «детали и остаток — t8165.tests.checkpoint.md», движок
  # стёр файл следующей же строкой, и человек у остановленного маршрута остался с одним
  # предложением комментария вместо разбора (что доказано, что нет, что осталось сделать).
  if [[ "$outcome" != failed && "$outcome" != exhausted ]]; then
    declare -F _stage_checkpoint_clear >/dev/null &&
      _stage_checkpoint_clear "$task" "$run_key"
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

route_v2_gate_decide() {
  local task attempt node outcome description_tmp executor phase run_key policy rc
  _route_v2_require_isolation || return
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  node=$(_attempt_stage_state_node_id "${3:-}") || return
  outcome=${4:-}
  [[ "$outcome" == approved || "$outcome" == rejected ]] || return 2
  _route_v2_require_runner_invariant "$task" || return
  _route_v2_load_attempt "$task" "$attempt" || return
  description_tmp=$(mktemp "$(factory_control_root)/.route-v2-machine.XXXXXX") || return 1
  "$FACTORY_HOME/bin/factory-route-v2" \
    --routes-dir "$ROUTE_V2_ROUTES_DIR" \
    --profile "$ROUTE_V2_PROFILE" \
    describe-route \
    --catalog-hash "$ROUTE_V2_CATALOG" \
    --route "$ROUTE_V2_ROUTE" >"$description_tmp" || {
      rc=$?
      rm -f -- "$description_tmp"
      return "$rc"
    }
  IFS=$'\t' read -r executor phase run_key policy \
    < <(_route_v2_json node "$description_tmp" "$node") || {
      rm -f -- "$description_tmp"
      return 78
    }
  rm -f -- "$description_tmp"
  [[ "$executor" == gate ]] || return 78
  attempt_stage_state_commit_v2 "$task" "$attempt" "$node" "$outcome"
}

# Abort the transaction owned by this exact attempt.  A fresh checkpoint first
# attributes only declared-scope writes to the interrupted provider; any
# out-of-scope write stalls fail-closed.  Durable `cleaning` is resumed directly
# after SIGKILL, while `completed` only repairs a stale active pointer.
route_v2_cleanup_active_instrumentation() {
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
  case "$state" in
    active)
      instrumentation_tx_checkpoint "$task" "$txid" || return
      ;;
    cleaning|completed)
      ;;
    *)
      return 75
      ;;
  esac
  instrumentation_tx_cleanup "$task" "$txid" || return
  return 0
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

# A resume may follow SIGKILL, so neither EXIT traps nor the ordinary
# runner-launch return path can be assumed to have run.  If the launcher had
# already published an exact process identity, retire that complete runner
# group before inspecting or restoring any instrumentation state.  The
# pre-publication window is covered by the required systemd control-group
# trusted runner lifecycle; a provider-writable PID file is never used.
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

# Called only by explicit resume/gate lifecycle paths.  It never creates an
# attempt and loads the exact active pins before touching a transaction.  If a
# crash happened in the instrumentation window, cleanup is completed first and
# the pinned route's own `failed` transition CAS-rewinds to `instrument`.
route_v2_recover_instrumentation() {
  local task attempt cleanup_rc cursor_tmp state node sequence completed rc
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

  # A crash before the instrument commit leaves the cursor at instrument: the
  # clean baseline is already the correct retry position and no fake ledger
  # transition is needed.
  [[ "$state" == ready ]] || return 0
  [[ "$node" != instrument ]] || return 0
  case "$node" in
    diagnose|hyposkeptic|proof)
      if (( cleanup_rc == 3 )); then
        completed=$(_route_v2_completed_instrumentation_for_attempt "$task" "$attempt")
        rc=$?
        (( rc == 0 )) || return "$rc"
        [[ "$completed" =~ ^v2-${attempt#*_}-s[0-9]+$ ]] || return 78
      fi
      attempt_stage_state_commit_v2 "$task" "$attempt" "$node" failed >/dev/null ||
        return
      ;;
  esac
}
