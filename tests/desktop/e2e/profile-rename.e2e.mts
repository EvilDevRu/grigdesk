import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { LEGACY } from '../../../shared/runtime/legacyBrand.ts';
import { desktopLaunchOptions } from './launch.mjs';

interface Markers {
  local?: string;
  indexed?: string;
  error?: string;
}

/**
 * Страница работает с настоящими localStorage и IndexedDB внутри пакетного окна.
 * До закрытия она завершает транзакцию и отправляет результат только своей HTTP-фикстуре.
 */
function markerPage(write: boolean, marker: string): string {
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Перенос профиля</title>
<body><h1>Проверка профиля</h1><script>
(async () => {
  let result;
  try {
    const write = ${JSON.stringify(write)};
    const marker = ${JSON.stringify(marker)};
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('profile-migration-fixture', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('markers');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (write) {
      localStorage.setItem('profile-migration-fixture', marker);
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('markers', 'readwrite');
        transaction.objectStore('markers').put(marker, 'persisted');
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
    }
    const indexed = await new Promise((resolve, reject) => {
      const transaction = database.transaction('markers', 'readonly');
      const request = transaction.objectStore('markers').get('persisted');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    result = { local: localStorage.getItem('profile-migration-fixture'), indexed };
  } catch (error) {
    result = { error: String(error) };
  }
  await fetch('/probe/profile', { method: 'POST', body: JSON.stringify(result) });
  window.close();
})();
</script></body></html>`;
}

/**
 * Сервер принимает два поколения заголовка, но работает лишь со случайным ключом теста.
 * Фазы сохраняют один origin: иначе браузерные базы не могли бы показать перенос профиля.
 */
async function profileServer(root: string, key: string, marker: string) {
  const sessions = new Set<string>();
  const reports: Markers[] = [];
  let exchanges = 0;
  let writing = true;
  const oldCookie = `${LEGACY.configDir}_sid`;

  const authenticated = (request: IncomingMessage): boolean =>
    (request.headers.cookie ?? '').split(/;\s*/).some((item) => {
      const [name, value] = item.split('=');

      return [oldCookie, 'grigdesk_sid'].includes(name ?? '') && sessions.has(value ?? '');
    });

  // Отвечает только на ручки входа, manifest встроенного UI и пробу собственных данных.
  // Ошибки чтения скрывают содержимое файла; тест видит код HTTP и срок ожидания.
  const respond = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;

    response.setHeader('Cache-Control', 'no-store');

    if (pathname === '/api/auth/state') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ configured: true, authenticated: authenticated(request) }));
    } else if (pathname === '/api/auth/window-session' && request.method === 'POST') {
      const oldHeader = `x-${LEGACY.configDir}-window-key`;
      const old = request.headers[oldHeader] === key;

      if (!old && request.headers['x-grigdesk-window-key'] !== key) {
        response.writeHead(401).end('{}');

        return;
      }

      const sid = randomBytes(24).toString('base64url');

      exchanges += 1;
      sessions.add(sid);
      response.setHeader('Set-Cookie',
        `${old ? oldCookie : 'grigdesk_sid'}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
      response.setHeader('Content-Type', 'application/json');
      response.end('{}');
    } else if (pathname === '/probe/profile' && request.method === 'POST') {
      let body = '';

      for await (const chunk of request) {
        body += String(chunk);
      }

      reports.push(JSON.parse(body) as Markers);
      response.end('{}');
    } else if (!authenticated(request)) {
      response.writeHead(401).end('{}');
    } else if (/^\/ui\/[a-f0-9]{64}\/release\.json$/.test(pathname)) {
      response.setHeader('Content-Type', 'application/json');
      response.end(await readFile(path.join(root, 'ui-releases', pathname.slice(4))));
    } else if (pathname === '/' || /^\/ui\/[a-f0-9]{64}\/$/.test(pathname)) {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(markerPage(writing, marker));
    } else {
      response.writeHead(404).end();
    }
  };
  const server = createServer((request, response) => {
    void respond(request, response).catch(() => response.writeHead(500).end('Ошибка фикстуры.'));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();

  assert.ok(address && typeof address === 'object');

  return {
    address: `http://127.0.0.1:${address.port}`,
    reports,
    exchanges: () => exchanges,
    readOnly: () => {
      writing = false;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

/**
 * Запускает только пакет из явно заданного пути и ждёт штатного закрытия страницы.
 * Cleanup завершает лишь свой child, если приложение не уложилось в срок.
 */
async function runPackage(
  root: string, executable: string, profile: string, address: string, legacy: boolean,
): Promise<void> {
  const keyFile = path.join(root, 'window-auth/key');
  const options = desktopLaunchOptions({
    root,
    dataDir: profile,
    executablePath: executable,
    isolateEnv: true,
    args: [`--${legacy ? LEGACY.configDir : 'grigdesk'}-url=${address}`, '--password-store=gnome-libsecret'],
    env: {
      GRIGDESK_WINDOW_KEY_PATH: keyFile,
      GRIGDESK_UI_RELEASES_DIR: path.join(root, 'ui-releases'),
    },
  });
  const env: NodeJS.ProcessEnv = { ...options.env };

  if (legacy) {
    for (const suffix of ['DESKTOP_DATA_DIR', 'WINDOW_KEY_PATH', 'UI_RELEASES_DIR']) {
      env[`${LEGACY.envPrefix}${suffix}`] = env[`GRIGDESK_${suffix}`];
      delete env[`GRIGDESK_${suffix}`];
    }
  }

  const child: ChildProcess = spawn(options.executablePath, options.args, {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const exited = once(child, 'exit');
  let log = '';
  let deadline: ReturnType<typeof setTimeout> | undefined;

  child.stderr!.on('data', (chunk) => {
    log += String(chunk);
  });

  try {
    const [code, signal] = await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Пакет не закрылся за 45 с.')), 45000);
      }),
    ]);

    assert.equal(signal, null);
    assert.equal(code, 0, log.slice(-2000));
  } finally {
    clearTimeout(deadline);

    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
}

/**
 * Старое и новое окно разделяют только origin и перенесённую копию профиля.
 * Новая cookie создаётся один раз; повторный запуск обязан обойтись без нового входа.
 */
test('GO-E2E: старые базы профиля читаются новым пакетом, вход по ключу нужен один раз',
  { timeout: 180000 }, async (t) => {
    const oldExecutable = process.env.GRIGDESK_PROFILE_OLD_EXECUTABLE;
    const newExecutable = process.env.GRIGDESK_PACKAGED_EXECUTABLE;
    const sessionHome = process.env.HOME ?? '';

    if (!oldExecutable || !newExecutable || !path.basename(sessionHome).startsWith('grigdesk-desktop-home-')
      || !sessionHome.startsWith(os.tmpdir() + '/') || !process.env.DBUS_SESSION_BUS_ADDRESS) {
      t.skip('Нужны старый и новый пакеты и одноразовая сессия isolated-session.sh.');

      return;
    }

    await access(oldExecutable);
    await access(newExecutable);

    const root = await mkdtemp(path.join(sessionHome, 'profile-rename-'));
    const marker = randomBytes(16).toString('hex');
    const key = randomBytes(32).toString('base64url');
    const oldProfile = path.join(root, 'config', LEGACY.profileDir);
    const newProfile = path.join(root, 'config/GrigDesk');

    await mkdir(path.join(root, 'window-auth'), { mode: 0o700 });
    await writeFile(path.join(root, 'window-auth/key'), key, { mode: 0o600 });

    const server = await profileServer(root, key, marker);

    t.after(async () => {
      await server.close();
      await rm(root, { recursive: true, force: true });
    });

    await runPackage(root, oldExecutable, oldProfile, server.address, true);
    assert.deepEqual(server.reports, [{ local: marker, indexed: marker }]);

    const library = fileURLToPath(new URL('../../../deploy/lib/desktop-app.sh', import.meta.url));
    const copied = spawnSync('bash', ['-c', 'source "$1"; grigdesk_migrate_desktop_profile', '_', library], {
      env: {
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, 'config'),
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      },
      encoding: 'utf8',
      timeout: 30000,
    });

    assert.equal(copied.status, 0, copied.stderr);
    server.readOnly();

    const first = server.exchanges();

    await runPackage(root, newExecutable, newProfile, server.address, false);
    assert.equal(server.exchanges() - first, 1);
    assert.deepEqual(server.reports[1], { local: marker, indexed: marker });

    const second = server.exchanges();

    await runPackage(root, newExecutable, newProfile, server.address, false);
    assert.equal(server.exchanges(), second);
    assert.deepEqual(server.reports[2], { local: marker, indexed: marker });
  });
