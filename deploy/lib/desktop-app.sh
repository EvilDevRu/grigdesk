#!/usr/bin/env bash

# Один путь установленного окна используется CLI и лаунчером ярлыка: окно — собранный
# файл в bin/ копии, рядом с остальными программами, как в готовом архиве выпуска.
# Функция не читает порт или .env и не запускает приложение.
grigdesk_desktop_app_path() {
  local root=${1:?корень копии GrigDesk обязателен}

  printf '%s\n' "$root/bin/grigdesk-app"
}

# Место окна до переноса в bin/. Установка и remove убирают этот файл, чтобы ни ярлык, ни
# ручной запуск не открыли устаревшую сборку; формула пути — прежняя, без проверки XDG.
grigdesk_desktop_legacy_app_path() {
  printf '%s\n' "${XDG_DATA_HOME:-$HOME/.local/share}/grigdesk/desktop/grigdesk-desktop.AppImage"
}

# Описание установки сервера для окна (runtime.json): путь совпадает с desktopRuntimePath
# из shared/desktop/desktopRuntime.ts. Пустой или относительный XDG_DATA_HOME даёт ~/.local/share.
grigdesk_desktop_runtime_path() {
  local data_home="${XDG_DATA_HOME:-}"

  if [[ "$data_home" != /* ]]; then
    data_home="$HOME/.local/share"
  fi

  printf '%s\n' "$data_home/grigdesk/desktop/runtime.json"
}

# Метка сборки окна, знающей папку данных, лежит рядом с runtime.json, а не рядом с окном:
# bin/ содержит только программы.
grigdesk_desktop_marker_path() {
  local runtime

  runtime="$(grigdesk_desktop_runtime_path)"
  printf '%s\n' "${runtime%/*}/data-home"
}
