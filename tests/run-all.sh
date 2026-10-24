#!/usr/bin/env bash
# Единый прогон проекта: не запускает GrigDesk и не вызывает реальные ИИ.
# Холодная legacy fixture сама устанавливает exact зависимости; прогретая работает без npm.
set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RC=0

# Один прогон на рабочее дерево. Параллельные копии кодируют одно и то же видео в
# showcase-тестах, вешают машину и перетирают логи друг друга, а человеку со стороны
# лишний прогон неотличим от брошенного. Лок снимает ядро при закрытии дескриптора,
# так что kill и падение не оставляют мусора; дескриптор наследуют дети, поэтому лок
# держится, пока жив хоть один процесс прогона — его и называем в отказе, ведь
# записанный в файле pid к этому моменту мог уже смениться на потомка.
# Изолированный прогон может хранить замок вместе с журналом вне дерева исходников.
RUN_ALL_LOCK="${GRIGDESK_RUN_ALL_LOCK:-$PROJECT_ROOT/.state/run-all.lock}"
mkdir -p "$(dirname "$RUN_ALL_LOCK")"

if command -v flock >/dev/null 2>&1; then
  exec {RUN_ALL_LOCK_FD}<>"$RUN_ALL_LOCK"

  if ! flock -n "$RUN_ALL_LOCK_FD"; then
    echo "В этом дереве прогон уже идёт: $(cat "$RUN_ALL_LOCK" 2>/dev/null)" >&2

    if command -v fuser >/dev/null 2>&1; then
      echo "Держат процессы: $(fuser "$RUN_ALL_LOCK" 2>/dev/null | tr -s ' ')" >&2
    fi

    echo "Второй прогон здесь не нужен — дождись первого или останови его сам." >&2
    exit 3
  fi

  printf 'pid=%s дерево=%s начат=%s\n' "$$" "$PROJECT_ROOT" "$(date '+%Y-%m-%d %H:%M:%S')" \
    >"$RUN_ALL_LOCK"
else
  echo "Внимание: flock недоступен, защита от параллельного прогона выключена." >&2
fi

# Fixtures остаются внутри темы; pinned Node cache сохраняет отдельный явный root.
if [[ -z "${GRIGDESK_TEST_DEEPSEEK_ROOT:-}" ]]; then
  GRIGDESK_TEST_DEEPSEEK_ROOT=$(node --input-type=module -e '
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const { artifactsPath } = await import(pathToFileURL(process.argv[1]).href);
    console.log(path.join(artifactsPath({env: process.env, home: os.homedir()}), "deepseek-binary"));
  ' "$PROJECT_ROOT/shared/runtime/dataHome.ts")
fi
export GRIGDESK_TEST_DEEPSEEK_ROOT
export GRIGDESK_ARTIFACTS_DIR="$GRIGDESK_TEST_DEEPSEEK_ROOT"
export GRIGDESK_DEEPSEEK_NODE_CACHE="${GRIGDESK_DEEPSEEK_NODE_CACHE:-$GRIGDESK_TEST_DEEPSEEK_ROOT/node-cache}"

# Один проверенный ELF передаётся всем наборам; исходники Harness рядом с ним не нужны.
# Preflight сам проходит сторож памяти, не загружает зависимости и не меняет рабочий bin.
if ! DEEPSEEK_TEST_INFO=$(NODE_TEST_MAX_RSS_MB=4096 bash "$PROJECT_ROOT/tests/run-node-tests-safe.sh" \
  "$PROJECT_ROOT/tests/helpers/deepseekBinary.mts" --prepare-suite); then
  exit 1
fi
GRIGDESK_TEST_DEEPSEEK_BINARY=$(node -e \
  'process.stdout.write(JSON.parse(process.argv[1]).binary)' "$DEEPSEEK_TEST_INFO")
GRIGDESK_TEST_DEEPSEEK_CACHE_DIR=$(node -e \
  'process.stdout.write(JSON.parse(process.argv[1]).cacheDir)' "$DEEPSEEK_TEST_INFO")
GRIGDESK_TEST_DEEPSEEK_PAYLOAD=$(node -e \
  'process.stdout.write(JSON.parse(process.argv[1]).payloadFile)' "$DEEPSEEK_TEST_INFO")
export GRIGDESK_TEST_DEEPSEEK_BINARY GRIGDESK_TEST_DEEPSEEK_CACHE_DIR GRIGDESK_TEST_DEEPSEEK_PAYLOAD
export GRIGDESK_RELEASE_PUBLISH_CONTRACT=2
export GRIGDESK_TEST_GLM_DELIVERY=binary

# Cutover fixture сама готовит отдельные зависимости под ABI тестового Node.
# Рабочую поставку и подготовленный pinned prefix эта установка не меняет.
if ! GRIGDESK_TEST_DEEPSEEK_ARTIFACT=$(NODE_TEST_MAX_RSS_MB=4096 \
  bash "$PROJECT_ROOT/tests/run-node-tests-safe.sh" "$PROJECT_ROOT/tests/helpers/deepseekRuntimeArtifact.mts"); then
  exit 1
fi
export GRIGDESK_TEST_DEEPSEEK_ARTIFACT

npm --prefix "$PROJECT_ROOT/deepseek" run typecheck || RC=1
npm --prefix "$PROJECT_ROOT/deepseek" test || RC=1
npm --prefix "$PROJECT_ROOT/deepseek" run test:sea || RC=1

bash "$PROJECT_ROOT/tests/layout.sh" || RC=1
# Часть проверок уже на TypeScript: с минимумом Node 22.18 они исполняются как есть.
NODE_TEST_MAX_RSS_MB=4096 bash "$PROJECT_ROOT/tests/run-node-tests-safe.sh" --test \
  --test-concurrency=2 "$PROJECT_ROOT"/tests/docs/*.test.mjs \
  "$PROJECT_ROOT"/tests/docs/*.test.mts || RC=1
NODE_TEST_MAX_RSS_MB=4096 bash "$PROJECT_ROOT/tests/run-node-tests-safe.sh" --test \
  --test-concurrency=2 "$PROJECT_ROOT"/tests/shared/*.test.mts || RC=1
bash "$PROJECT_ROOT/tests/engine/run-offline.sh" || RC=1
npm --prefix "$PROJECT_ROOT/server" test || RC=1
npm --prefix "$PROJECT_ROOT/web" test || RC=1
npm --prefix "$PROJECT_ROOT/relay" test || RC=1
npm --prefix "$PROJECT_ROOT/b24" test || RC=1
NODE_TEST_MAX_RSS_MB=4096 bash "$PROJECT_ROOT/tests/run-node-tests-safe.sh" --test \
  --test-concurrency=2 "$PROJECT_ROOT"/tests/mobile/*.test.js || RC=1
NODE_TEST_MAX_RSS_MB=4096 bash "$PROJECT_ROOT/tests/run-node-tests-safe.sh" --test \
  --test-concurrency=2 "$PROJECT_ROOT"/tests/desktop/*.test.js || RC=1

NODE_TEST_MAX_RSS_MB=4096 bash "$PROJECT_ROOT/tests/run-node-tests-safe.sh" --test \
  --test-concurrency=2 "$PROJECT_ROOT"/tests/cli/*.test.mts || RC=1

exit "$RC"
