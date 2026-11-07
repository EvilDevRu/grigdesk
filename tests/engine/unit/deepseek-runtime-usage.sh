#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/runner-launcher.sh"

assert_eq deepseek-jsonl-unknown "$(_runner_runtime_usage_dialect deepseek 0.1.5-rc.2)" \
  "DeepSeek Factory stream stays deliberately unregistered for billing usage"

finish_tests
