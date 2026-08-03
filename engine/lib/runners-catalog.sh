#!/usr/bin/env bash

# Установленные адаптеры исполнителей: *.sh в каталоге runners без служебных
# модулей. Единая выборка для `factory runners` и для валидации --runner-primary
# в start — расхождение списков означало бы, что CLI принимает id, которых
# не видит оператор.
runners_catalog_list() {
  local module
  for module in "${FACTORY_RUNNERS_DIR:-"$FACTORY_HOME/lib/runners"}"/*.sh; do
    [[ -f "$module" ]] || continue
    case "$(basename "$module" .sh)" in index|policy|catalog) continue ;; esac
    basename "$module" .sh
  done | sort
}
