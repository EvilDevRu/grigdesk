#!/usr/bin/env bash

# Source только проверяет описание и читает фиксированные проекции.
# Подготовка копий и настройка исполнителей выполняются отдельными явными командами.
_SAMPLE_PROFILE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
_sample_metadata=$(python3 -B "$_SAMPLE_PROFILE_DIR/hookData.py" metadata) || return 64
mapfile -t _sample_values <<<"$_sample_metadata"
PROFILE_NAME=${_sample_values[0]}
PROFILE_CTX=${_sample_values[1]}
PROFILE_AGENT_CWD=${_sample_values[2]}
PROFILE_SERVICE_HOST=${_sample_values[3]}
PROFILE_TRIAGE_REPOS=${_sample_values[4]}
PROFILE_TRIAGE_RULES=${_sample_values[5]}
PROFILE_TRIAGE_ROUTES='feature:light=small feature:mid=small feature:full=feature debug:light=debug debug:mid=debug debug:full=debug'
mapfile -t PROFILE_AGENT_ALLOW < <(python3 -B "$_SAMPLE_PROFILE_DIR/hookData.py" allow)
mapfile -t PROFILE_AGENT_DENY < <(python3 -B "$_SAMPLE_PROFILE_DIR/hookData.py" deny)
unset _sample_metadata _sample_values

# Единая граница чтения декларации сохраняет аргументы позиционными.
# Ни одно значение проекта не интерпретируется оболочкой как программа.
_sample_data() {
  python3 -B "$_SAMPLE_PROFILE_DIR/hookData.py" "$@"
}

profile_workspace_mode() {
  _sample_data workspace_mode "$@"
}

profile_stand_mode() {
  _sample_data stand_mode "$@"
}

profile_repositories() {
  _sample_data repositories "$@"
}

profile_project_context() {
  _sample_data project_context "$@"
}

profile_source_branch() {
  _sample_data source_branch "$@"
}

profile_container() {
  _sample_data container "$@"
}

profile_service_ports() {
  _sample_data service_ports "$@"
}

profile_exclusive_resources() {
  _sample_data exclusive_resources "$@"
}

profile_delivery_strategy() {
  _sample_data delivery_strategy "$@"
}

profile_delivery_targets() {
  _sample_data delivery_targets "$@"
}

profile_stage_agent_allow() {
  _sample_data stage_agent_allow "$@"
}

profile_route_volatile_paths() {
  _sample_data volatile_paths "$@"
}

profile_stand_alive() {
  python3 -B "$_SAMPLE_PROFILE_DIR/workspace.py" health "$@"
}

profile_instrumentation_restored() {
  profile_stand_alive "$1"
}

profile_route_command() {
  python3 -B "$_SAMPLE_PROFILE_DIR/verify.py" "$@"
}

profile_route_node_evidence_check() {
  python3 -B "$_SAMPLE_PROFILE_DIR/evidence.py" "$@"
}
