import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * Получает отдельный свободный loopback-порт вместо нуля или рабочего порта сервера.
 * Пробный socket закрывается до запуска; основной и мобильный порты выбираются отдельно.
 */
async function freePort(): Promise<number> {
  const server = createServer();

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Не удалось получить loopback порт');
  }

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  return address.port;
}

/**
 * Все изменяемые пути smoke принадлежат одному временному D, HOME также новый.
 */
function smokeEnvironment(root: string, port: number, mobilePort: number): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'xdg/config'),
    XDG_CACHE_HOME: path.join(root, 'xdg/cache'),
    XDG_DATA_HOME: path.join(root, 'xdg/data'),
    GRIGDESK_HOME: root,
    GRIGDESK_PORT: String(port),
    GRIGDESK_MOBILE_PORT: String(mobilePort),
    GRIGDESK_WINDOW_KEY_PATH: path.join(root, 'window-auth/window-key'),
    GRIGDESK_PLUGINS_DIR: path.join(root, 'plugins'),
    GRIGDESK_PLUGINS_DATA_DIR: path.join(root, 'plugin-data'),
    GRIGDESK_PLUGIN_INSTALLS_STATE_PATH: path.join(root, 'state/plugin-installs.json'),
    GRIGDESK_SHOWCASE_DIR: path.join(root, 'showcase'),
    GRIGDESK_SHOWCASE_AUTH_DIR: path.join(root, 'showcase-auth'),
    GRIGDESK_SHOWCASE_VOICE_DIR: path.join(root, 'showcase-voice'),
    GRIGDESK_SHOWCASE_BROWSER_DIR: path.join(root, 'showcase-browser'),
    FACTORY_STATE_DIR: path.join(root, 'factory/state'),
    FACTORY_CONTROL_ROOT: path.join(root, 'factory/control'),
    FACTORY_CONFIG_ROOT: path.join(root, 'factory/config'),
    FACTORY_PROFILES_DIR: path.join(root, 'profiles'),
    NODE_ENV: 'production',
  };
}

/**
 * Поднимает только собственный SEA с временными данными и проверяет auth и SIGTERM.
 * Результат определяется ответом HTTP и exit code; cleanup ждёт только созданный здесь child.
 */
export async function smokeRelease(root: string): Promise<void> {
  const data = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-smoke-'));
  const port = await freePort();
  const mobilePort = await freePort();

  await mkdir(path.join(data, 'home'), { recursive: true });

  const child = spawn(path.join(root, 'server/grigdesk-server'), [], {
    cwd: '/',
    env: smokeEnvironment(data, port, mobilePort),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let log = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);

  child.stdout.on('data', (chunk: Buffer) => {
    log = (log + chunk.toString()).slice(-65536);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    log = (log + chunk.toString()).slice(-65536);
  });

  try {
    const deadline = Date.now() + 45000;
    let ready = false;

    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(500),
        });
        const body = await response.json() as { error?: string };

        if (response.status !== 401 || body.error !== 'unauthorized') {
          throw new Error(`Неожиданный auth ответ: ${response.status}`);
        }

        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    if (!ready) {
      throw new Error(`SEA smoke: сервер не поднялся\n${log}`);
    }

    child.kill('SIGTERM');

    const result = await exited;

    if (result.code !== 0 || result.signal !== null) {
      throw new Error(`SEA smoke: завершение ${JSON.stringify(result)}\n${log}`);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }

    await exited.catch(() => undefined);
    clearTimeout(timer);
    await rm(data, { recursive: true, force: true });
  }
}
