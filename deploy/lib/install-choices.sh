#!/usr/bin/env bash
# Выбор человека при установке (deploy/install.sh): автозапуск и ярлык на рабочем столе.
#
# Ответ берётся из флага, иначе спрашивается в терминале, иначе — по умолчанию:
# без терминала (агент, CI, скрипт) установщик обязан пройти сам. Флаги, не относящиеся
# к выбору, остаются в INSTALL_PASSTHRU для остальных шагов установщика.

# Разбирает аргументы install.sh: --autostart/--no-autostart, --shortcut/--no-shortcut.
# Пустое значение переменной означает «ещё не решено».
grigdesk_install_parse_args() {
  INSTALL_UNIT_ONLY=0
  INSTALL_AUTOSTART=""
  INSTALL_SHORTCUT=""
  INSTALL_PASSTHRU=()

  local arg
  for arg in "$@"; do
    case "$arg" in
      --unit-only) INSTALL_UNIT_ONLY=1 ;;
      --autostart) INSTALL_AUTOSTART=1 ;;
      --no-autostart) INSTALL_AUTOSTART=0 ;;
      --shortcut) INSTALL_SHORTCUT=1 ;;
      --no-shortcut) INSTALL_SHORTCUT=0 ;;
      *) INSTALL_PASSTHRU+=("$arg") ;;
    esac
  done
}

# Доопределяет выбор: переменная $1 остаётся, если задана флагом; при терминале задаётся
# вопрос $2 с подсказкой по умолчанию $3 (1 — да, 0 — нет); без терминала берётся $3.
grigdesk_install_choice() {
  local var=$1
  local question=$2
  local default=$3
  local current=${!var}
  local answer

  [ -z "$current" ] || return 0

  if [ -t 0 ]; then
    if [ "$default" = 1 ]; then
      read -r -p "$question [Y/n] " answer
    else
      read -r -p "$question [y/N] " answer
    fi
    case "$answer" in
      [YyДд]*) printf -v "$var" '%s' 1 ;;
      [NnНн]*) printf -v "$var" '%s' 0 ;;
      *) printf -v "$var" '%s' "$default" ;;
    esac
  else
    printf -v "$var" '%s' "$default"
  fi
}
