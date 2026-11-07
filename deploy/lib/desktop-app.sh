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

# Копирует только сохраняемые файлы, не читая cookie, замки и кэши старого окна.
# Обход не разыменовывает ссылки; временная копия доступна только владельцу.
grigdesk_copy_profile_files() {
  local source=$1
  local destination=$2
  local relative=$3
  local partition=$4
  local entry
  local name
  local child

  for entry in "$source"/* "$source"/.[!.]* "$source"/..?*; do
    [[ -e "$entry" || -L "$entry" ]] || continue
    name=${entry##*/}
    child=${relative:+$relative/}$name

    if [[ -z "$relative" || "$relative" == "Partitions/$partition" ]]; then
      case "$name" in
        Singleton*|Cache|'Code Cache'|GPUCache|DawnGraphiteCache|DawnWebGPUCache|GPUPersistentCache)
          continue
          ;;
      esac
    fi

    if [[ "$relative" == "Partitions/$partition" || "$relative" == "Partitions/$partition/Network" ]]; then
      case "$name" in
        Cookies*) continue ;;
      esac
    fi

    if [[ -d "$entry" && ! -L "$entry" ]]; then
      mkdir -m 700 -- "$destination/$name" || return $?
      grigdesk_copy_profile_files "$entry" "$destination/$name" "$child" "$partition" || return $?
    else
      cp -a -- "$entry" "$destination/$name" || return $?
    fi
  done
}

# Перенос выполняется только установкой окна; старый профиль остаётся для отката.
# Константы старых имён равны legacyBrand.ts и сверяются тестом.
grigdesk_migrate_desktop_profile() (
  local legacy_profile='Кокпит'
  local legacy_partition='cockpit-local'
  local config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
  local previous="$config_home/$legacy_profile"
  local destination="$config_home/GrigDesk"
  local temporary=''

  if [[ ${GRIGDESK_DESKTOP_DATA_DIR+x} || -e "$destination" || -L "$destination" ||
    ! -d "$previous" ]]; then
    return 0
  fi

  if [[ -L "$previous" ]]; then
    echo 'Старый профиль является ссылкой; перенос требует ручной проверки.' >&2
    return 1
  fi

  # Замок Chromium — ссылка hostname-pid. Нулевой сигнал только проверяет владельца.
  # Незнакомый формат не считается разрешением копировать открытые базы.
  node -e '
    const fs = require("node:fs");
    const os = require("node:os");
    const lock = process.argv[1];
    let target;

    try {
      target = fs.readlinkSync(lock);
    } catch (error) {
      if (error.code === "ENOENT") {
        process.exit(0);
      }

      process.exit(1);
    }

    const match = /^(.*)-(\d+)$/.exec(target);

    if (!match) {
      process.exit(1);
    }

    if (match[1] !== os.hostname()) {
      process.exit(0);
    }

    try {
      process.kill(Number(match[2]), 0);
      process.exit(1);
    } catch (error) {
      process.exit(error.code === "ESRCH" ? 0 : 1);
    }
  ' -- "$previous/SingletonLock" || {
    echo 'Старый профиль окна занят; закройте окно перед переносом.' >&2
    return 1
  }

  temporary=$(mktemp -d "$config_home/.grigdesk-profile.XXXXXX") || return $?
  trap '[[ -z "$temporary" ]] || rm -rf -- "$temporary"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  grigdesk_copy_profile_files "$previous" "$temporary" '' "$legacy_partition" || return $?

  if [[ -e "$temporary/Partitions/$legacy_partition" ]]; then
    if [[ -e "$temporary/Partitions/grigdesk-local" || -L "$temporary/Partitions/grigdesk-local" ]]; then
      echo 'В старом профиле уже есть новый раздел; нужна ручная проверка.' >&2
      return 1
    fi

    mv -T -- "$temporary/Partitions/$legacy_partition" "$temporary/Partitions/grigdesk-local" || return $?
  fi

  chmod 700 "$temporary" || return $?
  mv -nT -- "$temporary" "$destination" || return $?

  if [[ -d "$temporary" ]]; then
    echo 'Новый профиль появился во время переноса; прежние данные сохранены.' >&2
    return 1
  fi

  temporary=''
)
