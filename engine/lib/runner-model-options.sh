#!/usr/bin/env bash

# Metadata helper поставляется рядом с тем же движком и использует его Node.
# Список раннера передаётся целиком: чатовый каталог не расширяет запуск этапов.
_runner_model_options() {
  local provider=$1 node=${NODE_BIN:-} catalog cli=""
  [[ -n "$node" ]] || node="$FACTORY_HOME/../runtime/node/bin/node"
  [[ -x "$node" ]] || node=$(command -v node) || return 4
  catalog=$("runner_${provider}_catalog") || catalog=""
  case "$provider" in
    claude|codex) cli=$(factory_external_bin "$provider" "$provider") || return 4 ;;
    qwen) cli=$(factory_external_bin qwen "${GRIGDESK_QWEN_BIN:-qwen}") || return 4 ;;
  esac
  factory_exec provider "$node" "$FACTORY_HOME/../server/scripts/factoryRunnerModels.mts" \
    "$provider" "$catalog" "$cli"
}
