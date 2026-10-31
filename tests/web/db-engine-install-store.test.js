import assert from 'node:assert/strict';

import { existsSync } from 'node:fs';

import test from 'node:test';

import { createPinia } from '../../web/node_modules/pinia/dist/pinia.mjs';

import { ApiError, failureText } from '../../web/src/shared/apiClient.ts';

import { compileModule, webFile } from './helpers/compile-vue.js';

import { webInstallJob, webInstallInfo } from './helpers/pluginInstallFixtures.js';

import { flushInstallRequests } from './helpers/pluginInstallStoreFixture.js';

const DRIVER = '/api/db/engine-installs';

const PLUGIN = '/api/plugin-installs';

/**
 * До появления preset исполняется существующий plugin wrapper: RED означает неверный URL.
 * После появления тест автоматически берёт driver wrapper и проверяет тот же публичный порт.
 */
async function stores(t) {
  const driverFile = webFile('src/stores/dbEngineInstall.ts');

  const fallback = webFile('src/stores/pluginInstall.ts');

  const calls = [];

  const storage = new Map();

  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');

  const fixture = {
    calls,
    handlers: new Map(),
    pluginRefresh: 0,
    dbRefresh: 0,
    failureText,
    /**
     * Ответы принадлежат синтетическому transport, а URL выбирает production store.
     * Запись вызова до ответа позволяет доказать отсутствие повторного POST.
     */
    async request(method, url, body) {
      calls.push({
        method,
        url,
        body: method === 'POST' ? structuredClone(body) : undefined
      });

      const handler = fixture.handlers.get(`${method} ${url}`);

      if (handler) {
        return handler(body);
      }

      if (method === 'GET' && url.endsWith('/jobs/current')) {
        return { job: null, recoveryError: null };
      }

      if (method === 'POST') {
        return { job: webInstallJob('running') };
      }

      return { job: webInstallJob('done'), recoveryError: null };
    },
  };

  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
  });

  globalThis.__driverStoreFixture = fixture;

  const refreshDb = 'export const loadDb = async () => { globalThis.__driverStoreFixture.dbRefresh++; };';

  const stubs = {
    '../shared/apiClient.ts': `
      export const failureText = (...args) => globalThis.__driverStoreFixture.failureText(...args);
      export const api = {
        get: (...args) => globalThis.__driverStoreFixture.request('GET', ...args),
        post: (...args) => globalThis.__driverStoreFixture.request('POST', ...args),
      };
    `,
    './plugins.ts': `export const usePluginsStore = () => ({
      load: async () => { globalThis.__driverStoreFixture.pluginRefresh++; },
    });`,
    '../actions/db': refreshDb,
    '../actions/db/index.ts': refreshDb,
    '../actions/db/loadDb.ts': refreshDb,
  };

  const driverModule = await compileModule(existsSync(driverFile) ? driverFile : fallback, { stubs });

  const pluginModule = await compileModule(fallback, { stubs });

  const pinia = createPinia();

  const makeDriver = driverModule.useDbEngineInstallStore ?? driverModule.usePluginInstallStore;

  const driver = makeDriver(pinia);

  const plugin = pluginModule.usePluginInstallStore(pinia);

  t.after(() => {
    driver.$dispose();

    plugin.$dispose();

    delete globalThis.__driverStoreFixture;

    if (previous) {
      Object.defineProperty(globalThis, 'sessionStorage', previous);
    }
    else {
      delete globalThis.sessionStorage;
    }
  });

  return {
    ...fixture,
    storage,
    driver,
    plugin,
    makeDriver,
    pinia,
    fixture
  };
}

test('DSTORE-01: plugin/driver имеют отдельные Pinia id, URL, timers и refresh', async (t) => {
  const state = await stores(t);

  t.mock.timers.enable({ apis: ['setTimeout'] });

  await state.driver.startInstall('https://example.invalid/driver.git', '1.0.0');

  await state.plugin.startInstall('https://example.invalid/plugin.git', '1.0.0');

  assert.notEqual(state.driver.$id, state.plugin.$id);

  assert.deepEqual(state.calls.filter((call) => call.method === 'POST').map((call) => call.url),
    [DRIVER + '/jobs', PLUGIN + '/jobs']);

  const done = webInstallJob('done');

  state.handlers.set('GET ' + DRIVER + '/jobs/current', () => ({ job: done, recoveryError: null }));

  await state.driver.loadJob();

  assert.equal(state.fixture.dbRefresh, 1);

  assert.equal(state.fixture.pluginRefresh, 0);

  state.driver.$dispose();

  const before = state.calls.length;

  t.mock.timers.tick(2000);

  await flushInstallRequests();

  assert.equal(state.calls.slice(before).some((call) => call.url.startsWith(DRIVER)), false);
});

test('DSTORE-01: lost apply читает исходный id без второго POST', async (t) => {
  const state = await stores(t);

  const job = webInstallJob();

  state.driver.job = job;

  state.handlers.set(`POST ${DRIVER}/jobs/${job.id}/apply`, () => {
    throw new TypeError('lost response');
  });

  state.handlers.set(`GET ${DRIVER}/jobs/${job.id}`, () => ({
    job: webInstallJob('done', job.kind, { id: job.id }),
    recoveryError: null
  }));

  await state.driver.apply();

  await state.driver.reconcile();

  assert.deepEqual(state.calls.filter((call) => call.method === 'POST').map((call) => call.url),
    [`${DRIVER}/jobs/${job.id}/apply`]);

  assert.ok(state.calls.some((call) => call.url === `${DRIVER}/jobs/${job.id}`));

  assert.equal(state.driver.job.status, 'done');
});

test('DSTORE-01: rollback reload повторяет тот же UUID/body в собственном storage namespace', async (t) => {
  const state = await stores(t);

  const subject = {
    id: 'demo',
    name: 'Драйвер',
    install: webInstallInfo()
  };

  const path = DRIVER + '/engines/demo/rollback';

  state.handlers.set('POST ' + path, () => {
    throw new TypeError('lost response');
  });

  await state.driver.rollback(subject);

  const original = state.calls.find((call) => call.url === path);

  assert.ok(original, 'rollback должен использовать driver endpoint');

  assert.ok(state.storage.size > 0);

  assert.equal(state.storage.has('grigdesk-plugin-install-rollback'), false);

  assert.equal(state.plugin.reconciling, false);

  state.driver.$dispose();

  const reopened = state.makeDriver(createPinia());

  t.after(() => reopened.$dispose());

  state.handlers.set('POST ' + path, () => ({ job: webInstallJob('done', 'rollback') }));

  await reopened.reconcile();

  const posted = state.calls.filter((call) => call.url === path);

  assert.equal(posted.length, 2);

  assert.deepEqual(posted[1].body, original.body);
});

for (const status of [401, 403]) {
  test(`DSTORE-01: ${status} останавливает poll без повторной мутации`, async (t) => {
    const state = await stores(t);

    t.mock.timers.enable({ apis: ['setTimeout'] });

    state.handlers.set('GET ' + DRIVER + '/jobs/current', () => {
      throw new ApiError('Требуется сессия', status, { error: 'session_required' });
    });

    await state.driver.loadJob();

    const before = state.calls.length;

    t.mock.timers.tick(10_000);

    await flushInstallRequests();

    assert.equal(state.calls.length, before);

    assert.ok(state.calls.some((call) => call.url === DRIVER + '/jobs/current'));
  });
}

test('DSTORE-01: поздний ответ после dispose не меняет проверенную карточку', async (t) => {
  const state = await stores(t);

  const held = Promise.withResolvers();

  const original = webInstallJob('ready');

  state.driver.job = original;

  state.handlers.set('GET ' + DRIVER + '/jobs/current', () => held.promise);

  const loading = state.driver.loadJob();

  try {
    assert.ok(state.calls.some((call) => call.url === DRIVER + '/jobs/current'));

    state.driver.$dispose();
  } finally {
    held.resolve({ job: webInstallJob('done'), recoveryError: null });

    await loading;
  }

  assert.equal(state.driver.job.id, original.id);

  assert.equal(state.driver.job.status, original.status);
});
