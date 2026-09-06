import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import providersModule from '../../server/src/modules/providers/index.js';

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

// Исполнитель, у которого лимиты прямо сейчас не читаются: именно на его беде кокпит
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
  };
  const adapters = [guardedAdapter(), ...extraAdapters];
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast() {} });
  await app.register(providersModule, {
    config: { modelsPath: path.join(root, 'models.json') },
    claudeAuth: null,
    prefs,
    getProviderAdapters: async () => new Map(adapters.map((item) => [item.id, item])),
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

// Сбой вендора выглядел как поломка кокпита. Куда смотреть — знает только адаптер,
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
