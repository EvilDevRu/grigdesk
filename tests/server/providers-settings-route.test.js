import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import providersModule from '../../server/src/modules/providers/index.ts';
import codex from '../../server/src/lib/executors/codex.ts';
import { PrefsStore } from '../../server/src/lib/prefsStore.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

function guardedAdapter() {
  return {
    id: 'future-provider',
    name: 'Future Provider',
    vendor: 'Test',
    color: '#123456',
    bin: () => '/bin/true',
    probe: async () => ({ ok: true, version: '1.0' }),
    auth: async () => ({ mode: 'cli', label: 'ok', available: true }),
    seedModels: () => [],
    run: async () => ({ reply: 'ok' }),
    sessionBinding: {
      authProfileId: () => 'future-auth',
      securityProfile: () => 'future-security',
    },
    statusPage: 'https://status.example.test',
    settings: [{
      id: 'blockDirectSsh',
      kind: 'toggle',
      label: 'Запретить прямой SSH',
      value: true,
      confirm: { off: { text: 'Прямой SSH останется без журнала.', danger: true } },
    }],
  };
}

// Локальный исполнитель страницы состояния не объявляет: его сбой на чужом сайте
// не виден, и подставлять туда адрес нельзя.
function localAdapter() {
  return {
    id: 'local-provider',
    name: 'Local Provider',
    vendor: 'Test',
    color: '#654321',
    bin: () => '/bin/true',
    probe: async () => ({ ok: true, version: '1.0' }),
    auth: async () => ({ mode: 'none', label: 'ok', available: true }),
    seedModels: () => [],
    run: async () => ({ reply: 'ok' }),
  };
}

// Исполнитель, у которого лимиты прямо сейчас не читаются: именно на его беде GrigDesk
// идёт на страницу состояния вендора.
function faultyAdapter() {
  return {
    ...localAdapter(),
    id: 'faulty-provider',
    name: 'Faulty Provider',
    statusPage: 'https://status.example.test',
    usage: async () => ({
      state: 'unavailable',
      message: 'Не удалось получить лимиты Faulty Provider. Повторим проверку автоматически.',
    }),
  };
}

async function routeFixture(t, extraAdapters = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-settings-route-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  let snapshot = {
    providerUsageAutoRefresh: true,
    providerSettings: {
      'future-provider': { blockDirectSsh: true },
      neighbor: { keep: 'me' },
    },
  };
  const writes = [];
  const prefs = {
    read: () => snapshot,
    write(patch) {
      writes.push(patch);
      snapshot = { ...snapshot, ...patch };
    },
    updateProviderSettings(mutator) {
      this.write({ providerSettings: mutator(structuredClone(snapshot.providerSettings)) });
    },
  };
  const adapters = [guardedAdapter(), ...extraAdapters];
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast() {} });
  await app.register(providersModule, {
    config: { modelsPath: path.join(root, 'models.json') },
    claudeAuth: null,
    prefs,
    getProviderAdapters: async () => new Map(adapters.map((item) => [item.id, item])),
    getModelsRegistry: async () => ({}),
  });
  t.after(() => app.close());
  return { app, writes, read: () => snapshot };
}

test('старый клиент не может снять запрет через существующий POST без confirmed', async (t) => {
  const fixture = await routeFixture(t);
  const response = await fixture.app.inject({
    method: 'POST',
    url: '/api/providers/future-provider/settings',
    payload: { settingId: 'blockDirectSsh', value: false },
  });

  assert.deepEqual({
    status: response.statusCode,
    error: response.json().error,
    writes: fixture.writes,
    prefs: fixture.read().providerSettings,
  }, {
    status: 400,
    error: 'confirmation_required',
    writes: [],
    prefs: {
      'future-provider': { blockDirectSsh: true },
      neighbor: { keep: 'me' },
    },
  });
});

test('подтверждённый POST пишет только namespace выбранного исполнителя', async (t) => {
  const fixture = await routeFixture(t);
  const response = await fixture.app.inject({
    method: 'POST',
    url: '/api/providers/future-provider/settings',
    payload: { settingId: 'blockDirectSsh', value: false, confirmed: true },
  });

  assert.deepEqual({
    status: response.statusCode,
    ok: response.json().ok,
    savedValue: response.json().settings?.find((setting) => (
      setting.id === 'blockDirectSsh'
    ))?.value,
    prefs: fixture.read().providerSettings,
  }, {
    status: 200,
    ok: true,
    savedValue: false,
    prefs: {
      'future-provider': { blockDirectSsh: false },
      neighbor: { keep: 'me' },
    },
  });
});

// Сбой вендора выглядел как поломка GrigDesk. Куда смотреть — знает только адаптер,
// поэтому адрес страницы состояния едет в реестр как есть, а Vue доменов не хранит.
test('реестр отдаёт объявленную адаптером страницу состояния и не выдумывает чужую', async (t) => {
  const fixture = await routeFixture(t, [localAdapter()]);
  const response = await fixture.app.inject({ method: 'GET', url: '/api/providers' });
  const byId = Object.fromEntries(response.json().providers
    .map((provider) => [provider.id, provider.statusPage]));

  assert.deepEqual(byId, {
    'future-provider': 'https://status.example.test',
    'local-provider': null,
  });
});

test('реестр отдаёт sessionBinding как capability, а не список известных id', async (t) => {
  const fixture = await routeFixture(t, [localAdapter()]);
  const response = await fixture.app.inject({ method: 'GET', url: '/api/providers' });
  const byId = Object.fromEntries(response.json().providers
    .map((provider) => [provider.id, provider.sessionBinding]));
  assert.deepEqual(byId, {
    'future-provider': true,
    'local-provider': false,
  });
});

// «Не удалось получить лимиты» не отвечало на главный вопрос — это у меня или у них.
// Ответ приносит сама страница состояния, и спрашивают её ТОЛЬКО у беды на стороне
// сервиса: у исполнителя без такой беды внешнего запроса быть не должно вовсе.
test('беда лимитов приносит прочитанное состояние вендора, а тишина — нет', async (t) => {
  const { app } = await routeFixture(t, [faultyAdapter()]);
  const requested = [];
  const realFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    requested.push(String(url));

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          status: { indicator: 'major', description: 'Partial System Outage' },
          components: [{ name: 'API', status: 'partial_outage' }],
          incidents: [{ name: 'Elevated error rates' }],
        };
      },
    };
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const response = await app.inject({ method: 'GET', url: '/api/providers/usage' });
  const { usage } = response.json();

  assert.equal(usage['faulty-provider'].vendorStatus.state, 'down');
  assert.equal(usage['faulty-provider'].vendorStatus.summary, 'Partial System Outage');
  assert.deepEqual(usage['faulty-provider'].vendorStatus.components, ['API']);
  assert.equal(usage['faulty-provider'].vendorStatus.url, 'https://status.example.test/');
  assert.equal(usage['future-provider'].vendorStatus, undefined,
    'исполнителю без беды лимитов страницу состояния не читают');
  assert.deepEqual(requested, ['https://status.example.test/api/v2/summary.json']);
});

/**
 * Настройку объявляет настоящий Codex; реальный PrefsStore пишет только во временный файл.
 * Повторное создание store отличает сохранение на диске от случайного состояния DTO или cache.
 */
async function codexSettingsFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-host-settings-'));
  const prefsPath = path.join(root, 'prefs.json');
  const prefs = new PrefsStore({ prefsPath });
  const adapter = {
    ...localAdapter(),
    id: 'codex',
    name: 'Codex',
    settings: codex.settings,
  };
  const app = Fastify({ logger: false });

  prefs.write({
    providerSettings: {
      codex: { blockDirectSsh: true },
      neighbor: { keep: 'me' },
    }
  });
  app.decorate('sse', { broadcast() { } });
  await app.register(providersModule, {
    config: { modelsPath: path.join(root, 'models.json') },
    claudeAuth: null,
    prefs,
    getProviderAdapters: async () => new Map([['codex', adapter]]),
    getModelsRegistry: async () => ({}),
  });
  t.after(async () => {
    await app.close();
    await fs.rm(root, {
      recursive: true,
      force: true,
    });
  });

  return {
    app,
    prefs,
    prefsPath,
  };
}

test('Codex Host: registry содержит один toggle, default off и confirm.on', async (t) => {
  const f = await codexSettingsFixture(t);
  const response = await f.app.inject({
    method: 'GET',
    url: '/api/providers',
  });
  const settings = response.json().providers.find((entry) => entry.id === 'codex')?.settings || [];
  const toggles = settings.filter((entry) => entry.id === 'allowHostAccess');

  assert.equal(toggles.length, 1, 'AC1: один объявленный тумблер Codex Host');
  assert.equal(toggles[0].kind, 'toggle');
  assert.equal(toggles[0].value, false);
  assert.ok(toggles[0].confirm?.on?.text);
  assert.equal(toggles[0].confirm?.off, undefined);
});

for (const confirmed of [undefined, false, 'true']) {
  test(`Codex Host: сервер отвергает включение без точного confirmed=true: ${confirmed}`, async (t) => {
    const f = await codexSettingsFixture(t);
    const before = await fs.readFile(f.prefsPath, 'utf8');
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/providers/codex/settings',
      payload: {
        settingId: 'allowHostAccess',
        value: true,
        confirmed,
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'confirmation_required');
    assert.equal(await fs.readFile(f.prefsPath, 'utf8'), before);
  });
}

test('Codex Host: confirmed сохраняется, новый PrefsStore читает его, Off не требует согласия', async (t) => {
  const f = await codexSettingsFixture(t);
  const enabled = await f.app.inject({
    method: 'POST',
    url: '/api/providers/codex/settings',
    payload: {
      settingId: 'allowHostAccess',
      value: true,
      confirmed: true,
    },
  });

  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.equal(enabled.json().settings.find((entry) => entry.id === 'allowHostAccess')?.value, true);

  const reopened = new PrefsStore({ prefsPath: f.prefsPath });

  assert.equal(reopened.read().providerSettings.codex.allowHostAccess, true);

  const registry = await f.app.inject({
    method: 'GET',
    url: '/api/providers',
  });

  assert.equal(registry.json().providers[0].settings.find((entry) => entry.id === 'allowHostAccess').value,
    true);

  const disabled = await f.app.inject({
    method: 'POST',
    url: '/api/providers/codex/settings',
    payload: {
      settingId: 'allowHostAccess',
      value: false,
    },
  });

  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.deepEqual(new PrefsStore({ prefsPath: f.prefsPath }).read().providerSettings, {
    codex: {
      blockDirectSsh: true,
      allowHostAccess: false,
    },
    neighbor: { keep: 'me' },
  });
});
