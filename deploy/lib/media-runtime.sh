#!/usr/bin/env bash

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime-env.sh"

# Воспроизводимый Python-runtime речи. Функции вынесены из deploy/install.sh, чтобы
# выбор состава и запись .env проверялись офлайн без npm/systemd.

cockpit_media_env_value() {
  local file=${1:?env-файл обязателен}
  local key=${2:?ключ обязателен}
  [[ -f "$file" ]] || return 0
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

cockpit_media_set_env_default() {
  local file=${1:?env-файл обязателен}
  local key=${2:?ключ обязателен}
  local value=${3:?значение обязательно}
  local current
  current=$(cockpit_media_env_value "$file" "$key")
  [[ -n "$current" ]] && return 0

  mkdir -p "$(dirname "$file")"
  local mode=600
  local source=/dev/null
  if [[ -f "$file" ]]; then
    mode=$(stat -c '%a' "$file")
    source=$file
  fi
  # .env может содержать API keys. mktemp создаёт файл 0600 до первой записи;
  # subshell/trap не оставляют секретную копию при awk/chmod/mv failure.
  (
    umask 077
    local tmp
    tmp=$(mktemp "${file}.speech.XXXXXX") || exit 1
    trap 'rm -f -- "$tmp"' EXIT
    chmod 600 "$tmp"
    awk -v key="$key" -v value="$value" '
      BEGIN { done = 0 }
      $0 ~ ("^" key "=") && !done { print key "=" value; done = 1; next }
      { print }
      END { if (!done) print key "=" value }
    ' "$source" > "$tmp"
    chmod "$mode" "$tmp"
    mv "$tmp" "$file"
    trap - EXIT
  )
}

cockpit_media_cuda_choice() {
  local media_python=${1:?python обязателен}
  shift
  local explicit=
  local arg
  for arg in "$@"; do
    case "$arg" in
      --with-cuda) explicit=1 ;;
      --no-cuda) explicit=0 ;;
      *) echo "неизвестный аргумент install.sh: $arg" >&2; return 2 ;;
    esac
  done

  if [[ -n "$explicit" ]]; then
    printf '%s\n' "$explicit"
    return 0
  fi
  case "${COCKPIT_MEDIA_CUDA:-}" in
    1|true|yes) printf '1\n'; return 0 ;;
    0|false|no) printf '0\n'; return 0 ;;
    '') ;;
    *) echo 'COCKPIT_MEDIA_CUDA: допустимо 1|0' >&2; return 2 ;;
  esac

  if "$media_python" -m pip show nvidia-cublas-cu12 >/dev/null 2>&1; then
    printf '1\n'
    return 0
  fi
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    printf '0\n'
    return 0
  fi
  if [[ -t 0 ]]; then
    local answer
    read -r -p 'Установить CUDA-библиотеки для локальной диктовки? [y/N] ' answer
    case "$answer" in y|Y|yes|YES|да|Да) printf '1\n' ;; *) printf '0\n' ;; esac
    return 0
  fi
  printf '0\n'
}

cockpit_install_media() {
  local root=${1:?корень cockpit обязателен}
  shift
  local env_file data_home
  env_file=$(cockpit_env_file) || return 1
  data_home=$(cockpit_data_home) || return 1
  local previous_python=${COCKPIT_MEDIA_PYTHON:-}
  [[ -n "$previous_python" ]] || previous_python=$(cockpit_media_env_value "$env_file" COCKPIT_MEDIA_PYTHON)

  local media_python=$previous_python
  if [[ -z "$media_python" ]]; then
    media_python="$data_home/state/media-venv/bin/python"
  elif [[ ! -x "$media_python" ]]; then
    echo "Настроенный COCKPIT_MEDIA_PYTHON не исполняемый: $media_python" >&2
    return 1
  fi
  if [[ ! -x "$media_python" ]]; then
    local bootstrap_python=${COCKPIT_MEDIA_BOOTSTRAP_PYTHON:-python3}
    command -v "$bootstrap_python" >/dev/null 2>&1 || {
      echo "Python не найден: $bootstrap_python" >&2
      return 1
    }
    echo '→ Media runtime: создаю venv…'
    "$bootstrap_python" -m venv "$(dirname "$(dirname "$media_python")")"
  fi

  echo '→ Media runtime: базовые зависимости…'
  "$media_python" -m pip install -r "$root/server/requirements-media.txt"

  local with_cuda
  with_cuda=$(cockpit_media_cuda_choice "$media_python" "$@") || return
  if [[ "$with_cuda" == 1 ]]; then
    echo '→ Media runtime: CUDA-библиотеки…'
    "$media_python" -m pip install -r "$root/server/requirements-media-cuda.txt"
  else
    # Явные --no-cuda/COCKPIT_MEDIA_CUDA=0 означают состав, а не только
    # «не доустанавливать»: иначе прежний cublas остаётся и device:auto всё равно
    # уходит на GPU вопреки выбору человека.
    if "$media_python" -m pip show nvidia-cublas-cu12 >/dev/null 2>&1; then
      "$media_python" -m pip uninstall -y nvidia-cublas-cu12
    fi
    echo '→ Media runtime: CPU-состав (CUDA позже: deploy/install.sh --with-cuda)'
  fi

  cockpit_media_set_env_default "$env_file" COCKPIT_MEDIA_PYTHON "$media_python"
  cockpit_media_set_env_default "$env_file" COCKPIT_MEDIA_HF_DIR "$data_home/state/hf"
}
