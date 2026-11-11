#!/usr/bin/env bash
# Ограничивает не только V8 heap coordinator-а, но и суммарный RSS всех test
# workers и их дочерних процессов. Это ловит native/external allocations, которые
# --max-old-space-size не видит (например, форматирование циклического DOM wrapper).
#
# Сторож считает группу целиком, поэтому при --test-concurrency>1 бюджет задаётся
# на ВСЕ одновременные файлы: NODE_TEST_MAX_RSS_MB не меньше гигабайта на worker
# (контракт tests/server|web/test-runner-memory.contract.test.js).
set -uo pipefail

# Тяжёлый файл получает отдельную группу, но все исходные проверки всё равно выполняются.
# Общие параметры Node сохраняются, а первый отказ не скрывает результат второй группы.
isolate_test_file() {
  local selected_file="$1" heap="$2" label="$3"

  shift 3

  local test_mode=0 regular_count=0 requested=0 argument regular_status selected_status
  local -a regular_args=() selected_args=()

  for argument in "$@"; do
    if [[ "$argument" == --test ]]; then
      test_mode=1
    fi

    if [[ "$argument" -ef "$selected_file" ]]; then
      if (( ! requested )); then
        selected_args+=("$argument")
      fi

      requested=1
    elif [[ "$argument" =~ \.test\.(js|mjs|mts|ts)$ && -f "$argument" ]]; then
      regular_count=$((regular_count + 1))
      regular_args+=("$argument")
    else
      regular_args+=("$argument")
      selected_args+=("$argument")
    fi
  done

  if (( ! test_mode || ! requested )); then
    return
  fi

  if (( regular_count > 0 )); then
    bash "${BASH_SOURCE[0]}" "${regular_args[@]}"
    regular_status=$?

    NODE_TEST_HEAP_MB="$heap" NODE_TEST_MAX_RSS_MB=4096 \
      bash "${BASH_SOURCE[0]}" "${selected_args[@]}"
    selected_status=$?

    if (( regular_status != 0 )); then
      exit "$regular_status"
    fi

    exit "$selected_status"
  fi

  export NODE_TEST_HEAP_MB="$heap" NODE_TEST_MAX_RSS_MB=4096
  echo "node-test-watchdog: отдельный $label; heap=${heap}MB RSS=4096MB" >&2
}

TESTS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
isolate_test_file "$TESTS_ROOT/server/chat-list-benchmark.test.mjs" 2048 benchmark "$@"
isolate_test_file "$TESTS_ROOT/server/deepseek-upstream-update.test.js" 1024 source-sync "$@"

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
