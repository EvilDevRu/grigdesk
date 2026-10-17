import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import assert from 'node:assert/strict';
import { PluginInstallStateStore } from '../../../server/src/lib/pluginInstall/stateStore.ts';
import {
  liveGroupMembers,
  terminateOwnedWorker,
} from '../../../server/src/lib/pluginInstall/workerIdentity.ts';

import { AuthStore } from '../../../server/src/lib/authStore.ts';

/**
 * Fixture спрашивает свободный loopback порт у ОС и освобождает probe socket.
 * Настоящий Cockpit port никогда не используется для проверки boot.
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
    COCKPIT_HOME: root,
    NODE_ENV: 'production',
    COCKPIT_PORT: String(port),
    COCKPIT_WINDOW_KEY_PATH: path.join(root, 'window-auth/window-key'),
    COCKPIT_MOBILE_DIR: path.join(root, 'mobile'),
    COCKPIT_MOBILE_PORT: String(mobilePort),
    COCKPIT_MOBILE_APK_DIR: path.join(root, 'mobile-apk'),
    COCKPIT_HOST: '0.0.0.0',
    COCKPIT_TRUST_PROXY: '127.0.0.1',
    COCKPIT_CHATS_DIR: path.join(root, 'chats'),
    COCKPIT_3D_DIR: path.join(root, '3d'),
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
    COCKPIT_PLUGINS_DATA_DIR: path.join(root, 'plugin-data'),
    COCKPIT_PLUGIN_INSTALLS_STATE_PATH: path.join(root, 'state/plugin-installs.json'),
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
    COCKPIT_UI_RELEASES_DIR: path.join(root, 'ui-releases'),
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
 * Собственный child проходит настоящий app boot и реальную авторизацию.
 * Cleanup сначала ждёт окончания процесса, затем удаляет только его временный root.
 */
export async function pluginBootFixture(t, {
  root: existingRoot,
  before,
  env = {},
  badState = false,
  apiSession = true,
  port: requestedPort,
} = {}) {
  const root = existingRoot ?? await mkdtemp(path.join(os.tmpdir(), 'cockpit-installer-boot-'));
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
  const keyPath = selected.COCKPIT_WINDOW_KEY_PATH;
  const keyRelative = path.relative(root, keyPath);

  if (!path.isAbsolute(keyPath) || !keyRelative || keyRelative === '..'
    || keyRelative.startsWith('../') || path.isAbsolute(keyRelative) || keyPath.endsWith('/')) {
    throw new Error('Путь ключа окна должен оставаться внутри root фикстуры.');
  }

  const session = {};

  if (apiSession) {
    const authStore = new AuthStore({
      legacyAccountPath: selected.COCKPIT_AUTH_ACCOUNT,
      sessionsPath: selected.COCKPIT_AUTH_SESSIONS,
    });

    session.cookie = `cockpit_sid=${authStore.createSession().id}`;
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

  const cli = { 'x-cockpit-token': (await readFile(selected.COCKPIT_CLI_TOKEN_PATH, 'utf8')).trim() };
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
