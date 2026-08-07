#!/usr/bin/env bash

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/executor.sh"

runner_codex_probe() {
  command -v codex >/dev/null 2>&1 || return 4
  factory_exec provider codex --version
}

runner_codex_catalog() {
  local cache
  if [[ -n "${FACTORY_CODEX_MODEL_CACHE:-}" ]]; then
    cache=$FACTORY_CODEX_MODEL_CACHE
  elif [[ -n "${CODEX_HOME:-}" ]]; then
    cache="$CODEX_HOME/models_cache.json"
  else
    cache="${HOME:?}/.codex/models_cache.json"
  fi
  [[ -r "$cache" ]] || return 4
  python3 - "$cache" <<'PYTHON'
import json
import re
import sys

try:
    with open(sys.argv[1], encoding='utf-8') as source:
        payload = json.load(source)
except (OSError, ValueError):
    raise SystemExit(4)

count = 0
for model in payload.get('models', []):
    slug = model.get('slug')
    priority = model.get('priority')
    if model.get('visibility') != 'list' or not isinstance(slug, str):
        continue
    match = re.fullmatch(r'gpt-(\d+(?:\.\d+)+)-([a-z][a-z0-9-]*)', slug)
    if not match or not isinstance(priority, int) or priority < 0:
        continue
    fields = (
        slug, 'codex', match.group(2), match.group(1), 'default',
        str(1_000_000 - priority), '1', '0', '1', '0.0.0', '999.999.999',
    )
    print('\t'.join(fields))
    count += 1
raise SystemExit(0 if count else 4)
PYTHON
}

runner_codex_default_policy() {
  printf 'FAMILY=sol\nVERSION=latest\nVARIANT=auto\nEFFORT=xhigh\n'
}

runner_codex_family_alias() {
  return 4
}

runner_codex_capabilities() {
  printf 'status status_request sandbox tools structured_output\n'
}

runner_codex_run() {
  local task=$1 prompt=$2 stage=$3 model=$4 effort=$5 timeout_s=$6 run_dir=$7
  local sandbox=${RUNNER_CODEX_SANDBOX:-workspace-write}
  local -a args=(codex exec --json --skip-git-repo-check)
  if [[ "${RUNNER_CODEX_RESTRICT_SHARED_STAND:-0}" == 1 ]]; then
    # Shared checkout не должен наследовать доступ пользователя к Docker socket.
    # Permission profile — реальная process boundary; PreToolUse ниже лишь даёт
    # понятный ранний отказ для очевидных docker/worktree/ship-команд. Узкий
    # stand broker доступен через exact read-only control dir с FIFO/lock и сам
    # разрешает только фиксированные операции существующего стенда.
    local control_dir=${PROFILE_AGENT_CONTROL_DIR:-}
    local policy_hook="$FACTORY_HOME/lib/runners/codex-command-policy.py"
    [[ "$control_dir" == /* && "$control_dir" =~ ^[A-Za-z0-9_./-]+$ &&
       -d "$control_dir" && ! -L "$control_dir" && -O "$control_dir" &&
       "$(realpath -e -- "$control_dir" 2>/dev/null)" == "$control_dir" &&
       "$(stat -c '%a' "$control_dir" 2>/dev/null)" == 700 &&
       -f "$policy_hook" && ! -L "$policy_hook" &&
       "$(realpath -e -- "$policy_hook" 2>/dev/null)" == "$policy_hook" ]] || return 4
    local permission_profile='factory-shared-stand'
    local permission_policy hook_policy filesystem_policy read_dir codex_entry codex_runtime
    local codex_native codex_alias_dir
    local -a codex_native_candidates
    # Не наследуем :workspace: у него широкое host-read, а same-UID
    # bearer Cockpit превращает localhost в косвенный Docker/worktree lifecycle.
    # Custom profile видит только runtime minimum, workspace roots и
    # точные trusted tools; .git/.codex остаются read-only. Deny для
    # существующего каталога на Linux bwrap непереносим; read даёт ту же
    # механическую защиту от commit/worktree и подмены policy.
    filesystem_policy='{ ":minimal" = "read", ":tmpdir" = "write", ":slash_tmp" = "write", ":workspace_roots" = { "." = "write", ".git" = "read", ".codex" = "read" }'
    codex_entry=$(realpath -e -- "$(command -v codex 2>/dev/null)" 2>/dev/null) || return 4
    codex_runtime=$(realpath -e -- "$(dirname "$codex_entry")/.." 2>/dev/null) || return 4
    codex_native_candidates=(
      "$codex_runtime"/node_modules/@openai/codex-linux-*/vendor/*/bin/codex
    )
    (( ${#codex_native_candidates[@]} == 1 )) || return 4
    codex_native=$(realpath -e -- "${codex_native_candidates[0]}" 2>/dev/null) || return 4
    [[ "$codex_native" == "$codex_runtime/"* && -f "$codex_native" &&
       ! -L "$codex_native" && -x "$codex_native" ]] || return 4
    codex_alias_dir="$FACTORY_HOME/lib/runners/codex-path"
    [[ -x "$codex_alias_dir/codex-linux-sandbox" &&
       ! -L "$codex_alias_dir/codex-linux-sandbox" ]] || return 4
    for read_dir in "$FACTORY_HOME" "$codex_runtime" ${RUNNER_CODEX_READ_DIRS:-}; do
      [[ "$read_dir" == /* && "$read_dir" =~ ^[A-Za-z0-9_@+.,/=-]+$ &&
         -d "$read_dir" && ! -L "$read_dir" &&
         "$(realpath -e -- "$read_dir" 2>/dev/null)" == "$read_dir" ]] || return 4
      filesystem_policy+=', "'"$read_dir"'" = "read"'
    done
    filesystem_policy+=', "'"$control_dir"'" = "read"'
    filesystem_policy+=' }'
    # Командному sandbox не нужен network transport: ни localhost/TCP, ни AF_UNIX.
    # FIFO I/O и flock работают через read-only bind exact control directory.
    permission_policy='{ filesystem = '"$filesystem_policy"', network = { enabled = false } }'
    hook_policy='[{ matcher = "^Bash$", hooks = [{ type = "command", command = "/usr/bin/python3 '"$policy_hook"' shared-stand", timeout = 5 }] }]'
    args+=(
      --ignore-user-config
      --strict-config
      --dangerously-bypass-hook-trust
      -c 'approval_policy="never"'
      -c "default_permissions=\"$permission_profile\""
      -c "permissions.$permission_profile=$permission_policy"
      -c "hooks.PreToolUse=$hook_policy"
    )
  else
    args+=(--sandbox "$sandbox")
    if [[ "$sandbox" == workspace-write ]]; then
      args+=(-c 'sandbox_workspace_write.network_access=true')
    fi
  fi
  [[ -z "$model" ]] || args+=(-m "$model")
  [[ -z "$effort" ]] || args+=(-c "model_reasoning_effort=\"$effort\"")
  local add_dir
  for add_dir in ${RUNNER_CODEX_ADD_DIRS:-}; do
    if [[ -d "$add_dir" ]]; then
      if [[ "${RUNNER_CODEX_RESTRICT_SHARED_STAND:-0}" == 1 ]]; then
        add_dir=$(realpath -e -- "$add_dir" 2>/dev/null) || return 4
        case "$add_dir" in
          "$control_dir"|"$control_dir"/*) return 4 ;;
        esac
        case "$control_dir" in
          "$add_dir"/*) return 4 ;;
        esac
      fi
      args+=(--add-dir "$add_dir")
    fi
  done
  args+=(-o "$run_dir/last.md" -)
  # -k: см. комментарий в runners/claude.sh — TERM без последующего KILL оставляет
  # застрявшего провайдера жить с занятым слотом.
  if [[ "${RUNNER_CODEX_RESTRICT_SHARED_STAND:-0}" == 1 ]]; then
    PATH="$codex_alias_dir:$PATH" CODEX_NATIVE_BIN="$codex_native" \
      factory_exec provider timeout -k 30 "$timeout_s" "${args[@]}" <<<"$prompt"
  else
    factory_exec provider timeout -k 30 "$timeout_s" "${args[@]}" <<<"$prompt"
  fi
}

_runner_codex_meta() {
  local run_dir=$1 key=$2
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' \
    "$run_dir/meta.env" 2>/dev/null
}

_runner_codex_no_model_activity() {
  command -v python3 >/dev/null 2>&1 || return 1
  python3 - "$1/events.jsonl" <<'PYTHON'
import json
import sys

try:
    source = open(sys.argv[1], encoding="utf-8", errors="replace")
except OSError:
    raise SystemExit(1)

for line in source:
    if not line.strip():
        continue
    try:
        event = json.loads(line)
    except (TypeError, ValueError):
        raise SystemExit(1)
    kind = event.get("type", "")
    item = event.get("item") or {}
    if kind in {"item.started", "item.completed"} and item.get("type") in {
        "agent_message", "command_execution", "file_change", "mcp_tool_call",
    }:
        raise SystemExit(1)
    usage = event.get("usage") or {}
    if kind == "turn.completed" and any(
        isinstance(value, (int, float)) and value > 0 for value in usage.values()
    ):
        raise SystemExit(1)
raise SystemExit(0)
PYTHON
}

runner_codex_classify() {
  local run_dir=$1 rc=$2 version verified source_kind
  [[ "$rc" == 0 ]] && { printf 'ok\n'; return; }
  [[ "$rc" == 124 ]] && { printf 'timeout\n'; return; }
  version=$(_runner_codex_meta "$run_dir" CLI_VERSION)
  verified=$(_runner_codex_meta "$run_dir" FIXTURE_VERIFIED)
  source_kind=$(_runner_codex_meta "$run_dir" SOURCE)
  [[ "$version" =~ ^0\.145\. ]] || { printf 'unknown\n'; return; }
  if grep -qiE 'sandbox[_ ]denied|permission denied' \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    printf 'denied\n'
    return
  fi
  if [[ "$verified" != 1 && "$source_kind" != runtime ]]; then
    printf 'unknown\n'
    return
  fi
  if grep -qiE -e '(^|[^0-9])413([^0-9]|$)' -e 'request too large' \
      -e 'context[_ -]length[_ -]exceeded' -e 'context window.*exceed' \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    printf 'context_overflow\n'
    return
  fi
  if grep -q '"type":"usage_limit_reached"' "$run_dir/events.jsonl" 2>/dev/null || \
     grep -qiE '429.*(weekly|subscription|usage).*(limit|reached)|\
(weekly|subscription|usage).*limit.*(reached|reset)' \
       "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    printf 'limited\n'
    return
  fi
  if grep -qiE '(^|[^0-9])429([^0-9]|$)|"type":"rate_limit_error"|too many requests' \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    printf 'transient\n'
    return
  fi
  if grep -qiE -e '(^|[^0-9])(401|403)([^0-9]|$)' -e 'unauthorized' \
      -e 'authentication.*(expired|required)' -e 'request not allowed' \
      -e 'run codex login' \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    if _runner_codex_no_model_activity "$run_dir"; then
      printf 'provider_unavailable\n'
      return
    fi
  fi
  printf 'unknown\n'
}

runner_codex_fanout_count() {
  local run_dir=$1 out
  local events="$run_dir/events.jsonl"
  # Делегирование codex публикует ПРЯМО В ПОТОК (в отличие от kimi, где работа
  # субагентов не видна в stdout вовсе — KIMI.md): item типа `collab_tool_call`
  # несёт sender_thread_id и receiver_thread_ids. Замер всей телеметрии машины
  # (222 прогона, 19143 события, 0 битых строк, 2026-08-07): таких вызовов 296,
  # получатели у ВСЕХ пустые, тредов ровно один на ход — то есть делегирований
  # не было ни разу и прежняя константа `0` сегодня не врала. Но врать она
  # начала бы молча, как только codex делегирует впервые, поэтому считаем:
  # сколько РАЗНЫХ тредов-получателей встретилось за ход. Разбором JSON, а не
  # грепом: имена инструментов встречаются и в аргументах, и в снимках.
  if [[ -f "$events" ]] && command -v python3 >/dev/null 2>&1; then
    out=$(python3 -c '
import json
import sys

seen = set()
with open(sys.argv[1], encoding="utf-8", errors="replace") as handle:
    for line in handle:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        item = event.get("item")
        if not isinstance(item, dict) or item.get("type") != "collab_tool_call":
            continue
        for thread_id in item.get("receiver_thread_ids") or []:
            if isinstance(thread_id, str) and thread_id:
                seen.add(thread_id)
print(len(seen))
' "$events" 2>/dev/null) && [[ "$out" =~ ^[0-9]+$ ]] && {
      printf '%s\n' "$out"
      return 0
    }
  fi
  printf '0\n'
}

runner_codex_dialect() {
  printf 'Codex JSONL; no native Claude Task requirement; terminal status through stage-result.\n'
}

runner_codex_interrupt() {
  return 0
}
