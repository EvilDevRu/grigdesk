#!/usr/bin/env bash
# Собирает отдельный движок и публикует его одним rename после локальной проверки.
set -euo pipefail

if [[ $# -ne 1 || $1 != /* ]]; then
  printf '%s\n' 'Использование: tools/build-factory.sh <абсолютный каталог вывода>' >&2
  exit 2
fi

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)

export GOTOOLCHAIN=local GOWORK=off CGO_ENABLED=0 GOFLAGS=
if [[ $(go env GOVERSION) != go1.27.4 ]]; then
  printf '%s\n' 'Для сборки фабрики нужен Go 1.27.4.' >&2
  exit 78
fi

GOOS=$(go env GOHOSTOS)
GOARCH=$(go env GOHOSTARCH)
export GOOS GOARCH

case "$GOOS/$GOARCH" in
  linux/amd64|linux/arm64|darwin/arm64) ;;
  *)
    printf 'Фабрика не собирается в ABI %s/%s.\n' "$GOOS" "$GOARCH" >&2
    exit 78
    ;;
esac

mkdir -p -- "$1"
output=$(cd -- "$1" && pwd -P)
destination="$output/factory"
if [[ -L "$destination" || -d "$destination" ]]; then
  printf 'Путь бинарника фабрики занят: %s\n' "$destination" >&2
  exit 78
fi

stage=$(mktemp -d "$output/.factory-build.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
go -C "$root" build -trimpath -buildvcs=false -o "$stage/factory" ./utilities/factory/cmd/factory
probe=$(env -i "$stage/factory" capabilities --format json)
if [[ "$probe" != *'"native-subcommands"'* ]]; then
  printf '%s\n' 'Собранный движок не подтвердил native-subcommands.' >&2
  exit 78
fi
chmod 0755 -- "$stage/factory"
mv -f -- "$stage/factory" "$destination"
printf '%s\n' "$destination"
