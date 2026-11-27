#!/usr/bin/env bash
set -euo pipefail

version=1.0.0-preview.2

if [[ $# -lt 1 || $# -gt 2 || $1 != /* || $1 == / ]]; then
  printf 'Использование: bash %s <абсолютный каталог рантайма> [архив релиза]\n' "$0" >&2
  exit 2
fi

if [[ $(uname -s) != Linux ]]; then
  printf 'Рантайм Qwen Code %s для GrigDesk требует Linux.\n' "$version" >&2
  exit 1
fi

case $(uname -m) in
  x86_64)
    asset=qwen-linux-x64.tar.gz
    digest=1543dfc2562b520bc03ba483f09d4acc41843f026b4187ccb76c7ea9f4fe58e8
    ;;
  aarch64)
    asset=qwen-linux-arm64.tar.gz
    digest=30d9c3621f7f2b35aabc43db82eea29d39164c689cff5a13515d4593631c1c9f
    ;;
  *)
    printf 'Для этой архитектуры поставка Qwen Code в GrigDesk недоступна.\n' >&2
    exit 1
    ;;
esac

umask 077
mkdir -p -- "$1"
runtime=$(realpath -- "$1")
if [[ $runtime == / ]]; then
  printf 'Выберите отдельный каталог рантайма Qwen Code.\n' >&2
  exit 1
fi

stage=$(mktemp -d "$runtime/.prepare-$version.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
archive=$stage/$asset

if [[ $# == 2 ]]; then
  cp -- "$2" "$archive"
else
  source="https://github.com/QwenLM/qwen-code/releases/download/v$version/$asset"
  curl --fail --location --proto '=https' --proto-redir '=https' \
    --silent --show-error --max-time 180 --retry 1 --output "$archive" "$source"
fi

if [[ $(sha256sum < "$archive") != "$digest  -" ]]; then
  printf 'SHA-256 архива Qwen Code %s не совпадает с закреплённым релизом.\n' "$version" >&2
  exit 1
fi

# Проверенный архив содержит ровно один нужный ELF. Публикуем его одним link,
# чтобы повтор или конкурентная установка не заменили файл под живым процессом.
tar --extract --gzip --file "$archive" --directory "$stage" --no-same-owner -- ./qwen
chmod 0555 "$stage/qwen"

target=$runtime/qwen
if ! ln -T -- "$stage/qwen" "$target" 2>/dev/null; then
  if [[ -L $target || ! -f $target || ! -x $target ]] || ! cmp -s -- "$stage/qwen" "$target"; then
    printf 'Каталог содержит другую копию Qwen Code. Выберите отдельный каталог.\n' >&2
    exit 1
  fi

  target_mode=$(stat -c '%a' -- "$target")
  if (( (8#$target_mode & 0222) != 0 )); then
    printf 'Имеющийся Qwen Code доступен для записи. Установите бинарник в отдельный каталог.\n' >&2
    exit 1
  fi
fi

printf '%s\n' "$target"
