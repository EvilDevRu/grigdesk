#!/usr/bin/env bash

# Проверяет и атомарно ставит готовый candidate с требованиями установленного потребителя.
# Сборка, загрузка и перезапуск не входят в эту операцию; пути задаёт вызывающий updater.
grigdesk_install_deepseek_cli() {
  local root=${1:?корень пакета GrigDesk обязателен}
  local candidate=${2:?candidate ELF обязателен}
  local target=${3:?target обязателен}
  local host_contract=${4:?host-contract установленного потребителя обязателен}
  local releases=${5:-}
  local args=(--binary "$candidate" --target "$target" --host-contract "$host_contract")

  if [[ -n "$releases" ]]; then
    args+=(--releases-dir "$releases")
  fi

  npm --prefix "$root/deepseek" run --silent install:binary -- "${args[@]}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  grigdesk_install_deepseek_cli "$@"
  exit $?
fi
