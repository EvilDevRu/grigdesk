#!/usr/bin/env bash
# Общая подготовка закреплённых Electron и AppImage tools для Linux x64/ARM64.
# npm ci не запускает native lifecycle: архивы проверяются до распаковки.
set -euo pipefail

tools=${1:?Укажите абсолютный путь для AppImage tools}
[[ $# == 1 && $tools == /* ]]
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "Неподдерживаемая архитектура Linux: $(uname -m)" >&2; exit 1 ;;
esac
electron=desktop/node_modules/electron
version=$(node -p 'require("./desktop/node_modules/electron/package.json").version')
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ $version == "$(node -p 'require("./desktop/package.json").devDependencies.electron')" ]]

mkdir -p -- "$(dirname -- "$tools")"
staging=$(mktemp -d "$(dirname -- "$tools")/.release-desktop-XXXXXXXX")
electron_staging=
trap 'rm -rf -- "$staging" "$electron_staging"' EXIT

# В Actions используется доступный токен GitHub. Локальный рецепт читает
# те же публичные артефакты по HTTPS в закрытом окружении без учётных данных.
download_asset() {
  local repository=$1 tag=$2 name=$3
  if [[ -n ${GH_TOKEN:-} ]]; then
    local attempt
    for attempt in 1 2 3; do
      if gh release download "$tag" --repo "$repository" --pattern "$name" \
        --output "$staging/$name" --clobber; then
        return
      fi
      [[ $attempt != 3 ]] || return 1
      sleep 5
    done
  else
    curl -q -fLsS --proto '=https' --proto-redir '=https' --retry 2 --max-time 300 \
      "https://github.com/$repository/releases/download/$tag/$name" -o "$staging/$name"
  fi
}

if [[ ! -d $electron/dist ]]; then
  archive=electron-v$version-linux-$arch.zip
  checksum=$(node -p 'require("./desktop/node_modules/electron/checksums.json")[process.argv[1]]' "$archive")
  [[ $checksum =~ ^[0-9a-f]{64}$ ]]
  download_asset electron/electron "v$version" "$archive"
  download_asset electron/electron "v$version" SHASUMS256.txt
  (cd "$staging" && sha256sum --check --strict --ignore-missing SHASUMS256.txt)
  printf '%s  %s\n' "$checksum" "$staging/$archive" | sha256sum --check --strict

  electron_staging=$(mktemp -d "$electron/.dist-XXXXXXXX")
  unzip -q "$staging/$archive" -d "$electron_staging"
  [[ -x $electron_staging/electron && $(<"$electron_staging/version") == "$version" ]]
  if [[ -f $electron_staging/electron.d.ts ]]; then
    mv -- "$electron_staging/electron.d.ts" "$electron/electron.d.ts"
  fi
  printf '%s' electron >"$electron/path.txt"
  mv -T -- "$electron_staging" "$electron/dist"
fi

[[ -x $electron/dist/electron && $(<"$electron/path.txt") == electron ]]
installed_version=$(<"$electron/dist/version")
[[ ${installed_version#v} == "$version" ]]

if [[ ! -d $tools ]]; then
  archive=appimage-12.0.1.7z
  download_asset electron-userland/electron-builder-binaries appimage-12.0.1 "$archive"
  printf '%s  %s\n' d12ff7eb8f1d1ec4652ca5237a7fbdca33acc0c758045636feca62dc6ecb8ec4 \
    "$staging/$archive" | sha256sum --check --strict
  7z x -y "-o$staging/appimage" "$staging/$archive" >/dev/null
  [[ -x $staging/appimage/linux-$arch/mksquashfs &&
    -x $staging/appimage/linux-$arch/desktop-file-validate && -f $staging/appimage/runtime-$arch ]]
  mv -T -- "$staging/appimage" "$tools"
fi

[[ -x $tools/linux-$arch/mksquashfs && -x $tools/linux-$arch/desktop-file-validate && -f $tools/runtime-$arch ]]
