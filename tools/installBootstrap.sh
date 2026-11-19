#!/bin/sh
set -efu
umask 077
trap 'exit 130' INT
trap 'exit 143' TERM HUP

release_version=@@VERSION@@
release_channel=@@CHANNEL@@
release_origin=@@ORIGIN@@
release_platform=@@PLATFORM@@
release_delivery=@@DELIVERY@@
index_hash=@@INDEX_SHA256@@
index_size=@@INDEX_SIZE@@
helper_hash=@@HELPER_SHA256@@
helper_size=@@HELPER_SIZE@@
compressed_hash=@@COMPRESSED_SHA256@@
compressed_size=@@COMPRESSED_SIZE@@
local_bytes=@@LOCAL_BYTES@@
remote_bytes=@@REMOTE_BYTES@@
server_bytes=@@SERVER_BYTES@@

language=en
case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
  ru*) language=ru ;;
esac

# Ключи фиксированы кодом каталогов, значения — только строки вывода.
# Пользовательский путь никогда не попадает в имя ключа, eval или source.
message() {
  case "$language:$1" in
@@MESSAGES@@
    *) printf '%s' "$1" ;;
  esac
}

# Ошибка завершается до эффектов и печатается выбранным языком.
# Один код аргументов сохраняется для интерактивного и автоматического запуска.
die() {
  message "$1" >&2
  printf '\n' >&2
  exit 2
}

mode=
root=${HOME:?}/.local/lib/grigdesk
data_home=${GRIGDESK_HOME:-$HOME/.grigdesk}
user_data=${XDG_CONFIG_HOME:-$HOME/.config}/GrigDesk
bin_dir=$HOME/.local/bin
applications_dir=${XDG_DATA_HOME:-$HOME/.local/share}/applications
unit_dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
if [ "$release_platform" = darwin-arm64 ]; then
  root="$HOME/Library/Application Support/GrigDesk/program"
  user_data="$HOME/Library/Application Support/GrigDesk/profile"
  applications_dir=$HOME/Applications
  unit_dir=$HOME/Library/LaunchAgents
fi
source_dir=
yes=0
launch=0

if [ "${1:-}" = install ]; then
  [ "$#" -gt 1 ] || die invalid
  mode=${2:?}
  shift 2
fi

while [ "$#" -gt 0 ]; do
  option=$1
  shift

  case "$option" in
    --yes) yes=1 ;;
    --launch) launch=1 ;;
    --help|-h)
      message help
      printf '\n'
      exit 0
      ;;
    --mode|--root|--data-home|--user-data|--bin-dir|--applications-dir|--unit-dir|--source-dir|--lang)
      [ "$#" -gt 0 ] && [ -n "$1" ] || die invalid
      value=$1
      shift
      case "$option" in
        --mode)
          [ -z "$mode" ] || die invalid
          mode=$value
          ;;
        --root) root=$value ;;
        --data-home) data_home=$value ;;
        --user-data) user_data=$value ;;
        --bin-dir) bin_dir=$value ;;
        --applications-dir) applications_dir=$value ;;
        --unit-dir) unit_dir=$value ;;
        --source-dir) source_dir=$value ;;
        --lang)
          case "$value" in ru|en) language=$value ;; *) die invalid ;; esac
          ;;
      esac
      ;;
    *) die invalid ;;
  esac
done

case "${mode:-}" in
  local|remote) ;;
  server)
    [ "$launch" = 0 ] || die invalid
    ;;
  '') ;;
  *) die invalid ;;
esac

if [ "$release_platform" = darwin-arm64 ]; then
  platform_tools='sw_vers shasum'
else
  platform_tools='getconf curl sha256sum realpath tr'
fi
# set -f защищает разбиение фиксированного списка команд от pathname expansion.
for required in uname gzip mktemp wc head cp df awk dirname env chmod rm $platform_tools; do
  if ! command -v "$required" >/dev/null 2>&1; then
    message missingTools >&2
    printf ': %s\n' "$required" >&2
    exit 2
  fi
done
if [ "$release_platform" = darwin-arm64 ]; then
  [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die platformMac
  macos=$(/usr/bin/sw_vers -productVersion) || die platformMac
  printf '%s\n' "$macos" | LC_ALL=C awk '
    /^[0-9]+\.[0-9]+(\.[0-9]+)?$/ && ($1 + 0) >= 15 { good = 1 }
    END { exit !good }
  ' || die platformMac
else
  [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || die platform
  glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || die platform
  case "$glibc" in 'glibc '*) glibc=${glibc#glibc } ;; *) die platform ;; esac
  glibc_major=${glibc%%.*}
  glibc_minor=${glibc#*.}
  case "$glibc_major$glibc_minor" in ''|*[!0-9.]*) die platform ;; esac
  case "$glibc_minor" in *.*) die platform ;; esac
  if [ "$glibc_major" -lt 2 ] || { [ "$glibc_major" -eq 2 ] && [ "$glibc_minor" -lt 28 ]; }; then
    die platform
  fi
fi

if [ "$release_platform" = darwin-arm64 ] || [ "$release_delivery" != channel ]; then
  [ -n "$source_dir" ] || die sourceRequired
fi

# Ограничения путей одинаковы с helper: пробелы разрешены, служебные символы
# unit/desktop и управляющие символы отвергаются до загрузки и любой записи.
validate_path() {
  case "$1" in /*) ;; *) die invalid ;; esac
  case "$1" in *'"'*|*"'"*|*'\'*|*'`'*|*'$'*|*'%'*) die invalid ;; esac
  if printf '%s' "$1" | LC_ALL=C awk '/[[:cntrl:]]/ { bad=1 } END { exit !bad }'; then
    die invalid
  fi
}

# Разрешает точки и повторные разделители лексически. Физический путь со
# ссылками проверит helper, когда будет известен полученный из аргументов root.
lexical_path() {
  if [ "$release_platform" != darwin-arm64 ]; then
    realpath -ms -- "$1"
    return
  fi

  printf '%s\n' "$1" | LC_ALL=C awk -F / '
    {
      depth = 0
      for (i = 1; i <= NF; i++) {
        if ($i == "..") {
          if (depth > 0) { depth-- }
        } else if (length($i) && $i != ".") {
          parts[++depth] = $i
        }
      }
      if (!depth) { printf "/" }
      for (i = 1; i <= depth; i++) { printf "/%s", parts[i] }
      printf "\n"
    }
  '
}

for selected_path in "$root" "$data_home" "$user_data" "$bin_dir" "$applications_dir" "$unit_dir"; do
  validate_path "$selected_path"
done

root=$(lexical_path "$root")
data_home=$(lexical_path "$data_home")
user_data=$(lexical_path "$user_data")
if [ "$release_platform" = darwin-arm64 ]; then
  bin_dir=$(lexical_path "$bin_dir")
  applications_dir=$(lexical_path "$applications_dir")
  unit_dir=$(lexical_path "$unit_dir")
fi
[ "$root" != / ] || die invalid
case "$data_home/" in "$root/"*) die invalid ;; esac
case "$user_data/" in "$root/"*) die invalid ;; esac

if [ -n "$source_dir" ]; then
  case "$source_dir" in /*) ;; *) die invalid ;; esac
  [ -d "$source_dir" ] || die invalid
fi

if [ "$yes" = 0 ]; then
  if ! ( : </dev/tty ) 2>/dev/null; then
    die needTTY
  fi
  exec 3<>/dev/tty
  if [ -z "$mode" ]; then
    message modePrompt >&3
    printf ' ' >&3
    IFS= read -r answer <&3 || die invalid
    case "$answer" in
      ''|1) mode=local ;;
      2) mode=remote ;;
      3) mode=server ;;
      *) die invalid ;;
    esac
  fi
  message rootPrompt >&3
  printf ' [%s]: ' "$root" >&3
  IFS= read -r answer <&3 || die invalid
  [ -z "$answer" ] || root=$answer
  message dataPrompt >&3
  printf ' [%s]: ' "$data_home" >&3
  IFS= read -r answer <&3 || die invalid
  [ -z "$answer" ] || data_home=$answer
  validate_path "$root"
  validate_path "$data_home"
  root=$(lexical_path "$root")
  data_home=$(lexical_path "$data_home")
  case "$data_home/" in "$root/"*) die invalid ;; esac
fi

# Автоматический запуск без терминала обязан явно назвать режим.
[ -n "$mode" ] || die invalid
[ "$mode" != server ] || [ "$launch" = 0 ] || die invalid
[ "$root" != / ] || die invalid
case "$user_data/" in "$root/"*) die invalid ;; esac
case "$mode" in
  local) download_bytes=$local_bytes ;;
  remote) download_bytes=$remote_bytes ;;
  server) download_bytes=$server_bytes ;;
esac

# Проверка использует ближайшего существующего предка: чистый HOME ещё не имеет .local/cache.
# Каталоги установки создаёт helper только после подтверждения.
existing_parent() {
  probe=$1
  while [ ! -e "$probe" ]; do
    probe=$(dirname "$probe")
  done
  [ -d "$probe" ] && [ -w "$probe" ] || die invalid
  printf '%s' "$probe"
}

# Свободное место проверяется отдельно для файловых систем root, cache и tmp:
# установка не начинается, если хотя бы одна из них не примет объявленный объём.
needed_kib=$(( (download_bytes + helper_size + 1048576) / 1024 ))
for space_probe in "$(dirname "$root")" \
  "${XDG_CACHE_HOME:-$HOME/.cache}" "${TMPDIR:-/tmp}"; do
  space_probe=$(existing_parent "$space_probe")
  if [ "$release_platform" = darwin-arm64 ]; then
    space_available=$(df -Pk "$space_probe" 2>/dev/null | awk 'NR == 2 {print $4}') || die missingTools
  else
    space_available=$(df -Pk -- "$space_probe" 2>/dev/null | awk 'NR == 2 {print $4}') || die missingTools
  fi
  [ -n "$space_available" ] || die missingTools
  [ "$space_available" -ge "$needed_kib" ] || die space
done

if [ "$release_platform" = linux-x64 ]; then
  display_ready=0
  fuse_ready=0
  [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || display_ready=1
  if command -v ldconfig >/dev/null 2>&1; then
    if ldconfig -p 2>/dev/null | awk '/libfuse[.]so[.]2/ { found=1 } END { exit !found }'; then
      fuse_ready=1
    fi
  fi
fi
if [ "$release_platform" = linux-x64 ] && [ "$mode" != server ] \
  && { [ "$display_ready" = 0 ] || [ "$fuse_ready" = 0 ]; }; then
  if [ "$launch" = 1 ]; then
    die launchUnavailable
  fi
  message launchWarning >&2
  printf '\n' >&2
  distro=unknown
  if [ -r /etc/os-release ]; then
    while IFS='=' read -r distro_key distro_value; do
      case "$distro_key" in
        ID|ID_LIKE)
          distro_value=$(printf '%s' "$distro_value" | tr -d "\"'")
          for distro_id in $distro_value; do
            case "$distro_id" in
              ubuntu|debian|fedora|arch) [ "$distro" != unknown ] || distro=$distro_id ;;
              opensuse*) [ "$distro" != unknown ] || distro=opensuse ;;
            esac
          done
          ;;
      esac
    done < /etc/os-release
  fi
  message "depHint.$distro" >&2
  printf '\n' >&2
fi

printf 'GrigDesk %s · %s\n' "$release_version" "$mode"
message rootPrompt
printf ': %s\n' "$root"
message dataPrompt
printf ': %s\n' "$data_home"
message downloadBytes
printf ': %s\n' "$download_bytes"
if [ "$yes" = 0 ]; then
  message confirm >&3
  printf ' ' >&3
  IFS= read -r answer <&3 || die invalid
  case "$answer" in
    y|Y|yes|д|Д|да) ;;
    *) message cancelled; printf '\n'; exit 0 ;;
  esac
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/grigdesk-install.XXXXXXXX") || die temporaryFailed
trap 'rm -rf "$work"' EXIT

# Команда хеширования зависит от ОС. Вызывающие сравнивают только первые
# 64 hex-символа вывода, без интерпретации суффикса имени файла.
hash_file() {
  if [ "$release_platform" = darwin-arm64 ]; then
    /usr/bin/shasum -a 256 "$1"
  else
    sha256sum "$1"
  fi
}

# Получение никогда не интерпретирует URL как shell. Редиректы не разрешаются;
# повтор касается только приватного временного файла этого запуска.
obtain() {
  obtain_file=$1
  obtain_hash=$2
  obtain_size=$3
  obtain_destination=$4
  if [ -n "$source_dir" ]; then
    [ -f "$source_dir/$obtain_file" ] && [ ! -L "$source_dir/$obtain_file" ] || die integrity
    cp "$source_dir/$obtain_file" "$obtain_destination"
  else
    obtain_attempt=0
    while :; do
      obtain_attempt=$((obtain_attempt + 1))
      if curl --proto '=https' --tlsv1.2 --fail --show-error --progress-bar \
        --connect-timeout 15 --max-time 600 --output "$obtain_destination" \
        "$release_origin/releases/$release_version/$obtain_file"; then
        break
      fi
      [ "$obtain_attempt" -lt 3 ] || die network
    done
  fi
  obtain_actual_size=$(wc -c < "$obtain_destination" | awk '{print $1}')
  [ "$obtain_actual_size" = "$obtain_size" ] || die integrity
  obtain_actual_hash=$(hash_file "$obtain_destination")
  obtain_actual_hash=${obtain_actual_hash%% *}
  [ "$obtain_actual_hash" = "$obtain_hash" ] || die integrity
}

obtain "$release_channel.json" "$index_hash" "$index_size" "$work/release.json"
obtain grigdesk-maintenance.gz "$compressed_hash" "$compressed_size" "$work/helper.gz"
gzip -dc "$work/helper.gz" | head -c "$((helper_size + 1))" > "$work/helper"
helper_actual_size=$(wc -c < "$work/helper" | awk '{print $1}')
helper_actual_hash=$(hash_file "$work/helper")
helper_actual_hash=${helper_actual_hash%% *}
[ "$helper_actual_size" = "$helper_size" ] && [ "$helper_actual_hash" = "$helper_hash" ] \
  || die integrity
chmod 700 "$work/helper"

set -- install-online --release "$work/release.json" --mode "$mode" --root "$root" \
  --data-home "$data_home" --user-data "$user_data" --bin-dir "$bin_dir" \
  --applications-dir "$applications_dir" --unit-dir "$unit_dir"
[ -z "$source_dir" ] || set -- "$@" --source-dir "$source_dir"
result=0
env -u NODE_OPTIONS -u NODE_PATH -u APPIMAGE -u APPDIR -u ELECTRON_RUN_AS_NODE \
  "$work/helper" "$@" || result=$?
case "$result" in
  0) ;;
  10) message updatePrepared; printf '\n'; exit 0 ;;
  *) exit "$result" ;;
esac

if [ "$launch" = 1 ]; then
  "$bin_dir/grigdesk" &
fi
message complete
printf '\n'
