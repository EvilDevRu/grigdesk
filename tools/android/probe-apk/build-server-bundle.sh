#!/usr/bin/env bash
# Пробный серверный bundle для 3a (JS bundle по Q2; SEA — отдельная проба 2).
# Опции зеркалируют продуктовый buildStage.mts: bundle/platform=node/format=cjs/
# target=node24. Нативные .node не пакуются в JS-bundle: опциональные нативные
# зависимости (ssh2) деградируют до JS-фallback; для пробы это фиксируется в отчёте.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
OUT="$HERE/assets"
ESBUILD="$ROOT/server/node_modules/.bin/esbuild"

[[ -x "$ESBUILD" ]] || { echo "esbuild не установлен: npm --prefix server ci" >&2; exit 1; }

mkdir -p "$OUT"
"$ESBUILD" "$ROOT/server/src/app.ts" \
  --bundle \
  --platform=node \
  --target=node24 \
  --format=cjs \
  --external:'*.node' \
  --outfile="$OUT/server-bundle.js" \
  --log-level=warning

sha256sum "$OUT/server-bundle.js"