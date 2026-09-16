import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../../server/src/app.ts', import.meta.url));

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
function isolatedEnv(root, port) {
  return {
    PATH: '/usr/bin:/bin',
    HOME: root,
    NODE_ENV: 'production',
    COCKPIT_PORT: String(port),
    COCKPIT_TLS_PORT: String(port + 1),
    COCKPIT_HOST: '127.0.0.1',
    COCKPIT_CHATS_DIR: path.join(root, 'chats'),
    COCKPIT_TELEGRAM_DIR: path.join(root, 'telegram'),
    COCKPIT_GITHUB_DIR: path.join(root, 'github'),
    FACTORY_STATE_DIR: path.join(root, 'factory/state'),
    FACTORY_CONTROL_ROOT: path.join(root, 'factory/control'),
    FACTORY_CONFIG_ROOT: path.join(root, 'factory/config'),
    FACTORY_PROFILES_DIR: path.join(root, 'profiles'),
    COCKPIT_AGENTS_DIR: path.join(root, 'agents'),
    COCKPIT_MEDIA_DIR: path.join(root, 'media'),
    COCKPIT_PLUGINS_DIR: path.join(root, 'plugins'),
    COCKPIT_TICKETS_DIR: path.join(root, 'tickets'),
    COCKPIT_ROUTES_DIR: path.join(root, 'routes'),
    COCKPIT_GATEWAY_DIR: path.join(root, 'gateway'),
    COCKPIT_ANALYSIS_DIR: path.join(root, 'analysis'),
    COCKPIT_TLS_DIR: path.join(root, 'tls'),
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
    COCKPIT_PREFS_PATH: path.join(root, 'state/prefs.json'),
    COCKPIT_AUTH_ACCOUNT: path.join(root, 'state/auth.json'),
    COCKPIT_AUTH_SESSIONS: path.join(root, 'state/sessions.json'),
    COCKPIT_CLI_TOKEN_PATH: path.join(root, 'state/cli-token'),
    COCKPIT_KNOWLEDGE_DB_PATH: path.join(root, 'state/knowledge.db'),
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

  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  t.after(async () => {
    child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  });

  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`сервер не поднялся:\n${log}`)), 90_000);
    const watch = setInterval(() => {
      const match = /Server listening at (http:\/\/[^"\s]+)/.exec(log);

      if (match) {
        clearInterval(watch);
        clearTimeout(timer);
        resolve(match[1]);
      }
    }, 100);

    child.once('exit', (code) => {
      clearInterval(watch);
      clearTimeout(timer);
      reject(new Error(`сервер завершился с кодом ${code}:\n${log}`));
    });
  });

  const response = await fetch(`${address}/api/health`);
  const body = await response.json();

  assert.deepEqual({ status: response.status, error: body.error }, {
    status: 401,
    error: 'unauthorized',
  });
});
