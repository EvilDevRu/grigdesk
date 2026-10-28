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
  const hooks = { afterRun: options.afterRun };
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
    ...options.descriptor,
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
    ...options.provider,
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
    await hooks.afterRun?.(result);

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
        isValidSession: (value) => (options.sessions ?? ['provider-install-fixture']).includes(value),
      },
    });
  }

  const serviceEnv = {
    PATH: root,
    HOME: root,
    ...options.env,
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
    hooks,
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

/**
 * npm-стенд собирает внешние Node/npm, пользовательский prefix и shell-файлы
 * в собственных временных каталогах. Настоящий npm машины не участвует, а
 * установленная копия появляется только после разрешённой команды runner-а.
 */
export async function installNpmFixture(t, options = {}) {
  const packageId = options.packageId ?? '@fixture/cli';
  const binName = options.binName ?? 'fixture-cli';
  const configKey = options.configKey ?? 'claudeBin';
  const envKey = options.envKey ?? 'GRIGDESK_CLAUDE_BIN';
  const command = `npm i -g ${packageId}@latest`;
  const binding = {
    packageId,
    binName,
    configKey,
    envKey,
  };
  const descriptor = {
    install: {
      executable: 'npm',
      args: ['i', '-g', `${packageId}@latest`],
      command,
      fallbackCommand: command,
      npmBinding: binding,
    },
    update: {
      executable: 'npm',
      args: ['i', '-g', `${packageId}@latest`],
      command,
      fallbackCommand: command,
      npmBinding: binding,
    },
    loginCommand: `${binName} login`,
    loginArgs: ['login'],
    ...options.descriptor,
  };
  const fixture = await installFixture(t, {
    ...options,
    installed: options.installed ?? true,
    descriptor,
    env: { SHELL: options.shell ?? '/bin/bash', ...options.env },
  });
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-npm-stand-'));
  const prefix = options.prefixInHome ? path.join(fixture.root, '.local')
    : path.join(base, 'prefix');
  const effectivePrefix = options.prefix ?? prefix;
  const external = path.join(base, 'external');
  const npmBinary = path.join(prefix, 'bin', binName);
  const home = fixture.root;

  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(external, { recursive: true });
  await fs.mkdir(prefix, { recursive: true });
  await fs.symlink(process.execPath, path.join(external, 'node'));

  const npmScript = ['#!/bin/sh',
    `if [ "$1" = "prefix" ]; then printf '%s\\n' ${JSON.stringify(effectivePrefix)}; exit 0; fi`,
    'exit 0', ''].join('\n');

  await fs.writeFile(path.join(external, 'npm'), npmScript, { mode: 0o755 });
  fixture.env.PATH = external;
  fixture.config[configKey] = options.configuredBin ?? '/fixture/configured-cli';
  fixture.config.envPath = path.join(home, '.env');
  await fs.writeFile(fixture.config.envPath, '# Настройки фикстуры\nOTHER=value\n');
  await fs.writeFile(path.join(home, '.bashrc'), `export PATH="${external}:$PATH"\n`);
  await fs.writeFile(path.join(home, '.bash_profile'), 'source "$HOME/.bashrc"\n');

  const version = options.afterVersion ?? '2.0.0';
  /**
   * Новая копия появляется только после разрешённой команды runner-а.
   * При `linkBin` создаётся ссылка в пакет prefix, как это делает настоящий npm.
   */
  const createBin = async () => {
    if (options.createBin === false) {
      return;
    }

    await fs.mkdir(path.dirname(npmBinary), { recursive: true });

    if (options.linkBin) {
      // Как настоящий npm: bin — ссылка в установленный пакет выбранного prefix.
      const packageRoot = path.join(prefix, 'lib', 'node_modules', ...packageId.split('/'));
      const entry = path.join(packageRoot, 'bin', 'cli.js');

      await fs.mkdir(path.dirname(entry), { recursive: true });
      await fs.writeFile(path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: packageId, version }));
      await fs.writeFile(entry, `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n`,
        { mode: 0o755 });
      await fs.rm(npmBinary, { force: true });
      await fs.symlink(entry, npmBinary);

      return;
    }

    await fs.writeFile(npmBinary,
      `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n`, { mode: 0o755 });
  };

  fixture.hooks.afterRun = createBin;
  fixture.prefix = prefix;
  fixture.npmBinary = npmBinary;
  fixture.npm = path.join(external, 'npm');
  fixture.binName = binName;
  fixture.packageId = packageId;

  return fixture;
}

/**
 * Подготовка — отдельный read-only маршрут: тело пусто, а ответ связывает
 * показанный prefix и файлы настройки с последующим стартом.
 */
export function prepare(app, id = 'claude', operation = 'update', headers) {
  return app.inject({
    method: 'POST',
    url: `/api/providers/${id}/${operation}/prepare`,
    payload: {},
    ...(headers ? { headers } : {}),
  });
}

/** Старт нового контракта передаёт ровно выданный непрозрачный token. */
/**
 * Старт нового контракта передаёт ровно выданный непрозрачный token.
 * Заголовки нужны только проверкам области авторизации.
 */
export function startWithToken(app, token, id = 'claude', operation = 'update', headers) {
  return app.inject({
    method: 'POST',
    url: `/api/providers/${id}/${operation}/start`,
    payload: { preparationToken: token },
    ...(headers ? { headers } : {}),
  });
}
