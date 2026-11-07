#!/usr/bin/env bash
# Сквозной контракт использует общий Node memory guard; собственный launcher внутри теста настоящий.
# Guard окружения suite остаётся включённым, synthetic provider разрешён только изолированному child.
export PATH="$(dirname "$NODE_BIN"):$PATH"
NODE_TEST_MAX_RSS_MB=4096 bash "$FACTORY_HOME/../tests/run-node-tests-safe.sh" --test \
  --test-name-pattern='typed status|недействительный status|прогресс|ведущий|Factory не разрешает' \
  "$FACTORY_HOME/../tests/server/gigacode-factory.test.js"
