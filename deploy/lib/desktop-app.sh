#!/usr/bin/env bash

# Один путь установленного окна используется CLI и лаунчером ярлыка.
# Функция не читает порт или .env и не запускает приложение.
cockpit_desktop_app_path() {
  printf '%s\n' "${XDG_DATA_HOME:-$HOME/.local/share}/cockpit/desktop/cockpit-desktop.AppImage"
}

# Описание установки сервера для окна (runtime.json): путь совпадает с desktopRuntimePath
# из shared/desktop/desktopRuntime.ts. Пустой или относительный XDG_DATA_HOME даёт ~/.local/share.
cockpit_desktop_runtime_path() {
  local data_home="${XDG_DATA_HOME:-}"

  if [[ "$data_home" != /* ]]; then
    data_home="$HOME/.local/share"
  fi

  printf '%s\n' "$data_home/cockpit/desktop/runtime.json"
}
