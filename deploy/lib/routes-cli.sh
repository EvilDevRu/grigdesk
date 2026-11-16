#!/usr/bin/env bash

# Использует общий установщик агентских ELF, сохраняя прежние коды.
# Доступ и папки данных пользователя здесь не читаются.
source "$(dirname "${BASH_SOURCE[0]}")/agent-cli.sh"

grigdesk_install_routes_cli() {
  grigdesk_install_agent_cli "$1" "$2" routes
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  grigdesk_install_routes_cli "$@"
  exit $?
fi
