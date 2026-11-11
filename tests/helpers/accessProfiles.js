import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import deepseek, { createDeepSeekAdapter } from '../../server/src/lib/executors/deepseek.ts';
import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import providersModule from '../../server/src/modules/providers/index.ts';
import chatModule from '../../server/src/modules/chat/index.ts';
import authPlugin from '../../server/src/plugins/auth.ts';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireServer('fastify');
const execute = promisify(execFile);
const nativeFetch = globalThis.fetch;

export const OLD_KEY = 'synthetic-access-old-private-key';
export const NEW_KEY = 'synthetic-access-new-private-key';
export const CODING_KEY = 'synthetic-access-coding-private-key';
export const UNKNOWN_WARNING = 'Аккаунт не удалось определить; '
  + 'новый ключ может относиться к другому аккаунту';

/**
 * Создаёт независимый идентификатор мутации.
 * Повтор доставки в тесте сохраняет его явно, а новое действие получает новый.
 */
export function operationId() {
  return randomUUID();
}

/**
 * Создаёт управляемый барьер без задержки по времени.
 * Тест отпускает его после наблюдения фактического входа в проверяемую границу.
 */
export function deferred() {
  return Promise.withResolvers();
}

/**
 * Отдаёт реальную схему баланса DeepSeek без идентификатора аккаунта.
 * Одинаковый ответ для разных ключей не выдаётся за доказательство общей identity.
 */
export function balance(total = '1.96') {
  return {
    is_available: true,
    balance_infos: [{
      currency: 'USD',
      total_balance: total,
      granted_balance: '0.00',
      topped_up_balance: total,
    }],
  };
}

/**
 * Ограниченное ожидание асинхронного результата не повторяет мутацию.
 * Последнее наблюдение включается в ошибку без содержимого секретного ввода.
 */
export async function eventually(read, accept, label = 'ожидаемый результат') {
  for (let index = 0; index < 200; index += 1) {
    const value = await read();

    if (accept(value)) {
      return value;
    }

    await delay(10);
  }

  assert.fail(`Не получен ${label} за ограниченное время`);
}

/**
 * Настоящий HTTP-получатель записывает заголовки и тело запросов production-драйвера.
 * Подменяется только транспорт адреса; неизвестные API не получают фиктивный успех.
 */
export async function vendorServer(t) {
  const calls = [];
  const control = {
    status: 200,
    total: '1.96',
    customer: 'C-1',
    network: false,
    hold: null,
    answer: null,
  };
  const server = createServer(async (request, response) => {
    const chunks = [];

    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const call = {
      path: request.url,
      method: request.method,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString(),
    };

    calls.push(call);
    control.entered?.resolve(call);

    if (control.network) {
      request.socket.destroy();

      return;
    }

    const hold = control.hold;
    const status = control.status;
    const total = control.total;
    const customer = control.customers?.[call.authorization] ?? control.customer;
    const answer = control.answer;

    if (hold) {
      await hold.promise;
    }

    let payload;

    if (answer) {
      payload = await answer(call);
    } else if (request.url === '/user/balance') {
      payload = balance(total);
    } else if (request.url?.endsWith('/zaiUserInfo')) {
      payload = { code: 200, data: { customerNumber: customer } };
    } else if (request.url?.endsWith('/accountBalance')) {
      assert.equal(JSON.parse(call.body).customerId, customer);
      payload = { code: 200, data: { totalBalance: Number(total), accountList: [] } };
    } else if (request.url?.endsWith('/quota/limit')) {
      payload = { code: 200, data: { limits: [] } };
    } else if (request.url === '/capture') {
      payload = { ok: true };
    } else {
      response.writeHead(404).end('{}');

      return;
    }

    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = (url, init) => nativeFetch(`${origin}${new URL(url).pathname}`, init);

  t.after(() => {
    control.hold?.resolve();
    server.closeAllConnections();

    return new Promise((resolve) => server.close(resolve));
  });

  return {
    origin,
    calls,
    control,
    fetchImpl
  };
}

/**
 * Модельная граница действительно запускает ребёнка с переданным окружением.
 * Ни успешность профиля, ни снимок доступа не вычисляются тестовой подменой.
 * Новая native-сессия имеет уникальный ID и при независимых серверных процессах.
 */
async function captureRun(options, calls, control) {
  await control.beforeSpawn?.();

  const childCode = [
    'const names = ["DEEPSEEK_API_KEY", "ZAI_API_KEY", "ZAI_CODING_API_KEY",',
    '"GRIGDESK_GLM_API_MODE", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "KIMI_CODE_HOME"];',
    'console.log(JSON.stringify(Object.fromEntries(names.map(name => [name, process.env[name]]))));',
  ].join('\n');
  const { stdout } = await execute(process.execPath, ['-e', childCode], {
    env: options.env ?? {},
    cwd: options.cwd || os.tmpdir(),
  });
  const call = {
    env: JSON.parse(stdout),
    sessionId: options.sessionId,
    snapshot: options.accessSnapshot,
    workspaceAccess: options.workspaceAccess,
    images: options.images,
  };

  calls.push(call);
  control.entered?.resolve(call);

  if (control.hold) {
    await control.hold.promise;
  }

  if (control.error) {
    throw control.error;
  }

  const sessionId = options.sessionId || `access-session-${randomUUID()}`;

  await options.onSessionCreated?.(sessionId);

  return {
    reply: control.reply ?? 'Ответ фикстуры',
    sessionId,
    steps: []
  };
}

/**
 * Синтетический исполнитель наследует реальную capability API-доступа DeepSeek.
 * Неизвестный id не должен требовать добавления в список поставщиков ядра.
 */
export function syntheticAdapter(calls = [], control = {}) {
  return {
    ...deepseek,
    id: 'synthetic-access',
    name: 'Тестовый исполнитель',
    distribution: undefined,
    externalCli: undefined,
    nativeSettings: undefined,
    prepareRuntime: undefined,
    sessionBinding: {
      authProfileId: () => 'legacy-test-access',
      securityProfile: () => 'test-security',
    },
    bin: () => process.execPath,
    probe: async () => ({ ok: true, version: 'test-1' }),
    auth: async () => ({
      available: true,
      mode: 'env',
      label: 'Тестовый доступ'
    }),
    seedModels: () => [{ id: 'fixture-model', efforts: [] }],
    catalog: async () => [{ id: 'fixture-model', efforts: [] }],
    catalogCacheKey: () => 'test-catalog',
    usage: undefined,
    mcpStatus: undefined,
    commands: undefined,
    run: (options) => captureRun(options, calls, control),
    runUntrusted: (options) => captureRun(options, calls, control),
  };
}

/**
 * Вход через production-декоратор совпадает с границей реестра из S4.
 * На базе декоратора ещё нет: возвращается исходный адаптер, чтобы RED был поведенческим.
 */
export async function resolvedAdapter(fixture, id = 'synthetic-access') {
  let module;

  try {
    module = await import('../../server/src/lib/accessProfiles/adapter.ts');
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && String(error.url).endsWith('/accessProfiles/adapter.ts')) {
      return fixture.adapters.get(id);
    }

    throw error;
  }

  return module.accessProfileAdapter(fixture.adapters.get(id), {
    config: fixture.config,
    env: fixture.env,
    fetchImpl: fixture.vendor.fetchImpl,
    service: fixture.app.accessProfiles,
  });
}

/**
 * Вся конфигурация и старые ключи принадлежат временному каталогу одного теста.
 * Одинаковый env записывается в файл и передаётся серверу: источники ожидания совпадают.
 * Рабочая папка отделена от HOME: штатный guard чата запрещает весь домашний каталог.
 */
export async function profileFixture(t, options = {}) {
  let app;
  const root = options.root ?? await fs.mkdtemp(path.join(os.tmpdir(), 'access-profiles-'));
  const vendor = options.vendor ?? await vendorServer(t);
  const env = options.env ?? { DEEPSEEK_API_KEY: OLD_KEY };
  const previousFetch = globalThis.fetch;
  const privateHomes = {
    HOME: root,
    CODEX_HOME: env.CODEX_HOME ?? path.join(root, '.codex'),
    CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR ?? path.join(root, '.claude'),
    KIMI_CODE_HOME: env.KIMI_CODE_HOME ?? path.join(root, '.kimi'),
  };
  const previousHomes = new Map(Object.keys(privateHomes).map((key) => [key, process.env[key]]));

  Object.assign(process.env, privateHomes);
  globalThis.fetch = vendor.fetchImpl;
  t.after(() => {
    globalThis.fetch = previousFetch;

    for (const [key, value] of previousHomes) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  const calls = [];
  const control = {};
  const raw = options.adapters ?? [syntheticAdapter(calls, control)];
  const adapters = new Map(raw.map((adapter) => [adapter.id, adapter]));
  const events = [];
  const logs = [];
  const config = {
    rootDir: path.join(root, 'workspace'),
    dataHome: root,
    stateDir: path.join(root, 'state'),
    envPath: path.join(root, '.env'),
    modelsPath: path.join(root, 'models.json'),
    providerUsageSeenPath: path.join(root, 'usage-seen.json'),
    chatsDir: path.join(root, 'chats'),
    chatStoreLegacyPath: path.join(root, 'legacy.json'),
    chatBindingsDir: path.join(root, 'bindings'),
    deepseekRuntimeHome: path.join(root, 'deepseek'),
    glmRuntimeHome: path.join(root, 'glm'),
    factoryHome: root,
    profilesDir: path.join(root, 'projects'),
    analysisDir: path.join(root, 'analysis'),
    port: 18141,
    ...options.config,
  };

  await fs.mkdir(config.rootDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });

  if (!options.root) {
    const content = Object.entries(env).map(([key, value]) => `${key}=${value}\n`).join('');

    await fs.writeFile(config.envPath, content, {
      mode: 0o600,
    });
    t.after(async () => {
      await app?.close();
      await fs.rm(root, { recursive: true, force: true });
    });
  }

  let authorized = true;

  /**
   * Перезапуск меняет только экземпляр HTTP-приложения и его lifecycle.
   * Приватное состояние профилей остаётся в том же каталоге, как после рестарта сервера.
   */
  async function boot() {
    app = Fastify({ logger: false });
    app.decorate('sse', { broadcast: (name, payload) => events.push({ name, payload }) });

    if (options.auth) {
      await app.register(authPlugin, {
        authStore: {
          isConfigured: () => true,
          isValidSession: (id) => authorized && id === 'access-test-session',
        },
      });
    }

    await app.register(providersModule, {
      config,
      env,
      getProviderAdapters: async () => adapters,
      getModelsRegistry: options.modelsRegistry ?? (async () => ({})),
      accessProfiles: {
        fetchImpl: vendor.fetchImpl,
        now: options.now,
        fault: options.fault,
      },
    });
    await app.register(chatModule, {
      config,
      factoryState: { readEnv: async () => ({}) },
      prefs: { read: () => ({ providerSettings: {} }) },
      claudeAuth: null,
      internalToken: 'access-test-internal',
      modelsRegistry: async () => Object.fromEntries([...adapters.keys()].map((id) => [
        id, [{ id: 'fixture-model', efforts: [] }],
      ])),
      executorResolver: async (id) => resolvedAdapter({
        adapters,
        config,
        env,
        vendor,
        app,
      }, id),
    });

    if (options.factoryState) {
      const { default: factoryModule } = await import('../../server/src/modules/factory/index.ts');

      await app.register(factoryModule, {
        config,
        factoryState: options.factoryState,
        accessProfiles: app.accessProfiles,
        prefs: { read: () => ({}) },
        tracker: null,
        analyzer: {
          get: async () => null,
          readClarifications: async () => null,
          readOpenQuestions: async () => null,
        },
      });
    }

    await app.ready();
  }

  await boot();
  t.after(() => app.close());

  const fixture = {
    root,
    config,
    env,
    adapters,
    calls,
    control,
    vendor,
    events,
    logs,
    get app() {
      return app;
    },
    revoke() {
      authorized = false;
    },
    async restart() {
      await app.close();
      await boot();
    },
    async request(method, url, payload, status = 200, authenticated = true) {
      const response = await app.inject({
        method,
        url,
        payload,
        headers: options.auth && authenticated ? { cookie: 'grigdesk_sid=access-test-session' } : {},
      });

      assert.equal(response.statusCode, status, `${method} ${url}: ${response.body}`);

      return response.json();
    },
  };

  return fixture;
}

/**
 * Задаёт общий namespace HTTP-контракта профилей исполнителя.
 * Идентификаторы попыток и операций добавляются к нему серверными маршрутами.
 */
export function base(provider = 'synthetic-access') {
  return `/api/providers/${provider}/access-profiles`;
}

/**
 * Первый assert проверяет существование поведения, а не нового импортируемого файла.
 * На исходной реализации каждый профильный сценарий останавливается на HTTP 404.
 */
export async function profiles(fixture, provider = 'synthetic-access') {
  const result = await fixture.request('GET', base(provider));

  assert.ok(Array.isArray(result.profiles), 'API возвращает список сохранённых профилей');

  return result;
}

/**
 * Находит активное подключение только по серверному activeProfileId.
 * Отсутствие прежнего рабочего профиля считается потерей доступа, а не пустым списком.
 */
export function active(list) {
  const profile = list.profiles.find((item) => item.id === list.activeProfileId);

  assert.ok(profile, 'прежнее подключение остаётся активным');

  return profile;
}

/**
 * Способ и имя секретного поля берутся из объявления того же адаптера.
 * Тест не закрепляет чужое имя поля вместо фактически читаемой настройки.
 */
export function apiMethod(list, mode) {
  const method = list.methods.find((item) => item.kind === 'api-key' && (!mode || item.mode === mode));

  assert.ok(method, `Адаптер объявил способ API ${mode ?? ''}`);

  return method;
}

/**
 * Каждое действие получает независимый operationId; повтор тест передаёт явно.
 * Секрет вводится в текущий серверный шаг, а не в профильный DTO.
 */
export async function createAttempt(fixture, provider, method, extra = {}) {
  return fixture.request('POST', `${base(provider)}/attempts`, {
    operationId: operationId(),
    name: 'Второе подключение',
    methodId: method.id,
    ...extra,
  });
}

/**
 * Передаёт ввод текущему серверному шагу с CAS и operationId.
 * Повторы в сценариях используют тот же идентификатор, а старые шаги ожидают отказ.
 */
export async function submit(fixture, provider, attempt, input, op = operationId(), status = 200) {
  return fixture.request('POST', `${base(provider)}/attempts/${attempt.id}/steps/${attempt.step.id}`, {
    operationId: op,
    expectedRevision: attempt.revision,
    input,
  }, status);
}

/**
 * Опрашиваются только безопасные чтения текущей попытки.
 * Исходящий POST никогда не повторяется при ожидании верификации поставщика.
 */
export async function settled(fixture, provider, attempt, kinds = ['result', 'choice']) {
  return eventually(
    () => fixture.request('GET', `${base(provider)}/attempts/${attempt.id}`),
    (value) => kinds.includes(value.step?.kind) || ['saved', 'failed', 'cancelled'].includes(value.state),
    'завершение проверки доступа',
  );
}

/**
 * Добавление готового профиля проходит тот же API и production-verifier, что мастер.
 * Функция не активирует профиль: это самостоятельное проверяемое действие.
 */
export async function addProfile(fixture, provider = 'synthetic-access', key = NEW_KEY, mode) {
  const list = await profiles(fixture, provider);
  const method = apiMethod(list, mode);
  const attempt = await createAttempt(fixture, provider, method);
  const field = method.fields.find((item) => item.kind === 'secret');

  assert.ok(field, 'объявлено секретное поле API');
  await submit(fixture, provider, attempt, { [field.id]: key });

  const result = await settled(fixture, provider, attempt);

  assert.equal(result.state, 'saved', 'успех означает подтверждённое сохранение');

  const after = await profiles(fixture, provider);
  const profile = after.profiles.find((item) => !list.profiles.some((old) => old.id === item.id));

  assert.ok(profile, 'сохранён отдельный профиль');
  assert.equal(after.activeProfileId, list.activeProfileId, 'добавление не активирует доступ');

  return profile;
}

/**
 * Включает сохранённый профиль отдельной HTTP-операцией.
 * Ревизия списка читается перед действием, устаревший снимок задаётся тестом явно.
 */
export async function activate(fixture, profile, provider = 'synthetic-access', extra = {}, status = 200) {
  const list = await profiles(fixture, provider);

  return fixture.request('POST', `${base(provider)}/${profile.id}/activate`, {
    operationId: operationId(),
    expectedRevision: list.revision,
    ...extra,
  }, status);
}

/**
 * История и ход проходят настоящие HTTP-entrypoints чата с проверяемой моделью.
 * Передаваемые пользователем profileId/env остаются недоверенными полями запроса.
 */
export async function saveChat(fixture, provider = 'synthetic-access', id = 'access-chat') {
  return fixture.request('PUT', '/api/chat/store/chat', {
    chat: {
      id,
      revision: 0,
      modelRef: { provider, model: 'fixture-model' },
      messages: [{
        role: 'user',
        text: 'Сохранённая история',
        at: 1
      }],
    },
  });
}

/**
 * Запускает настоящий HTTP-ход сохранённого чата.
 * Дополнительные поля проверяют, что пользователь не выбирает произвольный доступ.
 */
export async function runChat(fixture, extra = {}, status = 200) {
  return fixture.request('POST', '/api/chat', {
    chatKey: 'access-chat',
    modelRef: { provider: 'synthetic-access', model: 'fixture-model' },
    message: 'Проверочный ход',
    ...extra,
  }, status);
}

/**
 * Отдельный серверный процесс читает тот же приватный каталог, но не память родителя.
 * IPC служит только барьером запуска; доступ выбирает production-код внутри worker.
 */
export async function serverWorker(t, fixture) {
  const child = fork(new URL('../fixtures/access-profiles/server-worker.mjs', import.meta.url), [], {
    env: {
      PATH: process.env.PATH,
      HOME: fixture.root,
      GRIGDESK_HOME: fixture.root
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const stderr = [];

  child.stderr.on('data', (data) => stderr.push(String(data)));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  });

  const pending = new Map();

  child.on('message', (message) => pending.get(message.id)?.resolve(message));
  child.on('exit', () => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`Серверный worker завершился: ${stderr.join('')}`));
    }
  });

  return async (command, payload = {}) => {
    const id = operationId();
    const waiter = deferred();

    pending.set(id, waiter);
    child.send({
      id,
      command,
      root: fixture.root,
      env: fixture.env,
      vendorOrigin: fixture.vendor.origin,
      config: fixture.config,
      ...payload,
    });

    try {
      return await Promise.race([
        waiter.promise,
        delay(command.startsWith('factory-') ? 15000 : 5000, undefined, { ref: false }).then(() => {
          throw new Error('IPC worker не ответил за ограниченное время');
        }),
      ]);
    } finally {
      pending.delete(id);
    }
  };
}

/**
 * Собирает настоящие API-адаптеры с подменой только HTTP-транспорта.
 * GLM получает тот же env, из которого тест ожидает режим и выбранный ключ.
 */
export function apiAdapters(env, vendor) {
  return [createDeepSeekAdapter({ usageFetch: vendor.fetchImpl }), createGlmAdapter({
    env,
    admission: [],
    usageFetch: vendor.fetchImpl
  })];
}
