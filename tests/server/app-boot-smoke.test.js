import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { pluginBootFixture } from './helpers/pluginBootFixture.js';

const APP = fileURLToPath(new URL('../../server/src/app.ts', import.meta.url));
const INSTALLED_APP = fileURLToPath(new URL('../../server/src/app.js', import.meta.url));

/**
 * Свободный порт спрашивается у системы. Ноль в GRIGDESK_PORT не подходит: сервер
 * читает его как «не задано» и берёт свой рабочий порт — проверка запуска пришла бы
 * прямо в живой GrigDesk.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();

    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();

      probe.close(() => resolve(port));
    });
  });
}

// Всё состояние сервера уводится во временный каталог: проверка запуска не имеет
// права трогать живой GrigDesk — ни переписку, ни модели, ни состояние фабрики.
function isolatedEnv(root, port, mobilePort = port + 1) {
  return {
    PATH: '/usr/bin:/bin',
    HOME: path.join(root, 'home'),
    GRIGDESK_HOME: root,
    NODE_ENV: 'production',
    GRIGDESK_PORT: String(port),
    GRIGDESK_WINDOW_KEY_PATH: path.join(root, 'window-auth/window-key'),
    GRIGDESK_MOBILE_DIR: path.join(root, 'mobile'),
    GRIGDESK_MOBILE_PORT: String(mobilePort),
    GRIGDESK_MOBILE_APK_DIR: path.join(root, 'mobile-apk'),
    GRIGDESK_HOST: '0.0.0.0',
    GRIGDESK_TRUST_PROXY: '127.0.0.1',
    GRIGDESK_CHATS_DIR: path.join(root, 'chats'),
    GRIGDESK_3D_DIR: path.join(root, '3d'),
    GRIGDESK_TELEGRAM_DIR: path.join(root, 'telegram'),
    GRIGDESK_GITHUB_DIR: path.join(root, 'github'),
    FACTORY_STATE_DIR: path.join(root, 'factory/state'),
    FACTORY_CONTROL_ROOT: path.join(root, 'factory/control'),
    FACTORY_CONFIG_ROOT: path.join(root, 'factory/config'),
    FACTORY_PROFILES_DIR: path.join(root, 'profiles'),
    GRIGDESK_MEDIA_DIR: path.join(root, 'media'),
    GRIGDESK_MEDIA_HF_DIR: path.join(root, 'hf'),
    GRIGDESK_PLUGINS_DIR: path.join(root, 'plugins'),
    GRIGDESK_PLUGINS_DATA_DIR: path.join(root, 'plugin-data'),
    GRIGDESK_PLUGIN_INSTALLS_STATE_PATH: path.join(root, 'state/plugin-installs.json'),
    GRIGDESK_TICKETS_DIR: path.join(root, 'tickets'),
    GRIGDESK_ROUTES_DIR: path.join(root, 'routes'),
    GRIGDESK_ANALYSIS_DIR: path.join(root, 'analysis'),
    GRIGDESK_SSH_AUDIT_DIR: path.join(root, 'ssh'),
    GRIGDESK_DB_AUDIT_DIR: path.join(root, 'db'),
    GRIGDESK_SANDBOX_JOURNAL_DIR: path.join(root, 'sandbox'),
    // Раздел презентаций на старте сверяет журнал заданий с процессами и гасит
    // «пропавшие». Без своих каталогов пробный сервер сверял ЖИВОЙ журнал GrigDesk
    // и обрывал идущую сборку ролика: «Исполнитель задания не пережил перезапуск».
    GRIGDESK_SHOWCASE_DIR: path.join(root, 'showcase'),
    GRIGDESK_SHOWCASE_AUTH_DIR: path.join(root, 'showcase-auth'),
    GRIGDESK_SHOWCASE_VOICE_DIR: path.join(root, 'showcase-voice'),
    GRIGDESK_SHOWCASE_BROWSER_DIR: path.join(root, 'showcase-browser'),
    GRIGDESK_MODELS_PATH: path.join(root, 'state/models.json'),
    GRIGDESK_USAGE_FORECAST_PATH: path.join(root, 'state/usage-forecast.json'),
    GRIGDESK_WEB_LOG_DIR: path.join(root, 'web-log'),
    GRIGDESK_UI_RELEASES_DIR: path.join(root, 'ui-releases'),
    GRIGDESK_PREFS_PATH: path.join(root, 'state/prefs.json'),
    GRIGDESK_AUTH_ACCOUNT: path.join(root, 'state/auth.json'),
    GRIGDESK_AUTH_SESSIONS: path.join(root, 'state/sessions.json'),
    GRIGDESK_CLI_TOKEN_PATH: path.join(root, 'state/cli-token'),
    GRIGDESK_TASK_SHELF_PATH: path.join(root, 'state/shelf.json'),
    GRIGDESK_TASK_SEEN_PATH: path.join(root, 'state/seen.json'),
    GRIGDESK_TASK_FAVORITES_PATH: path.join(root, 'state/favorites.json'),
    GRIGDESK_UPDATE_STATE_PATH: path.join(root, 'state/update.json'),
    GRIGDESK_ARBITER_CARDS_PATH: path.join(root, 'state/arbiter.json'),
    GRIGDESK_CLAUDE_AUTH_PATH: path.join(root, 'state/claude-auth.json'),
    GRIGDESK_CHAT_STORE: path.join(root, 'state/chats.json'),
    GRIGDESK_CHAT_BINDINGS_DIR: path.join(root, 'state/bindings'),
    GRIGDESK_SSH_CONNECTIONS_PATH: path.join(root, 'state/ssh.json'),
    GRIGDESK_SSH_KNOWN_HOSTS_PATH: path.join(root, 'state/known_hosts'),
    GRIGDESK_DB_PROFILES_PATH: path.join(root, 'state/db.json'),
    GRIGDESK_PROVIDER_USAGE_SEEN_PATH: path.join(root, 'state/usage.json'),
    B24_CREDS_PATH: path.join(root, 'state/b24.json'),
    B24_COOKIE_PATH: path.join(root, 'state/b24-cookie.txt'),
    GRIGDESK_TELEGRAM_ACCOUNT_CREDS_PATH: path.join(root, 'state/telegram.json'),
    GRIGDESK_GITHUB_CREDS_PATH: path.join(root, 'state/github.json'),
  };
}

/**
 * /proc показывает реальные LISTEN-сокеты namespace, независимо от firewall.
 * Выделенный порт принадлежит успешно запущенному child; IPv6 проверяется отдельно.
 */
async function listeningAddresses(pid, port) {
  const wanted = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  const records = {};

  for (const family of ['tcp', 'tcp6']) {
    const table = await readFile(`/proc/${pid}/net/${family}`, 'utf8');

    records[family] = table.trim().split('\n').slice(1)
      .map((line) => line.trim().split(/\s+/u))
      .filter((columns) => columns[3] === '0A' && columns[1].endsWith(wanted))
      .map((columns) => columns[1]);
  }

  return records;
}

/**
 * Единственная проверка, которая ловит «сервер не поднялся». Модульные тесты берут
 * каждый кусок по отдельности, а сборка сервисов в app.js собирается только при
 * настоящем старте: переименованный модуль, разошедшийся конструктор адаптера или
 * упавший watcher видны ровно здесь — до того, как человек нажмёт перезапуск.
 */
test('сервер поднимается и закрывает /api гардом', { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-boot-'));
  const port = await freePort();
  const environment = isolatedEnv(root, port);
  const child = spawn(process.execPath, [APP], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';

  child.stdout.on('data', (chunk) => {
    log += chunk;
  });
  child.stderr.on('data', (chunk) => {
    log += chunk;
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');

      child.kill('SIGKILL');
      await exited;
    }

    await rm(root, { recursive: true, force: true });
  });

  // При глобальном off logger молчит, поэтому готовность доказывает ответ сокета,
  // а не строка Fastify в stdout. Тот же запрос проверяет общий auth guard.
  const address = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  let response = null;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`сервер завершился с кодом ${child.exitCode}:\n${log}`);
    }

    try {
      response = await fetch(`${address}/api/health`, { signal: AbortSignal.timeout(1000) });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  assert.ok(response, `сервер не поднялся:\n${log}`);
  const body = await response.json();

  assert.deepEqual({ status: response.status, error: body.error }, {
    status: 401,
    error: 'unauthorized',
  });

  const sockets = await listeningAddresses(child.pid, port);
  const expected = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`;

  assert.deepEqual(sockets, { tcp: [expected], tcp6: [] });

  const external = Object.values(os.networkInterfaces()).flat()
    .find((item) => item?.family === 'IPv4' && !item.internal);

  await t.test('LO-03: внешний IPv4 не отвечает на порт GrigDesk', { skip: !external }, async () => {
    await assert.rejects(fetch(`http://${external.address}:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    }));
  });

  const state = await fetch(`${address}/api/auth/state`, {
    headers: { 'X-Forwarded-Proto': 'https' },
  });

  assert.equal(state.status, 200);
  assert.equal((await state.json()).secure, false);

  await t.test('DW-K7: boot пишет ключ под своим root', async () => {
    assert.equal(environment.GRIGDESK_WINDOW_KEY_PATH, path.join(root, 'window-auth/window-key'));

    const deadline = Date.now() + 3000;
    let exchange;

    while (Date.now() < deadline) {
      try {
        const key = await readFile(environment.GRIGDESK_WINDOW_KEY_PATH, 'utf8');

        exchange = await fetch(address + '/api/auth/window-session', {
          method: 'POST',
          headers: { 'x-grigdesk-window-key': key },
          signal: AbortSignal.timeout(1000),
        });

        if (exchange.status === 200) {
          break;
        }
      } catch {
        // Хук listen ещё может публиковать только свой файл.
        // Срок ожидания не означает обращения к настоящему runtime.
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(exchange?.status, 200);

    const cookie = exchange.headers.get('set-cookie').split(';')[0];
    const health = await fetch(address + '/api/health', {
      headers: { cookie },
      signal: AbortSignal.timeout(1000),
    });

    assert.equal(health.status, 200);
  });

  // Каталог шаблонов журнала окна собирает хук onRoute до регистрации модулей:
  // в нём должны оказаться маршруты модулей, а не только самого журнала.
  const token = (await readFile(path.join(root, 'state/cli-token'), 'utf8')).trim();
  const routes = await fetch(`${address}/api/web-log/routes`, {
    headers: { 'X-GrigDesk-Token': token },
  });
  const catalog = (await routes.json()).routes;

  assert.equal(routes.status, 200);
  assert.ok(catalog.includes('/api/health'), 'маршрут модуля health есть в каталоге');
  assert.ok(catalog.includes('/api/tasks'), 'маршрут модуля задач есть в каталоге');
  assert.ok(catalog.includes('/api/web-log/routes'));
  assert.ok(catalog.every((template) => template.startsWith('/api')));
});

test('DW-K7: boot с невалидным родителем ключа остаётся жив', { timeout: 60000 }, async (t) => {
  const fixture = await pluginBootFixture(t, {
    before: async ({ env }) => {
      await writeFile(path.dirname(env.GRIGDESK_WINDOW_KEY_PATH), 'собственный обычный файл', {
        mode: 0o600,
      });
    },
  });
  const exchange = await fetch(fixture.address + '/api/auth/window-session', {
    method: 'POST',
    signal: AbortSignal.timeout(1000),
  });

  assert.equal(exchange.status, 503);
  assert.equal((await exchange.json()).error, 'window_key_unavailable');
  assert.equal(fixture.child.exitCode, null);
  assert.equal((await fixture.get('/api/health')).status, 200);
});

/**
 * Настоящий app.ts запускается с чистым либо повреждённым мобильным состоянием.
 * Отказ отдельного TLS listener не должен мешать локальному входу и остальным API.
 */
test('мобильный вход поднимается отдельно, его отказ не роняет GrigDesk', { timeout: 120_000 }, async (t) => {
  for (const mode of ['ready', 'occupied', 'corrupt']) {
    await t.test(mode, async (scope) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-mobile-boot-'));
      const port = await freePort();
      let mobilePort = mode === 'occupied' ? port : await freePort();

      while (mode !== 'occupied' && mobilePort === port) {
        mobilePort = await freePort();
      }

      if (mode === 'corrupt') {
        await mkdir(path.join(root, 'mobile'), { recursive: true });
        await writeFile(path.join(root, 'mobile/devices.json'), '{broken', { mode: 0o600 });
      }

      const child = spawn(process.execPath, [INSTALLED_APP], {
        env: isolatedEnv(root, port, mobilePort),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let log = '';

      child.stdout.on('data', (chunk) => {
        log += chunk;
      });
      child.stderr.on('data', (chunk) => {
        log += chunk;
      });
      scope.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');

          child.kill('SIGKILL');
          await exited;
        }

        await rm(root, { recursive: true, force: true });
      });

      const address = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 30000;
      let mobile = null;
      let headers;

      while (Date.now() < deadline) {
        assert.equal(child.exitCode, null, 'app.ts завершился: ' + log);

        try {
          const token = (await readFile(path.join(root, 'state/cli-token'), 'utf8')).trim();

          headers = { 'X-GrigDesk-Token': token };

          const response = await fetch(address + '/api/mobile/status', {
            headers,
            signal: AbortSignal.timeout(1000),
          });
          const status = await response.json();

          if (response.status === 200 && (status.server.up || status.server.error)) {
            mobile = status;
            break;
          }
        } catch {
          // Свежий child ещё пишет свой auth token и регистрирует API.
          // Ожидание ограничено deadline и не обращается к рабочему серверу.
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      assert.ok(mobile, 'Не получили статус мобильного сервиса: ' + log);
      assert.equal(mobile.server.up, mode === 'ready');
      assert.equal((await fetch(address + '/api/health', { headers })).status, 200);
      assert.equal((await fetch(address + '/api/chat/active', { headers })).status, 200);
      assert.equal((await fetch(address + '/api/mobile/status')).status, 401);

      if (mode === 'ready') {
        const sockets = await listeningAddresses(child.pid, mobilePort);
        const expected = `0100007F:${mobilePort.toString(16).toUpperCase().padStart(4, '0')}`;

        assert.deepEqual(sockets, { tcp: [expected], tcp6: [] });
      } else {
        assert.equal(typeof mobile.server.error, 'string');
      }
    });
  }
});
