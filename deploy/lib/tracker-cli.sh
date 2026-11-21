#!/usr/bin/env bash

# Вход tracker использует сборку Go и общий механизм публикации ссылки.
source "$(dirname "${BASH_SOURCE[0]}")/agent-cli.sh"

grigdesk_install_tracker_cli() {
  grigdesk_install_agent_cli "$1" "$2" "${3:-tracker}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  grigdesk_install_tracker_cli "$@"
  exit $?
fi
