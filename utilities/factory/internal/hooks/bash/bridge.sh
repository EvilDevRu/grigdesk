#!/usr/bin/env bash
set -uo pipefail

profile_path=$1
operation=$2
shift 2

require_hook() {
  if ! declare -F "$1" >/dev/null; then
    printf 'нет хука %s\n' "$1" >&2
    exit 78
  fi
}

# Подготовка продолжает загрузку даже после раннего return из profile.sh.
# Наличие функции проверяется отдельно перед вызовом.
if [[ "$operation" == agent-control ]]; then
  unset RUNNER_CODEX_RESTRICT_SHARED_STAND RUNNER_CODEX_READ_DIRS PROFILE_AGENT_DIRS
fi
source "$profile_path" </dev/null >&2
case "$operation" in
  agent-rules)
    [[ $# -eq 1 ]] || exit 78
    for _factory_rule in "${PROFILE_AGENT_ALLOW[@]}"; do
      printf 'allow\t%s\n' "$_factory_rule"
    done
    if declare -F profile_stage_agent_allow >/dev/null; then
      _factory_stage_rules=$(profile_stage_agent_allow "$1") || exit "$?"
      while IFS= read -r _factory_rule; do
        if [[ -n "$_factory_rule" ]]; then
          printf 'allow\t%s\n' "$_factory_rule"
        fi
      done <<<"$_factory_stage_rules"
    fi
    for _factory_rule in "${PROFILE_AGENT_DENY[@]}"; do
      printf 'deny\t%s\n' "$_factory_rule"
    done
    ;;
  agent-control)
    [[ $# -eq 2 ]] || exit 78
    if ! declare -F profile_agent_control_start >/dev/null &&
       ! declare -F profile_agent_control_stop >/dev/null; then
      printf 'absent\n'
      exit 0
    fi
    require_hook profile_agent_control_start
    require_hook profile_agent_control_stop
    unset PROFILE_AGENT_CONTROL_DIR
    profile_agent_control_start "$@" </dev/null >&2 || exit "$?"
    # Хук закрытия видит то же окружение и shell-local переменные.
    # EOF означает потерю оркестратора, даже если провайдер ещё работает.
    _factory_control_dir=${PROFILE_AGENT_CONTROL_DIR:-}
    _factory_read_dirs=${RUNNER_CODEX_READ_DIRS:-}
    _factory_write_dirs=${PROFILE_AGENT_DIRS:-}
    if [[ "$_factory_control_dir$_factory_read_dirs$_factory_write_dirs" == *[$'\r\n\t']* ]]; then
      profile_agent_control_stop "$@" 78 </dev/null >&2 || exit "$?"
      exit 78
    fi
    _factory_control_ready=$_factory_control_dir
    if [[ "${RUNNER_CODEX_RESTRICT_SHARED_STAND:-0}" == 1 ]]; then
      _factory_control_ready+=$'\tcodex\t'"$_factory_read_dirs"$'\t'"$_factory_write_dirs"
    fi
    _factory_control_rc=130
    if printf 'ready\t%s\n' "$_factory_control_ready" &&
       IFS= read -r _factory_control_outcome && [[ "$_factory_control_outcome" =~ ^[0-9]{1,3}$ ]]; then
      _factory_control_rc=$_factory_control_outcome
    fi
    profile_agent_control_stop "$@" "$_factory_control_rc" </dev/null >&2
    ;;
  command)
    [[ $# -eq 6 ]] || exit 78
    require_hook profile_route_command
    profile_route_command "$@"
    ;;
  health)
    [[ $# -eq 1 ]] || exit 78
    require_hook profile_stand_alive
    profile_stand_alive "$@"
    ;;
  instrumentation-restored)
    [[ $# -eq 2 ]] || exit 78
    require_hook profile_instrumentation_restored
    profile_instrumentation_restored "$@"
    ;;
  workspace)
    [[ $# -eq 1 ]] || exit 78
    task=$1
    for hook in profile_workspace_mode profile_repositories profile_source_branch \
      profile_container profile_project_context profile_stand_alive; do
      require_hook "$hook"
    done
    mode=$(profile_workspace_mode) || exit 78
    [[ "$mode" == shared || "$mode" == isolated ]] || exit 78
    printf 'workspace\t%s\nservice\t%s\n' "$mode" "${PROFILE_SERVICE_HOST:-127.0.0.1}"
    if [[ -n "${PROFILE_LOOP_MAX_ROUNDS+set}" ]]; then
      printf 'loop-rounds\t%s\n' "$PROFILE_LOOP_MAX_ROUNDS"
    fi
    if declare -F profile_stand_mode >/dev/null; then
      stand=$(profile_stand_mode "$task") || exit 78
      printf 'stand\t%s\n' "$stand"
    fi
    container=$(profile_container "$task") || exit 78
    printf 'container\t%s\n' "$container"
    repos=$(profile_repositories "$task") || exit 78
    while IFS= read -r row; do
      name=${row%%$'\t'*}
      branch=$(profile_source_branch "$task" "$name") || exit 78
      printf 'repo\t%s\t%s\n' "$row" "$branch"
    done <<<"$repos"
    if [[ "$mode" == shared ]]; then
      require_hook profile_service_ports
      require_hook profile_exclusive_resources
      ports=$(profile_service_ports "$task") || exit 78
      printf 'ports\t%s\n' "$ports"
      resources=$(profile_exclusive_resources "$task") || exit 78
      while IFS= read -r resource; do
        printf 'resource\t%s\n' "$resource"
      done <<<"$resources"
    fi
    if declare -F profile_delivery_strategy >/dev/null; then
      strategy=$(profile_delivery_strategy "$task") || exit 78
      printf 'delivery\t%s\n' "$strategy"
    fi
    printf 'context\n'
    profile_project_context
    ;;
  slots)
    [[ $# -eq 0 ]] || exit 78
    if declare -F profile_slots >/dev/null; then
      printf 'present\n'
      profile_slots
    else
      printf 'absent\n'
    fi
    ;;
  check-hooks)
    [[ $# -eq 0 ]] || exit 78
    printf '%s\n' "${PROFILE_SERVICE_HOST:-127.0.0.1}"
    missing=0
    for hook in profile_workspace_mode profile_repositories profile_project_context \
      profile_source_branch profile_container profile_stand_alive; do
      if ! declare -F "$hook" >/dev/null; then
        printf 'нет route-хука %s\n' "$hook" >&2
        missing=1
      fi
    done
    (( missing == 0 )) || exit 78
    mode=$(profile_workspace_mode) || exit 78
    case "$mode" in
      isolated) ;;
      shared)
        require_hook profile_service_ports
        require_hook profile_exclusive_resources
        require_hook profile_instrumentation_restored
        if [[ "$OSTYPE" == darwin* ]]; then
          require_hook profile_instrumentation_restore_mode
          restore_mode=$(profile_instrumentation_restore_mode) || exit 78
          case "$restore_mode" in
            live-checkout) ;;
            copy-snapshot) require_hook profile_instrumentation_restored_from_snapshot ;;
            *) exit 78 ;;
          esac
        fi
        ;;
      *)
        printf 'profile_workspace_mode должен вернуть isolated или shared\n' >&2
        exit 78
        ;;
    esac
    task=1
    if [[ "$mode" == shared ]]; then
      task=''
    fi
    repositories=$(profile_repositories "$task") || exit 78
    first=''
    while IFS=$'\t' read -r name source worktree; do
      [[ -n "$name" && -n "$worktree" ]] || continue
      want=$(profile_source_branch "$task" "$name") || exit 78
      if [[ "$mode" == shared ]]; then
        have=$(git -C "$worktree" symbolic-ref --quiet --short HEAD) || {
          printf 'checkout %s (%s): не Git checkout или detached HEAD\n' "$name" "$worktree" >&2
          exit 78
        }
        if [[ "$want" != "$have" ]]; then
          printf 'checkout %s стоит на ветке %s, а профиль закрепил %s\n' "$name" "$have" "$want" >&2
          exit 78
        fi
      elif [[ -z "$first" ]]; then
        first=$want
      elif [[ "$first" != "$want" ]]; then
        printf 'isolated: репозиторий %s закреплён на %s, а первый — на %s\n' "$name" "$want" "$first" >&2
        exit 78
      fi
    done <<<"$repositories"
    ;;
  *)
    printf 'операция профиля не поддерживается\n' >&2
    exit 78
    ;;
esac
