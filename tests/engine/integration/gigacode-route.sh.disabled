#!/usr/bin/env bash
# Kernel profile и новый wrapper проверяются тем же harness с настоящим launcher.
# Внешняя подмена ограничена синтетическим исполняемым CLI, а не функцией run.
export PATH="$(dirname "$NODE_BIN"):$PATH"
NODE_TEST_MAX_RSS_MB=4096 bash "$FACTORY_HOME/../tests/run-node-tests-safe.sh" --test \
  --test-name-pattern='execution planner|timeout Factory|текст «готово»|Factory без discovery' \
  "$FACTORY_HOME/../tests/server/gigacode-factory.test.js"
