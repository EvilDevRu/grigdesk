#!/usr/bin/env bash
# Собирает семь команд в отдельном каталоге и проверяет кандидатов перед заменой файлов.
set -euo pipefail

if [[ $# != 1 || $1 != /* ]]; then
  printf '%s\n' 'Использование: tools/build-go-utilities.sh <абсолютный каталог вывода>' >&2
  exit 2
fi

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$root"
export GOTOOLCHAIN=local GOWORK=off CGO_ENABLED=0 GOFLAGS=

pin=go1.27.4
if ! toolchain="$(go env GOVERSION)" || [[ "$toolchain" != "$pin" ]]; then
  printf 'Нужен Go %s.\n' "${pin#go}" >&2
  exit 1
fi

host_os="$(go env GOHOSTOS)"
host_arch="$(go env GOHOSTARCH)"
export GOOS="$host_os" GOARCH="$host_arch"

version="$(cat VERSION)"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][a-zA-Z0-9.+-]+)?$ ]]; then
  printf '%s\n' 'Файл VERSION содержит неподдерживаемую версию.' >&2
  exit 1
fi

mkdir -p -- "$1"
output="$(cd -- "$1" && pwd -P)"
if [[ "$output" == "$root/bin" ]]; then
  output="$root/bin/utilities"
  mkdir -p -- "$output"
  output="$(cd -- "$output" && pwd -P)"
fi
commands=(tracker routes pipeline voice relay ctl maintenance)
kinds=(tracker routes pipeline voice grigdesk-relay grigdesk-ctl grigdesk-maintenance)

# Каталог вывода может быть внутри рабочего дерева.
# Файлы под контролем Git сохраняются даже при явно указанном пути.
if git -C "$output" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  tracked="$(git -C "$output" ls-files -- "${commands[@]}")"
  if [[ -n "$tracked" ]]; then
    printf 'Выходной файл отслеживается git: %s\n' "$tracked" >&2
    exit 1
  fi
fi

for command in "${commands[@]}"; do
  if [[ -d "$output/$command" ]]; then
    printf 'Путь команды занят каталогом: %s\n' "$output/$command" >&2
    exit 1
  fi
done

stage="$(mktemp -d "$output/.go-utilities.XXXXXXXX")"
trap 'rm -rf -- "$stage"' EXIT

overlay=()
if [[ "$host_os" == darwin && "$host_arch" == arm64 ]]; then
  /usr/bin/clang -arch arm64 -mmacosx-version-min=15.0 -O2 \
    -o "$stage/darwin-process-identity" "$root/tools/macos/process-identity.c"
  python3 - "$root" "$stage" <<'PYTHON'
import json
from pathlib import Path
import sys

root, stage = map(Path, sys.argv[1:])
asset = root / "utilities/internal/processidentity/darwin-process-identity.asset"
overlay = {"Replace": {str(asset): str(stage / "darwin-process-identity")}}
(stage / "overlay.json").write_text(json.dumps(overlay), encoding="utf-8")
PYTHON
  overlay=(-overlay "$stage/overlay.json")
fi

for index in "${!commands[@]}"; do
  command="${commands[$index]}"
  go build "${overlay[@]}" -trimpath -buildvcs=false -ldflags "-s -X main.version=$version" \
    -o "$stage/$command" "./utilities/$command/cmd/$command"
  chmod 0755 -- "$stage/$command"

  actual="$(env -i "$stage/$command" --runtime-info --json 2>"$stage/runtime-info.stderr")"
  format='{"schema":1,"kind":"%s","version":"%s","runtime":"go","go":"%s","os":"%s","arch":"%s"}'
  expected="$(printf "$format" "${kinds[$index]}" "$version" "$pin" "$host_os" "$host_arch")"
  if [[ "$actual" != "$expected" || -s "$stage/runtime-info.stderr" ]]; then
    printf 'Метаданные кандидата %s не совпадают с запросом сборки.\n' "$command" >&2
    exit 1
  fi
done

for command in "${commands[@]}"; do
  mv -f -- "$stage/$command" "$output/$command"
  printf '%s\n' "$output/$command"
done
