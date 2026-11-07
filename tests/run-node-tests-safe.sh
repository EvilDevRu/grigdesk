#!/usr/bin/env bash
# Ограничивает не только V8 heap coordinator-а, но и суммарный RSS всех test
# workers и их дочерних процессов. Это ловит native/external allocations, которые
# --max-old-space-size не видит (например, форматирование циклического DOM wrapper).
#
# Сторож считает группу целиком, поэтому при --test-concurrency>1 бюджет задаётся
# на ВСЕ одновременные файлы: NODE_TEST_MAX_RSS_MB не меньше гигабайта на worker
# (контракт tests/server|web/test-runner-memory.contract.test.js).
set -uo pipefail

# Объёмный замер старого API требует отдельного heap, но не повышает лимиты соседей.
# VERIFY передаёт явный список файлов: разделяем его здесь, сохраняя общий код выхода.
BENCHMARK_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/server/chat-list-benchmark.test.mjs"
BENCHMARK_REQUESTED=0
REGULAR_TEST_COUNT=0
TEST_MODE=0
REGULAR_ARGS=()
BENCHMARK_ARGS=()

for argument in "$@"; do
  if [[ "$argument" == --test ]]; then
    TEST_MODE=1
  fi

  if [[ "$argument" -ef "$BENCHMARK_FILE" ]]; then
    if (( ! BENCHMARK_REQUESTED )); then
      BENCHMARK_ARGS+=("$argument")
    fi

    BENCHMARK_REQUESTED=1
  elif [[ "$argument" =~ \.test\.(js|mjs|mts|ts)$ && -f "$argument" ]]; then
    REGULAR_TEST_COUNT=$((REGULAR_TEST_COUNT + 1))
    REGULAR_ARGS+=("$argument")
  else
    REGULAR_ARGS+=("$argument")
    BENCHMARK_ARGS+=("$argument")
  fi
done

if (( TEST_MODE && BENCHMARK_REQUESTED )); then
  if (( REGULAR_TEST_COUNT > 0 )); then
    bash "${BASH_SOURCE[0]}" "${REGULAR_ARGS[@]}"
    REGULAR_STATUS=$?

    NODE_TEST_HEAP_MB=2048 NODE_TEST_MAX_RSS_MB=4096 \
      bash "${BASH_SOURCE[0]}" "${BENCHMARK_ARGS[@]}"
    BENCHMARK_STATUS=$?

    if (( REGULAR_STATUS != 0 )); then
      exit "$REGULAR_STATUS"
    fi

    exit "$BENCHMARK_STATUS"
  fi

  export NODE_TEST_HEAP_MB=2048 NODE_TEST_MAX_RSS_MB=4096
  set -- "${BENCHMARK_ARGS[@]}"
  echo "node-test-watchdog: отдельный benchmark; heap=2048MB RSS=4096MB" >&2
fi

HEAP_MB="${NODE_TEST_HEAP_MB:-1024}"
MAX_RSS_MB="${NODE_TEST_MAX_RSS_MB:-2048}"
POLL_SECONDS="${NODE_TEST_POLL_SECONDS:-0.25}"

if ! [[ "$HEAP_MB" =~ ^[1-9][0-9]*$ && "$MAX_RSS_MB" =~ ^[1-9][0-9]*$ ]]; then
  echo "node-test-watchdog: HEAP_MB и MAX_RSS_MB должны быть положительными числами" >&2
  exit 2
fi

MAX_RSS_KB=$((MAX_RSS_MB * 1024))
PEAK_RSS_KB=0
STOPPING=0

# У каждого прогона своя папка: тесты не трогают настоящую папку пользователя.
# Внешнее GRIGDESK_HOME не наследуется, сбой mktemp запрещает запуск Node.
if ! TEST_DATA_HOME=$(mktemp -d "${TMPDIR:-/tmp}/grigdesk-test-home.XXXXXX") \
  || [[ ! -d "$TEST_DATA_HOME" ]]; then
  echo "node-test-watchdog: не удалось создать временную папку данных" >&2
  exit 2
fi

# Снимает временное состояние после wait, в том числе при превышении RSS.
# Удаляется только каталог, созданный текущим запуском сторожа.
cleanup_test_home() {
  rm -rf -- "$TEST_DATA_HOME"
}

trap cleanup_test_home EXIT

# Старые настройки не должны наследоваться даже до перехода на новые имена.
# Префикс берётся из общего модуля, чтобы тесты не заводили второй список совместимости.
LEGACY_ENV_PREFIX=$(node -e '
  const path = require("node:path");
  const legacy = require(path.resolve(process.argv[1]));
  process.stdout.write(legacy.LEGACY.envPrefix);
' "$(dirname "${BASH_SOURCE[0]}")/../shared/runtime/legacyBrand.ts") || exit $?
while IFS= read -r key; do
  if [[ "$key" == "$LEGACY_ENV_PREFIX"* ]]; then
    unset "$key"
  fi
done < <(compgen -e)

terminate_group() {
  if (( STOPPING )); then
    return
  fi

  STOPPING=1
  kill -TERM -- "-$TEST_PID" 2>/dev/null || true

  for _ in 1 2 3 4; do
    if ! kill -0 "$TEST_PID" 2>/dev/null; then
      return
    fi
    sleep 0.25
  done

  kill -KILL -- "-$TEST_PID" 2>/dev/null || true
}

forward_signal() {
  terminate_group
}

# Папка артефактов — рабочая папка агентов, а не личные данные: снимки, кэши сборок и
# временные стенды тестов должны пережить прогон. Поэтому она берётся из настоящей папки
# данных до подмены GRIGDESK_HOME; неверная внешняя папка оставляет артефакты во временной.
ARTIFACTS_ENV=()
if [[ -n "${GRIGDESK_ARTIFACTS_DIR:-}" ]]; then
  ARTIFACTS_ENV=("GRIGDESK_ARTIFACTS_DIR=$GRIGDESK_ARTIFACTS_DIR")
elif source "$(dirname "${BASH_SOURCE[0]}")/../deploy/lib/runtime-env.sh" \
  && REAL_DATA_HOME=$(grigdesk_data_home 2>/dev/null) && [[ -d "$REAL_DATA_HOME" ]]; then
  ARTIFACTS_ENV=("GRIGDESK_ARTIFACTS_DIR=$REAL_DATA_HOME/artifacts")
fi

# Пути живого .env (сервер передаёт его ключи агентам) тоже не наследуются: иначе тесты
# с ...process.env писали бы журнал и версии интерфейса в настоящую папку данных.
setsid env -u GRIGDESK_ENV_FILE -u GRIGDESK_UI_RELEASES_DIR -u GRIGDESK_LOG \
  ${ARTIFACTS_ENV[@]+"${ARTIFACTS_ENV[@]}"} \
  NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$HEAP_MB" \
  GRIGDESK_HOME="$TEST_DATA_HOME" node "$@" &
TEST_PID=$!

trap forward_signal INT TERM HUP

while kill -0 "$TEST_PID" 2>/dev/null; do
  CURRENT_RSS_KB="$(
    ps -eo pgid=,rss= \
      | awk -v pgid="$TEST_PID" '$1 == pgid { sum += $2 } END { print sum + 0 }'
  )"

  if (( CURRENT_RSS_KB > PEAK_RSS_KB )); then
    PEAK_RSS_KB=$CURRENT_RSS_KB
  fi

  if (( CURRENT_RSS_KB > MAX_RSS_KB )); then
    echo "node-test-watchdog: RSS ${CURRENT_RSS_KB}KB превысил ${MAX_RSS_KB}KB; останавливаю process group" >&2
    terminate_group
    wait "$TEST_PID" 2>/dev/null || true
    echo "node-test-watchdog: peak-rss=${PEAK_RSS_KB}KB" >&2
    exit 137
  fi

  sleep "$POLL_SECONDS"
done

wait "$TEST_PID"
STATUS=$?
echo "node-test-watchdog: peak-rss=${PEAK_RSS_KB}KB" >&2
exit "$STATUS"
