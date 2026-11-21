#!/usr/bin/env bash
# Локальная проверка порта выполняется только в среде с настоящим ABI.
set -euo pipefail

if [[ $# -ne 2 || $2 != /* ]]; then
  printf '%s\n' 'Использование: check-factory-native.sh <OS/ABI> <абсолютный путь отчёта>' >&2
  exit 2
fi

target=$1
case "$target" in
  linux/amd64|linux/arm64|darwin/arm64|windows/x64|windows/arm64|android/arm64-v8a|android/x86_64) ;;
  *) printf 'Неизвестная среда фабрики: %s\n' "$target" >&2; exit 2 ;;
esac

actual="$(uname -s)/$(uname -m)"
case "$actual:$target" in
  Linux/x86_64:linux/amd64|Linux/aarch64:linux/arm64) ;;
  *)
    status='NATIVE PENDING'
    if [[ "$target" == android/* ]]; then
      status='DEVICE PENDING'
    fi
    printf '%s · %s · среда проверки %s · rc=77\n' "$target" "$status" "$actual"
    exit 77
    ;;
esac

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$root"
export GOTOOLCHAIN=local GOWORK=off FACTORY_NATIVE_REPORT="$2"
export FACTORY_NATIVE_BINARY="${FACTORY_NATIVE_BINARY:-$root/bin/factory}"
if [[ $FACTORY_NATIVE_BINARY != /* || ! -x "$FACTORY_NATIVE_BINARY" || -L "$FACTORY_NATIVE_BINARY" ]]; then
  printf '%s\n' 'Подготовьте bin/factory через grigdesk-ctl build factory.' >&2
  exit 78
fi

NODE_TEST_MAX_RSS_MB=4096 bash tests/run-node-tests-safe.sh --test --test-concurrency=2 \
  tests/server/factory-go-native.test.mts
