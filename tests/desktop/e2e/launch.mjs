import path from 'node:path';

import { _electron } from '../../../desktop/node_modules/playwright-core/index.mjs';

const desktop = path.resolve(import.meta.dirname, '../../../desktop');

// Системные переменные сессии, без которых Electron не откроет окно и связку ключей.
const SESSION_KEYS = [
  'DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'HOME',
  'XDG_RUNTIME_DIR',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'GSETTINGS_BACKEND',
  'NO_AT_BRIDGE',
  'PLAYWRIGHT_BROWSERS_PATH',
  'LANG',
];

/**
 * Окружение по списку-разрешению: проверка с запуском сервера из приложения не должна
 * унаследовать порт, ключи и маркеры живого сервера из окружения исполнителя.
 */
function sessionEnv() {
  const env = {};

  for (const name of SESSION_KEYS) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }

  env.PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;

  return env;
}

/**
 * Путь данных и ключа обязан оставаться внутри собственного root проверки.
 * Добавления env сохраняют сессию изоляции, а Node-only flags не попадают в Electron.
 */
export function desktopLaunchOptions({
  executablePath,
  args,
  dataDir,
  root,
  env: extra = {},
  isolateEnv = false,
}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new Error('Root проверки должен быть абсолютным.');
  }

  for (const value of [dataDir, extra.GRIGDESK_WINDOW_KEY_PATH]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw new Error('Профиль и путь ключа должны быть абсолютными.');
    }

    const relative = path.relative(root, value);

    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new Error('Профиль и путь ключа должны находиться внутри root проверки.');
    }
  }

  const env = isolateEnv ? sessionEnv() : { ...process.env };

  for (const [name, value] of Object.entries(extra)) {
    if (name !== 'HOME' && !name.startsWith('XDG_') && !name.startsWith('DBUS_')) {
      env[name] = value;
    }
  }

  env.GRIGDESK_DESKTOP_DATA_DIR = dataDir;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  return {
    executablePath: executablePath ?? path.join(desktop, 'node_modules/electron/dist/electron'),
    args: args ?? [desktop],
    chromiumSandbox: true,
    env,
    timeout: 30000,
  };
}

/**
 * Главное окно загружает локальный документ трубы, независимо от адреса сервера.
 * Фиксированный диапазон принадлежит профилям оболочки; заставка остаётся file:.
 */
export function isPipePage(page) {
  try {
    const url = new URL(page.url());

    return url.protocol === 'http:' && url.hostname === '127.0.0.1'
      && Number(url.port) >= 47100 && Number(url.port) <= 47199;
  } catch {
    return false;
  }
}

/**
 * Заставка — страница file: с dist/splash/index.html; главное окно — страница выбранного origin.
 * Используется и сценариями старта, чтобы различать окна одинаково.
 */
export function isSplashPage(page) {
  const url = page.url();

  return url.startsWith('file:') && url.endsWith('/splash/index.html');
}

/**
 * Показ главного окна: заставки уже нет, видимое окно main открыло выбранный origin.
 * Страница возвращается только после показа, а не при скрытой загрузке во время старта.
 */
async function waitForMainWindow(app, timeout = 45_000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const pages = app.windows();
    const main = pages.find(isPipePage);

    if (main && !pages.some(isSplashPage)) {
      const visible = await app.evaluate(({ BrowserWindow }, selected) => BrowserWindow.getAllWindows()
        .some((window) => window.isVisible() && window.webContents.getURL() === selected), main.url());

      if (visible) {
        return main;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Главное окно не показано за ${timeout} мс.`);
}

/**
 * Helper не запускает окно при импорте и возвращает app вместе с показанным главным окном.
 * При сбое ожидания показа собственный процесс закрывается до возврата ошибки.
 */
export async function launchDesktop(input) {
  const app = await _electron.launch(desktopLaunchOptions(input));

  try {
    const page = await waitForMainWindow(app);

    page.setDefaultTimeout(30000);

    return { app, page };
  } catch (error) {
    await app.close().catch(() => undefined);

    throw error;
  }
}

/**
 * Сырой запуск для сценариев старта: ни заставку, ни главное окно не ждёт.
 * Сценарий сам наблюдает окна и выход процесса.
 */
export async function launchDesktopRaw(input) {
  return { app: await _electron.launch(desktopLaunchOptions(input)) };
}
