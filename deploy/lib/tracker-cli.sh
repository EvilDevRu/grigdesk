#!/usr/bin/env bash

# Общий установщик сохраняет собственные пакеты CLI и прежний вход tracker.
# Подключение файла определяет функции без сборки и изменения ссылок.
source "$(dirname "${BASH_SOURCE[0]}")/agent-cli.sh"

# Совместимый вызов установки зависимостей tracker для прежних внешних скриптов.
# Остальные CLI выбирают свой пакет через общий helper.
grigdesk_install_tracker_dependencies() {
  grigdesk_install_agent_dependencies "$1" tracker "$2"
}

# Совместимый вход tracker; внутренний третий параметр выбирает агентский CLI.
# Без третьего параметра прежние установщики и прямой запуск сохраняют tracker.
grigdesk_install_tracker_cli() {
  grigdesk_install_agent_cli "$1" "$2" "${3:-tracker}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  grigdesk_install_tracker_cli "$@"
  exit $?
fi
