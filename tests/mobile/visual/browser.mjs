import { readdir, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Браузер берётся из явной настройки или установленного кэша Playwright этой машины.
 * Проверка использует полный Chromium, поскольку headless-shell не обслуживает часть Web API.
 */
export async function chromiumPath() {
  if (process.env.GRIGDESK_CHROMIUM) {
    await access(process.env.GRIGDESK_CHROMIUM);

    return process.env.GRIGDESK_CHROMIUM;
  }

  const root = path.join(
    process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'),
    'ms-playwright',
  );
  const versions = (await readdir(root))
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));

  for (const version of versions) {
    for (const binary of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const file = path.join(root, version, binary);

      if (
        await access(file).then(
          () => true,
          () => false,
        )
      ) {
        return file;
      }
    }
  }

  throw new Error('Полный Chromium не установлен. Укажите GRIGDESK_CHROMIUM.');
}
