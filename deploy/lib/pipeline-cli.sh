#!/usr/bin/env bash

# Использует общий установщик двух ELF, сохраняя tracker-совместимость.
# Доступ и папки данных пользователя здесь не читаются.
source "$(dirname "${BASH_SOURCE[0]}")/tracker-cli.sh"

grigdesk_install_pipeline_cli() {
  grigdesk_install_agent_cli "$1" "$2" pipeline
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  grigdesk_install_pipeline_cli "$@"
  exit $?
fi
