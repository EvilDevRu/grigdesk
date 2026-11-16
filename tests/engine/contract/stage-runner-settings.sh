#!/usr/bin/env bash
# Сохраняет shell-вход плана и общего offline-набора для того же Node-теста.
# Непосредственный исполняемый файл учтён в manifest; запуск ограничен сторожем памяти.
set -euo pipefail

[[ -x "${NODE_BIN:-}" ]] || exit 78
export PATH="${NODE_BIN%/*}:$PATH"

bash "$FACTORY_TESTS_HOME/../run-node-tests-safe.sh" --test \
  "$FACTORY_TESTS_HOME/contract/stage-runner-settings.test.js"
