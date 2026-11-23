#!/usr/bin/env bash
# Пробный серверный bundle для 3a (JS bundle по Q2; SEA — отдельная проба 2).
# Собственные URL и таблицы модулей готовит тот же сборщик, что в поставке сервера.
# Production npm разворачивается рядом с bundle без install-скриптов хостовой ОС.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
STAGE="$(mktemp -d "$HERE/.runtime.XXXXXXXX")"
trap 'rm -rf -- "$STAGE"' EXIT

node "$HERE/build-server-bundle.mts" "$STAGE/runtime"
npm --prefix "$STAGE/runtime" ci --omit=dev --ignore-scripts --no-audit --no-fund

# Android AssetMerger считает foo и foo.gz одним именем. Архив сохраняет оба
# файла зависимостей без вмешательства в их репозиторий или runtime-граф.
(cd "$STAGE/runtime" && zip -q -r "$STAGE/runtime.zip" .)
mkdir -p "$HERE/assets"
mv -f -- "$STAGE/runtime.zip" "$HERE/assets/runtime.zip"
sha256sum "$HERE/assets/runtime.zip"

if [[ -n ${GRIGDESK_ANDROID_USERLAND_BUILD:-} ]]; then
  for abi in arm64-v8a x86_64; do
    python="$GRIGDESK_ANDROID_USERLAND_BUILD/$abi/python3-install"
    archive="python-$abi.zip"

    test -f "$python/lib/python3.12/encodings/__init__.py"
    (cd "$python" && zip -q -r "$STAGE/$archive" lib/python3.12 -x '*/__pycache__/*')
    mv -f -- "$STAGE/$archive" "$HERE/assets/$archive"
    sha256sum "$HERE/assets/$archive"
  done
fi

# Автономная поставка DeepSeek (android/arm64) кладётся в jniLibs как libdeepseek.so:
# nativeLibraryDir — единственное место, откуда домен приложения вправе делать exec
# (W^X targetSdk 29+ запрещает исполнение из каталога данных). GRIGDESK_ANDROID_DEEPSEEK_SUPPLY
# указывает каталог кандидата (sea-bionic-fix/work) с ELF «deepseek». SEA несёт payload
# внутри себя; strip отключается отдельно в probe.init.gradle, чтобы не тронуть SEA-блоб.
if [[ -n ${GRIGDESK_ANDROID_DEEPSEEK_SUPPLY:-} ]]; then
  elf="$GRIGDESK_ANDROID_DEEPSEEK_SUPPLY/deepseek"

  test -f "$elf"
  cp -f -- "$elf" "$HERE/jniLibs/arm64-v8a/libdeepseek.so"
  sha256sum "$HERE/jniLibs/arm64-v8a/libdeepseek.so"
fi
