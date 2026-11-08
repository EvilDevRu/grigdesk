import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import deepseek from '../../server/src/lib/executors/deepseek.ts';
import { PrefsStore } from '../../server/src/lib/prefsStore.ts';
import providersModule from '../../server/src/modules/providers/index.ts';
import authPlugin, { SESSION_COOKIE } from '../../server/src/plugins/auth.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const SESSION = 'mcp-fixture-session';
const EMPTY_TEXT = 'Для папки GrigDesk нет MCP-серверов, выбранных для запуска.';

/**
 * Копия настоящего адаптера сохраняет его mcpStatus и объявление capability.
 * Исполняемые внешние границы подменены до регистрации Fastify-модуля.
 */
function deepSeekFixture() {
  const provider = {
    ...deepseek,
    bin: (config) => config.deepseekBin,
    probe: async () => ({ ok: true, version: '0.1.5-fixture' }),
    auth: async () => ({
      mode: 'env',
      label: 'Ключ не задан',
      available: false,
    }),
    modes: async () => [],
    scopedWorkspace: async () => false,
    settings: [],
    usage: async () => ({ state: 'unsupported', bars: [] }),
    catalog: async () => [],
    catalogCacheKey: () => 'fixture-catalog',
    seedModels: () => [],
    run: async () => {
      throw new Error('Чатовый запуск запрещён в MCP-стенде');
    },
  };

  delete provider.latestVersion;
  delete provider.updateCmd;
  delete provider.statusPage;

  return provider;
}

/**
 * Синтетического id нет в живом реестре, поэтому обход adaptersOf даёт явный отказ.
 * Этот spy проверяет ленивость и изоляцию отдельно от настоящего DeepSeek-метода.
 */
function genericFixture() {
  let mcpReads = 0;

  return {
    id: 'mcp-fixture',
    name: 'Тестовый исполнитель',
    bin: () => 'fixture-cli',
    probe: async () => ({ ok: true, version: '1.0.0' }),
    auth: async () => ({
      mode: 'fixture',
      label: 'Тестовый вход',
      available: false,
    }),
    settings: [],
    mcpStatus: async () => {
      mcpReads += 1;

      return {
        state: 'ok',
        note: 'Тестовый ответ',
        servers: [],
      };
    },
    mcpReads: () => mcpReads,
  };
}

/**
 * Стенд изолирует адаптеры, модели, prefs, auth и файловые пути.
 * Закрытие приложения с таймерами предшествует удалению собственных файлов.
 */
async function routeFixture(t, { provider = deepSeekFixture(), auth = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'providers-mcp-fixture-'));
  const app = Fastify({ logger: false });
  const marker = path.join(root, 'cli-started');

  t.after(async () => {
    try {
      await app.close();
      assert.equal((await fs.readdir(root)).includes('cli-started'), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  const config = {
    rootDir: root,
    modelsPath: path.join(root, 'models.json'),
    providerUsageSeenPath: path.join(root, 'usage-seen.json'),
    deepseekBin: path.join(root, 'fixture-cli'),
    deepseekRuntimeHome: path.join(root, 'runtime'),
  };

  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(config.deepseekBin, `#!/bin/sh\nprintf started > '${marker}'\nexit 0\n`, {
    mode: 0o755,
  });

  const prefs = new PrefsStore({ prefsPath: path.join(root, 'prefs.json') });
  const calls = { adapters: 0, models: [] };

  if (auth) {
    await app.register(authPlugin, {
      authStore: {
        isConfigured: () => true,
        isValidSession: (id) => id === SESSION,
      },
    });
  }

  await app.register(providersModule, {
    config,
    prefs,
    getProviderAdapters: async () => {
      calls.adapters += 1;

      return new Map([[provider.id, provider]]);
    },
    getModelsRegistry: async (input, options) => {
      calls.models.push({ input, options });

      return { [provider.id]: [] };
    },
  });

  return {
    app,
    root,
    config,
    provider,
    calls,
  };
}

async function writeServers(fixture, servers) {
  await fs.writeFile(path.join(fixture.root, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
}

test('MCP GET использует подменённый адаптер с синтетическим id', async (t) => {
  const provider = genericFixture();
  const { app, calls } = await routeFixture(t, { provider });
  const response = await app.inject('/api/providers/mcp-fixture/mcp');

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().note, 'Тестовый ответ');
  assert.equal(provider.mcpReads(), 1);
  assert.equal(calls.adapters, 1);
  assert.equal(calls.models.length, 0);
});

test('реестр объявляет MCP настоящего DeepSeek без модельного входа с fixture-моделями', async (t) => {
  const fixture = await routeFixture(t);
  const response = await fixture.app.inject('/api/providers');

  assert.equal(response.statusCode, 200);

  const [provider] = response.json().providers;

  assert.equal(provider.id, 'deepseek');
  assert.equal(provider.installed, true);
  assert.equal(provider.available, false);
  assert.equal(provider.mcp, true);
  assert.deepEqual(provider.models, []);
  assert.equal(fixture.calls.models.length, 1);
  assert.equal(fixture.calls.models[0].input, fixture.config);

  const refreshed = await fixture.app.inject('/api/providers?refresh=1');

  assert.equal(refreshed.statusCode, 200);
  assert.deepEqual(fixture.calls.models.map((call) => call.options), [
    undefined,
    { refresh: true },
    undefined,
  ]);
});

test('настоящий mcpStatus DeepSeek возвращает configured, пояснения и метку API', async (t) => {
  const fixture = await routeFixture(t);

  await writeServers(fixture, { Документы: { command: fixture.config.deepseekBin } });

  const response = await fixture.app.inject('/api/providers/deepseek/mcp');

  assert.equal(response.statusCode, 200);

  const data = response.json();

  assert.equal(data.state, 'ok');
  assert.deepEqual(data.servers, [{
    name: 'Документы',
    target: '',
    scope: 'project',
    state: 'configured',
    detail: '',
  }]);
  assert.match(data.note, /для папки GrigDesk/);
  assert.match(data.note, /Соединение не проверялось/);
  assert.equal(data.emptyText, EMPTY_TEXT);
  assert.equal(typeof data.checkedAt, 'number');
  assert.equal(fixture.calls.models.length, 0);
});

test('общий реестр ленив: MCP читается только отдельным GET', async (t) => {
  const provider = genericFixture();
  const { app } = await routeFixture(t, { provider });
  const registry = await app.inject('/api/providers');

  assert.equal(registry.statusCode, 200);
  assert.equal(registry.json().providers[0].mcp, true);
  assert.equal(provider.mcpReads(), 0);

  const mcp = await app.inject('/api/providers/mcp-fixture/mcp');

  assert.equal(mcp.statusCode, 200);
  assert.equal(provider.mcpReads(), 1);
});

test('ручная проверка версий использует только подменённый адаптер', async (t) => {
  const provider = genericFixture();
  let versionReads = 0;

  provider.latestVersion = async () => {
    versionReads += 1;

    return '1.0.0';
  };

  const { app, calls } = await routeFixture(t, { provider });
  const response = await app.inject({ method: 'POST', url: '/api/providers/check-updates' });

  assert.equal(response.statusCode, 200);
  assert.equal(versionReads, 1);
  assert.equal(calls.adapters, 1);
  assert.equal(response.json().updates[0].id, provider.id);
  assert.equal(response.json().updates[0].latest, '1.0.0');
  assert.equal(calls.models.length, 0);
});

test('MCP-кэш сохраняет A до refresh и затем отдаёт B', async (t) => {
  const fixture = await routeFixture(t);
  const url = '/api/providers/deepseek/mcp';
  const entry = { command: fixture.config.deepseekBin };

  await writeServers(fixture, { A: entry });

  const first = (await fixture.app.inject(url)).json();

  assert.deepEqual(first.servers.map((server) => server.name), ['A']);
  assert.equal(Boolean(first.cached), false);

  await writeServers(fixture, { B: entry });

  const cached = (await fixture.app.inject(url)).json();

  assert.deepEqual(cached.servers.map((server) => server.name), ['A']);
  assert.equal(cached.cached, true);
  assert.equal(cached.checkedAt, first.checkedAt);

  const refreshed = (await fixture.app.inject(`${url}?refresh=1`)).json();
  const next = (await fixture.app.inject(url)).json();

  assert.deepEqual(refreshed.servers.map((server) => server.name), ['B']);
  assert.equal(Boolean(refreshed.cached), false);
  assert.deepEqual(next.servers.map((server) => server.name), ['B']);
  assert.equal(next.cached, true);
});

test('ошибка JSON безопасна в HTTP и снимается через refresh исправленного файла', async (t) => {
  const fixture = await routeFixture(t);
  const file = path.join(fixture.root, '.mcp.json');
  const url = '/api/providers/deepseek/mcp';

  await fs.writeFile(file, '{"secret":"json-canary" broken');

  const response = await fixture.app.inject(url);
  const data = response.json();

  assert.equal(response.statusCode, 200);
  assert.equal(data.state, 'error');
  assert.deepEqual(data.servers, []);
  assert.match(data.error, /для папки GrigDesk/);
  assert.equal(response.body.includes('json-canary'), false);
  assert.equal(response.body.includes(fixture.root), false);

  await writeServers(fixture, { Документы: { command: fixture.config.deepseekBin } });

  assert.equal((await fixture.app.inject(url)).json().state, 'error');

  const fixed = (await fixture.app.inject(`${url}?refresh=1`)).json();

  assert.equal(fixed.state, 'ok');
  assert.deepEqual(fixed.servers.map((server) => server.name), ['Документы']);
});

test('частичный MCP-ответ сохраняет карточки без env, args, warnings и служебных данных', async (t) => {
  const fixture = await routeFixture(t);
  const entry = {
    command: fixture.config.deepseekBin,
    args: ['args-canary'],
    env: { TOKEN: 'env-canary' },
  };

  await writeServers(fixture, {
    Документы: entry,
    missing: { command: path.join(fixture.root, 'command-canary') },
    'grigdesk-work': entry,
    'grigdesk-perm': entry,
  });

  const response = await fixture.app.inject('/api/providers/deepseek/mcp');
  const data = response.json();

  assert.equal(response.statusCode, 200);
  assert.equal(data.state, 'ok');
  assert.deepEqual(data.servers.map((server) => server.name), ['Документы']);
  assert.match(data.note, /прочитана или проверена не полностью/);
  assert.equal(response.body.includes('canary'), false);
  assert.equal(response.body.includes(fixture.root), false);
  assert.equal(response.body.includes('grigdesk-'), false);
  assert.equal(Object.hasOwn(data, 'warnings'), false);
  assert.equal(Object.hasOwn(data, 'file'), false);
});

test('MCP GET различает неизвестного исполнителя и отсутствие метода', async (t) => {
  const provider = genericFixture();

  delete provider.mcpStatus;

  const { app } = await routeFixture(t, { provider });
  const unknown = await app.inject('/api/providers/unknown-fixture/mcp');
  const unsupported = await app.inject('/api/providers/mcp-fixture/mcp');

  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().error, 'unknown_provider');
  assert.equal(unsupported.statusCode, 400);
  assert.equal(unsupported.json().error, 'no_mcp');
});

test('auth закрывает реестр и MCP до adapters/models/reader, fixture-cookie даёт доступ', async (t) => {
  const provider = genericFixture();
  const { app, calls } = await routeFixture(t, { provider, auth: true });
  const urls = ['/api/providers', '/api/providers/mcp-fixture/mcp'];

  for (const url of urls) {
    for (const cookie of ['', `${SESSION_COOKIE}=invalid-fixture-session`]) {
      const response = await app.inject({ url, headers: { cookie } });

      assert.equal(response.statusCode, 401);
    }
  }

  assert.equal(calls.adapters, 0);
  assert.equal(calls.models.length, 0);
  assert.equal(provider.mcpReads(), 0);

  for (const url of urls) {
    const response = await app.inject({ url, headers: { cookie: `${SESSION_COOKIE}=${SESSION}` } });

    assert.equal(response.statusCode, 200);
  }

  assert.equal(calls.adapters, 2);
  assert.equal(calls.models.length, 1);
  assert.equal(provider.mcpReads(), 1);
});
