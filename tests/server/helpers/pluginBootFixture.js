import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import assert from 'node:assert/strict';
import { PluginInstallStateStore } from '../../../server/src/lib/packageInstall/stateStore.ts';
import {
  liveGroupMembers,
  terminateOwnedWorker,
} from '../../../server/src/lib/packageInstall/workerIdentity.ts';

import { AuthStore } from '../../../server/src/lib/authStore.ts';

/**
 * Fixture спрашивает свободный loopback порт у ОС и освобождает probe socket.
 * Настоящий GrigDesk port никогда не используется для проверки boot.
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();

    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();

      probe.close(() => resolve(port));
    });
  });
}

/**
 * Boot получает allowlist env и все mutable paths в одном собственном root.
 * Новые installer paths заданы явно, без discovery конфигурации машины.
 */
export function isolatedEnv(root, port, mobilePort = port + 1) {
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
    GRIGDESK_DB_ENGINES_DIR: path.join(root, 'db-engines'),
    GRIGDESK_DB_ENGINE_INSTALLS_STATE_PATH: path.join(root, 'state/db-engine-installs.json'),
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
    GRIGDESK_TELEGRAM_ACCOUNT_CREDS_PATH: path.join(root, 'state/telegram.json'),
    GRIGDESK_GITHUB_CREDS_PATH: path.join(root, 'state/github.json'),
  };
}


/**
 * Собственный child проходит настоящий app boot и реальную авторизацию.
 * Cleanup сначала ждёт окончания процесса, затем удаляет только его временный root.
 */
export async function pluginBootFixture(t, {
  root: existingRoot,
  before,
  env = {},
  badState = false,
  badDbEngineState = false,
  apiSession = true,
  port: requestedPort,
} = {}) {
  const root = existingRoot ?? await mkdtemp(path.join(os.tmpdir(), 'grigdesk-installer-boot-'));
  let child;
  let exited;

  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }

    const store = new PluginInstallStateStore({
      statePath: path.join(root, 'state/plugin-installs.json'),
      hasWorkEvidence: async () => false,
    });
    const disk = await store.read().catch((error) => {
      if (badState && error.code === 'state_invalid') {
        return null;
      }

      throw error;
    });

    for (const worker of Object.values(disk?.workers ?? {})) {
      assert.equal(await terminateOwnedWorker(worker), true);
      assert.deepEqual(await liveGroupMembers(worker.pgid), []);
    }

    const driverStore = new PluginInstallStateStore({
      statePath: path.join(root, 'state/db-engine-installs.json'),
      hasWorkEvidence: async () => false,
    });
    const driverDisk = await driverStore.read().catch((error) => {
      if (badDbEngineState && error.code === 'state_invalid') {
        return null;
      }

      throw error;
    });

    for (const worker of Object.values(driverDisk?.workers ?? {})) {
      assert.equal(await terminateOwnedWorker(worker), true);
      assert.deepEqual(await liveGroupMembers(worker.pgid), []);
    }

    if (!existingRoot) {
      await rm(root, { recursive: true, force: true });
    }
  });

  const port = requestedPort ?? await freePort();
  const mobilePort = await freePort();
  const selected = {
    ...isolatedEnv(root, port, mobilePort),
    ...env,
  };
  const keyPath = selected.GRIGDESK_WINDOW_KEY_PATH;
  const keyRelative = path.relative(root, keyPath);

  if (!path.isAbsolute(keyPath) || !keyRelative || keyRelative === '..'
    || keyRelative.startsWith('../') || path.isAbsolute(keyRelative) || keyPath.endsWith('/')) {
    throw new Error('Путь ключа окна должен оставаться внутри root фикстуры.');
  }

  const session = {};

  if (apiSession) {
    const authStore = new AuthStore({
      legacyAccountPath: selected.GRIGDESK_AUTH_ACCOUNT,
      sessionsPath: selected.GRIGDESK_AUTH_SESSIONS,
    });

    session.cookie = `grigdesk_sid=${authStore.createSession().id}`;
  }

  if (before) {
    await before({ root, env: selected });
  }

  child = spawn(process.execPath, [fileURLToPath(new URL('../../../server/src/app.ts', import.meta.url))], {
    env: selected,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  exited = once(child, 'exit');

  let log = '';

  child.stdout.on('data', (value) => log += value);
  child.stderr.on('data', (value) => log += value);


  const address = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  let ready = false;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Fixture app завершился до listen: ${log}`);
    }

    try {
      const response = await fetch(address + '/api/health', { signal: AbortSignal.timeout(1000) });

      ready = response.status === 401;

      if (ready) {
        break;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  if (!ready) {
    throw new Error(`Fixture app не поднялся: ${log}`);
  }

  const cli = { 'x-grigdesk-token': (await readFile(selected.GRIGDESK_CLI_TOKEN_PATH, 'utf8')).trim() };
  const get = (route, headers = cli) => fetch(address + route, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  const post = (route, input) => fetch(address + route, {
    method: 'POST',
    headers: { ...session, 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10_000),
  });

  return {
    root,
    address,
    child,
    exited,
    env: selected,
    cli,
    session,
    get,
    post,
  };
}

/**
 * Poll ждёт конкретного terminal/ready outcome по настоящему socket API.
 * Deadline fixture ограничивает ошибку, не подменяя service.whenIdle через sleep.
 */
export async function waitBootJob(fixture, predicate) {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    const response = await fixture.get('/api/plugin-installs/jobs/current');

    if (response.status !== 200) {
      throw new Error(`Fixture job HTTP ${response.status}`);
    }

    const body = await response.json();

    if (predicate(body.job)) {
      return body;
    }

    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  throw new Error('Fixture job не достиг ожидаемого статуса.');
}
