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

setsid env NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$HEAP_MB" \
  node "$@" &
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
