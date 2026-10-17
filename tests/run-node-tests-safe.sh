#!/usr/bin/env bash
# Ограничивает не только V8 heap coordinator-а, но и суммарный RSS всех test
# workers и их дочерних процессов. Это ловит native/external allocations, которые
# --max-old-space-size не видит (например, форматирование циклического DOM wrapper).
#
# Сторож считает группу целиком, поэтому при --test-concurrency>1 бюджет задаётся
# на ВСЕ одновременные файлы: NODE_TEST_MAX_RSS_MB не меньше гигабайта на worker
# (контракт tests/server|web/test-runner-memory.contract.test.js).
set -uo pipefail

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
# Внешнее COCKPIT_HOME не наследуется, сбой mktemp запрещает запуск Node.
if ! TEST_DATA_HOME=$(mktemp -d "${TMPDIR:-/tmp}/cockpit-test-home.XXXXXX") \
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
# данных до подмены COCKPIT_HOME; неверная внешняя папка оставляет артефакты во временной.
ARTIFACTS_ENV=()
if [[ -n "${COCKPIT_ARTIFACTS_DIR:-}" ]]; then
  ARTIFACTS_ENV=("COCKPIT_ARTIFACTS_DIR=$COCKPIT_ARTIFACTS_DIR")
elif source "$(dirname "${BASH_SOURCE[0]}")/../deploy/lib/runtime-env.sh" \
  && REAL_DATA_HOME=$(cockpit_data_home 2>/dev/null); then
  ARTIFACTS_ENV=("COCKPIT_ARTIFACTS_DIR=$REAL_DATA_HOME/artifacts")
fi

# Пути живого .env (сервер передаёт его ключи агентам) тоже не наследуются: иначе тесты
# с ...process.env писали бы журнал и версии интерфейса в настоящую папку данных.
setsid env -u COCKPIT_ENV_FILE -u COCKPIT_UI_RELEASES_DIR -u COCKPIT_LOG \
  ${ARTIFACTS_ENV[@]+"${ARTIFACTS_ENV[@]}"} \
  NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$HEAP_MB" \
  COCKPIT_HOME="$TEST_DATA_HOME" node "$@" &
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
