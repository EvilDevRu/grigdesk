#!/bin/bash
# Подготовка одноразовой Ubuntu 24.04 для релизных проверок GrigDesk.
# Требует явный --disposable-environment: на рабочей ОС script не запускается.
# Bash обязателен: перенос песочницы Chromium использует process substitution.
set -eu

if [ "${1:-}" != "--disposable-environment" ]; then
  echo 'provision-ubuntu.sh: укажите --disposable-environment' >&2
  exit 2
fi

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  bubblewrap apparmor ffmpeg ripgrep python3-pil xvfb libfuse2t64 unzip p7zip-full

ffmpeg -version
ffprobe -version
rg --version
python3 -c 'from PIL import Image; print(Image.__version__)'

# Браузер тестов и его системные зависимости ставятся здесь: стадия рецепта
# server-browser сознательно без --with-deps (решение 14 — без sudo в прогонах).
npm --prefix server ci
node server/node_modules/playwright-core/cli.js install --with-deps chromium

# Песочница Chromium: AppArmor-профили и реальная проба запуска переносятся
# из шага «Песочница Chromium» grigdesk-release.yml:169–213 дословно.
index=0

while IFS= read -r browser; do
  index=$((index + 1))
  profile="/etc/apparmor.d/grigdesk-ci-chromium-$index"
  sudo tee "$profile" > /dev/null <<APPARMOR
abi <abi/4.0>,
include <tunables/global>
profile grigdesk-ci-chromium-$index "$browser" flags=(unconfined) {
  userns,
}
APPARMOR
  sudo apparmor_parser -r "$profile"
done < <(find "$HOME/.cache/ms-playwright" -type f \( -name chrome -o -name chrome-headless-shell \))

test "$index" -gt 0

node --input-type=module <<'NODE'
import { chromium } from './server/node_modules/playwright-core/index.mjs';

for (const channel of [undefined, 'chromium']) {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, channel });

  try {
    const page = await browser.newPage();

    await page.goto('data:text/html,<title>sandbox probe</title>');

    if (await page.title() !== 'sandbox probe') {
      throw new Error('chromium_sandbox_probe_failed');
    }
  } finally {
    await browser.close();
  }
}
NODE

sudo tee /etc/apparmor.d/grigdesk-ci-bwrap > /dev/null <<'APPARMOR'
abi <abi/4.0>,
include <tunables/global>
profile grigdesk-ci-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
APPARMOR
sudo apparmor_parser -r /etc/apparmor.d/grigdesk-ci-bwrap
bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- /usr/bin/true

sudo tee /etc/apparmor.d/grigdesk-ci-unshare > /dev/null <<'APPARMOR'
abi <abi/4.0>,
include <tunables/global>
profile grigdesk-ci-unshare /usr/bin/unshare flags=(unconfined) {
  userns,
}
APPARMOR
sudo apparmor_parser -r /etc/apparmor.d/grigdesk-ci-unshare
unshare -Urnm /usr/bin/true

df -h .
printf '%s\n' 'provision-ubuntu: готово (одноразовая среда)'
