import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';

import providersModule from '../../../server/src/modules/providers/index.ts';
import { PrefsStore } from '../../../server/src/lib/prefsStore.ts';
import authPlugin, { SESSION_COOKIE } from '../../../server/src/plugins/auth.ts';

const require = createRequire(new URL('../../../server/package.json', import.meta.url));
const Fastify = require('fastify');

export const cookie = `${SESSION_COOKIE}=provider-install-fixture`;

/**
 * Барьер управляется тестом и удерживает команду или обновление моделей.
 * Он исключает привязку проверки глобального lock к скорости машины.
 */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return {
    promise,
    resolve,
    reject
  };
}

/**
 * Ожидание ограничено реальным сроком, но не требует угадать задержку процесса.
 * Ошибка указывает, какое наблюдаемое состояние так и не наступило.
 */
export async function until(read, accept, message = 'состояние не наступило') {
  const deadline = Date.now() + 4000;

  do {
    const value = await read();

    if (accept(value)) {
      return value;
    }

    await tick();
  } while (Date.now() < deadline);

  assert.fail(message);
}

/**
 * Настоящий модуль получает только временные пути и две подмены discovery.
 * Команда по умолчанию является собственным node-скриптом, а не installer машины.
 */
export async function installFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-install-'));
  const config = {
    rootDir: root,
    modelsPath: path.join(root, 'models.json'),
    providerUsageSeenPath: path.join(root, 'usage.json'),
    providerInstallStatePath: path.join(root, 'provider-installs', 'state.json'),
    kimiLaunchMode: options.mode || 'host',
    ...options.config,
  };
  const calls = {
    adapters: 0,
    models: [],
    commands: [],
    events: []
  };
  const gate = deferred();
  const modelGate = deferred();
  let installed = options.installed ?? true;
  let version = options.before || '1.0.0';
  let latest = '2.0.0';
  let executed = false;
  const executable = path.join(root, 'fixture-cli');
  const marker = path.join(root, 'spawned');
  const command = `${executable} --fixture-update`;

  await fs.writeFile(executable,
    `#!${process.execPath}\n`
      + `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok');\n`,
    { mode: 0o755 });

  const descriptor = {
    install: {
      executable,
      args: ['--fixture-install'],
      command,
      fallbackCommand: command
    },
    update: {
      executable,
      args: ['--fixture-update'],
      command,
      fallbackCommand: command
    },
    loginCommand: 'fixture login',
  };
  const provider = {
    id: 'claude',
    name: 'Исполнитель фикстуры',
    type: 'universal',
    install: command,
    login: descriptor.loginCommand,
    bin: () => executable,
    probe: async () => executed && options.probeAfter
      ? options.probeAfter : ({
        ok: installed,
        version: installed ? version : ''
      }),
    auth: async () => ({
      mode: 'fixture',
      available: false,
      label: 'Нет входа'
    }),
    settings: [],
    credentials: [],
    latestVersion: async () => latest,
    updateCmd: ['--fixture-update'],
    installation: () => descriptor,
  };
  const adapters = options.adapters || new Map([[provider.id, provider]]);
  const runner = options.runner || (async (bin, args, runOptions) => {
    const result = {
      code: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      stdout: 'готово',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      workspaceLimitExceeded: false,
      ...options.commandResult,
    };

    calls.commands.push({
      bin,
      args,
      options: runOptions
    });
    // Как у настоящего runCommand, result содержит уже переданные потоками байты.
    // Вывод фикстуры мал и не обрезается, поэтому обе формы должны совпадать целиком.
    runOptions.onStdout?.(result.stdout);
    runOptions.onStderr?.(result.stderr);
    await gate.promise;
    installed = true;
    executed = true;
    version = options.after || '2.0.0';

    return result;
  });
  const app = Fastify({ logger: false });

  app.decorate('sse', {
    broadcast: (event, data) => calls.events.push({
      event,
      data: structuredClone(data)
    }),
  });
  t.after(async () => {
    gate.resolve();
    modelGate.resolve();
    await app.close();
    await fs.rm(root, {
      recursive: true,
      force: true
    });
  });

  if (options.auth) {
    await app.register(authPlugin, {
      authStore: {
        isConfigured: () => true,
        isValidSession: (value) => value === 'provider-install-fixture',
      },
    });
  }

  const serviceEnv = {
    PATH: root,
    HOME: root
  };

  await app.register(providersModule, {
    config,
    env: serviceEnv,
    prefs: new PrefsStore({ prefsPath: path.join(root, 'prefs.json') }),
    getProviderAdapters: async () => {
      calls.adapters += 1;

      return adapters;
    },
    getModelsRegistry: async (_config, modelOptions) => {
      calls.models.push(modelOptions);

      if (modelOptions?.refresh && options.holdModels) {
        await modelGate.promise;
      }
      if (modelOptions?.refresh && options.modelsError) {
        throw new Error('Каталог моделей недоступен');
      }

      return {};
    },
    providerInstall: {
      runCommand: runner,
      ...options.providerInstall
    },
  });
  await app.ready();

  return {
    app,
    root,
    config,
    calls,
    gate,
    modelGate,
    provider,
    descriptor,
    adapters,
    marker,
    env: serviceEnv,
    setLatest: (value) => {
      latest = value;
    },
    setVersion: (value) => {
      version = value;
    },
    setInstalled: (value) => {
      installed = value;
    },
  };
}

/**
 * Снимок берётся через публичный HTTP-контракт, не из внутреннего lock сервиса.
 * Отсутствующий маршрут даёт точную исходную причину RED вместо ошибки import.
 */
export async function current(app) {
  const response = await app.inject('/api/providers/installations/current');

  assert.equal(response.statusCode, 200, `Нет серверного снимка установки: ${response.body}`);

  return response.json();
}

/**
 * Действие задаётся маршрутом, команда в тело запроса не добавляется.
 * Тест явно выбирает единственный допустимый id исполнителя и операцию.
 */
export function start(app, id = 'claude', operation = 'update', payload) {
  return app.inject({
    method: 'POST',
    url: `/api/providers/${id}/${operation}/start`,
    payload
  });
}

/**
 * Окончание означает устойчивый итог без активной операции.
 * Внутренние таймеры и устройство очереди сервиса тесту не нужны.
 */
export function completed(app, id = 'claude') {
  return until(() => current(app), (snapshot) => !snapshot.active && Boolean(snapshot.recent[id]));
}
