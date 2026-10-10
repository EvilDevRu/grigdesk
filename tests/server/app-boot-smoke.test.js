import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../../server/src/app.ts', import.meta.url));
const INSTALLED_APP = fileURLToPath(new URL('../../server/src/app.js', import.meta.url));

/**
 * Свободный порт спрашивается у системы. Ноль в COCKPIT_PORT не подходит: сервер
 * читает его как «не задано» и берёт свой рабочий порт — проверка запуска пришла бы
 * прямо в живой кокпит.
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
// права трогать живой кокпит — ни переписку, ни модели, ни состояние фабрики.
function isolatedEnv(root, port, mobilePort = port + 1) {
  return {
    PATH: '/usr/bin:/bin',
    HOME: root,
    NODE_ENV: 'production',
    COCKPIT_PORT: String(port),
    COCKPIT_MOBILE_DIR: path.join(root, 'mobile'),
    COCKPIT_MOBILE_PORT: String(mobilePort),
    COCKPIT_MOBILE_APK_DIR: path.join(root, 'mobile-apk'),
    COCKPIT_HOST: '0.0.0.0',
    COCKPIT_TRUST_PROXY: '127.0.0.1',
    COCKPIT_CHATS_DIR: path.join(root, 'chats'),
    COCKPIT_TELEGRAM_DIR: path.join(root, 'telegram'),
    COCKPIT_GITHUB_DIR: path.join(root, 'github'),
    FACTORY_STATE_DIR: path.join(root, 'factory/state'),
    FACTORY_CONTROL_ROOT: path.join(root, 'factory/control'),
    FACTORY_CONFIG_ROOT: path.join(root, 'factory/config'),
    FACTORY_PROFILES_DIR: path.join(root, 'profiles'),
    COCKPIT_AGENTS_DIR: path.join(root, 'agents'),
    COCKPIT_MEDIA_DIR: path.join(root, 'media'),
    COCKPIT_MEDIA_HF_DIR: path.join(root, 'hf'),
    COCKPIT_PLUGINS_DIR: path.join(root, 'plugins'),
    COCKPIT_TICKETS_DIR: path.join(root, 'tickets'),
    COCKPIT_ROUTES_DIR: path.join(root, 'routes'),
    COCKPIT_ANALYSIS_DIR: path.join(root, 'analysis'),
    COCKPIT_SSH_AUDIT_DIR: path.join(root, 'ssh'),
    COCKPIT_DB_AUDIT_DIR: path.join(root, 'db'),
    COCKPIT_SANDBOX_JOURNAL_DIR: path.join(root, 'sandbox'),
    // Раздел презентаций на старте сверяет журнал заданий с процессами и гасит
    // «пропавшие». Без своих каталогов пробный сервер сверял ЖИВОЙ журнал кокпита
    // и обрывал идущую сборку ролика: «Исполнитель задания не пережил перезапуск».
    COCKPIT_SHOWCASE_DIR: path.join(root, 'showcase'),
    COCKPIT_SHOWCASE_AUTH_DIR: path.join(root, 'showcase-auth'),
    COCKPIT_SHOWCASE_VOICE_DIR: path.join(root, 'showcase-voice'),
    COCKPIT_SHOWCASE_BROWSER_DIR: path.join(root, 'showcase-browser'),
    COCKPIT_MODELS_PATH: path.join(root, 'state/models.json'),
    COCKPIT_USAGE_FORECAST_PATH: path.join(root, 'state/usage-forecast.json'),
    COCKPIT_WEB_LOG_DIR: path.join(root, 'web-log'),
    COCKPIT_PREFS_PATH: path.join(root, 'state/prefs.json'),
    COCKPIT_AUTH_ACCOUNT: path.join(root, 'state/auth.json'),
    COCKPIT_AUTH_SESSIONS: path.join(root, 'state/sessions.json'),
    COCKPIT_CLI_TOKEN_PATH: path.join(root, 'state/cli-token'),
    COCKPIT_TASK_SHELF_PATH: path.join(root, 'state/shelf.json'),
    COCKPIT_TASK_SEEN_PATH: path.join(root, 'state/seen.json'),
    COCKPIT_TASK_FAVORITES_PATH: path.join(root, 'state/favorites.json'),
    COCKPIT_UPDATE_STATE_PATH: path.join(root, 'state/update.json'),
    COCKPIT_ARBITER_CARDS_PATH: path.join(root, 'state/arbiter.json'),
    COCKPIT_CLAUDE_AUTH_PATH: path.join(root, 'state/claude-auth.json'),
    COCKPIT_CHAT_STORE: path.join(root, 'state/chats.json'),
    COCKPIT_CHAT_BINDINGS_DIR: path.join(root, 'state/bindings'),
    COCKPIT_SSH_CONNECTIONS_PATH: path.join(root, 'state/ssh.json'),
    COCKPIT_SSH_KNOWN_HOSTS_PATH: path.join(root, 'state/known_hosts'),
    COCKPIT_DB_PROFILES_PATH: path.join(root, 'state/db.json'),
    COCKPIT_PROVIDER_USAGE_SEEN_PATH: path.join(root, 'state/usage.json'),
    B24_CREDS_PATH: path.join(root, 'state/b24.json'),
    B24_COOKIE_PATH: path.join(root, 'state/b24-cookie.txt'),
    COCKPIT_TELEGRAM_ACCOUNT_CREDS_PATH: path.join(root, 'state/telegram.json'),
    COCKPIT_GITHUB_CREDS_PATH: path.join(root, 'state/github.json'),
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-boot-'));
  const port = await freePort();
  const child = spawn(process.execPath, [APP], {
    env: isolatedEnv(root, port),
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

  await t.test('LO-03: внешний IPv4 не отвечает на порт Cockpit', { skip: !external }, async () => {
    await assert.rejects(fetch(`http://${external.address}:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    }));
  });

  const state = await fetch(`${address}/api/auth/state`, {
    headers: { 'X-Forwarded-Proto': 'https' },
  });

  assert.equal(state.status, 200);
  assert.equal((await state.json()).secure, false);

  // Каталог шаблонов журнала окна собирает хук onRoute до регистрации модулей:
  // в нём должны оказаться маршруты модулей, а не только самого журнала.
  const token = (await readFile(path.join(root, 'state/cli-token'), 'utf8')).trim();
  const routes = await fetch(`${address}/api/web-log/routes`, {
    headers: { 'X-Cockpit-Token': token },
  });
  const catalog = (await routes.json()).routes;

  assert.equal(routes.status, 200);
  assert.ok(catalog.includes('/api/health'), 'маршрут модуля health есть в каталоге');
  assert.ok(catalog.includes('/api/tasks'), 'маршрут модуля задач есть в каталоге');
  assert.ok(catalog.includes('/api/web-log/routes'));
  assert.ok(catalog.every((template) => template.startsWith('/api')));
});

/**
 * Настоящий app.ts запускается с чистым либо повреждённым мобильным состоянием.
 * Отказ отдельного TLS listener не должен мешать локальному входу и остальным API.
 */
test('мобильный вход поднимается отдельно, его отказ не роняет Cockpit', { timeout: 120_000 }, async (t) => {
  for (const mode of ['ready', 'occupied', 'corrupt']) {
    await t.test(mode, async (scope) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-mobile-boot-'));
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

          headers = { 'X-Cockpit-Token': token };

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
