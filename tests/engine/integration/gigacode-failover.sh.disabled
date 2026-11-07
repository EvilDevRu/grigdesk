#!/usr/bin/env bash
# Реальный классификатор анализирует сохранённые host events, не слова ответа модели.
# Симметричный dispatcher дополнительно проверяется общей матрицей интеграций.
export PATH="$(dirname "$NODE_BIN"):$PATH"
NODE_TEST_MAX_RSS_MB=4096 bash "$FACTORY_HOME/../tests/run-node-tests-safe.sh" --test \
  --test-concurrency=2 "$FACTORY_HOME/../tests/server/gigacode-failures.test.js" \
  "$FACTORY_HOME/../tests/server/gigacode-dispatch.test.js"
