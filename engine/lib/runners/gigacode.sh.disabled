#!/usr/bin/env bash
# Общий ACP runtime владеет isolated home и process tree, runner — только адаптер движка.
# Probe/catalog тоже provider operations: offline guard запрещает даже обёртку на Node.
source "${FACTORY_HOME:?}/lib/executor.sh"

_runner_gigacode_node() {
  local node=${GRIGDESK_GIGACODE_NODE_BIN:-}
  [[ "$node" == /* && -x "$node" && ! -d "$node" ]] || return 4
  printf '%s\n' "$node"
}

runner_gigacode_probe() {
  local node
  node=$(_runner_gigacode_node) || return 4
  factory_exec provider "$node" "$FACTORY_HOME/../server/scripts/gigacodeInfo.mts" --probe
}

runner_gigacode_catalog() {
  local node
  node=$(_runner_gigacode_node) || return 4
  factory_exec provider "$node" "$FACTORY_HOME/../server/scripts/gigacodeInfo.mts" --catalog
}

runner_gigacode_credential_fingerprint() {
  local node
  node=$(_runner_gigacode_node) || return 4
  factory_exec provider "$node" "$FACTORY_HOME/../server/scripts/gigacodeInfo.mts" --fingerprint
}

runner_gigacode_default_policy() {
  local catalog family
  catalog=$(runner_gigacode_catalog) || return 4
  family=$(awk -F '\t' 'NR==1 {print $3}' <<<"$catalog")
  [[ -n "$family" ]] || return 4
  printf 'FAMILY=%s\nVERSION=latest\nVARIANT=auto\n' "$family"
}

runner_gigacode_default_effort() {
  # Успешное отсутствие значения — явный контракт, а не скрытый default high.
  # Непустой профильный effort дойдёт до wrapper и будет отклонён до prompt.
  printf '\n'
}

runner_gigacode_family_alias() { return 4; }

runner_gigacode_capabilities() {
  printf 'status status_request tools structured_output\n'
}

runner_gigacode_run() {
  local task=$1 prompt=$2 stage=$3 model=$4 effort=$5 timeout_s=$6 run_dir=$7
  local node prompt_dir prompt_file
  [[ "$timeout_s" =~ ^[1-9][0-9]*$ && "$run_dir" == /* ]] || return 4
  node=$(_runner_gigacode_node) || return 4
  prompt_dir="$run_dir/gigacode"
  prompt_file="$prompt_dir/prompt.md"
  mkdir -p "$prompt_dir" || return
  chmod 700 "$prompt_dir" || return
  (umask 077; printf '%s' "$prompt" >"$prompt_file") || return
  chmod 600 "$prompt_file" || return
  factory_exec provider timeout -k 30 "$timeout_s" "$node" \
    "$FACTORY_HOME/../server/scripts/gigacodeRunner.mts" \
    --cwd "$PWD" --run-dir "$run_dir" --prompt-file "$prompt_file" \
    --model "$model" --effort "$effort" --mode "${FACTORY_ROUTE_FILESYSTEM_POLICY:-}"
}

runner_gigacode_classify() {
  local run_dir=$1 rc=$2 node version
  [[ "$rc" == 0 ]] && { printf 'ok\n'; return; }
  [[ "$rc" == 124 ]] && { printf 'timeout\n'; return; }
  version=$(awk -F= '$1=="CLI_VERSION" {print $2; exit}' "$run_dir/meta.env" 2>/dev/null)
  # Новая версия допускается probe/catalog, но её отказы ещё не дают failover.
  # Только сигнатуры проверенной поставки подтверждают отсутствие model activity.
  [[ "$version" == 26.7.33 ]] || { printf 'unknown\n'; return; }
  node=$(_runner_gigacode_node) || { printf 'unknown\n'; return; }
  factory_exec local "$node" "$FACTORY_HOME/../server/scripts/gigacodeInfo.mts" \
    --classify "$run_dir/events.jsonl"
}

runner_gigacode_fanout_count() {
  local node
  node=$(_runner_gigacode_node) || return 4
  factory_exec local "$node" "$FACTORY_HOME/../server/scripts/gigacodeInfo.mts" \
    --fanout "$1/events.jsonl"
}

runner_gigacode_dialect() {
  printf 'GigaCode ACP 26.7.33: gigacode-acp-v1; billing usage unavailable.\n'
}

runner_gigacode_interrupt() {
  # Runtime закрывает собственную namespace/process group по сигналу wrapper-а.
  # --die-with-parent и pid namespace не позволяют tool-child пережить владельца.
  return 0
}
