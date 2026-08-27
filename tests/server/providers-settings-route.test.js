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
    settings: [{
      id: 'blockDirectSsh',
      kind: 'toggle',
      label: 'Запретить прямой SSH',
      value: true,
      confirm: { off: { text: 'Прямой SSH останется без журнала.', danger: true } },
    }],
  };
}

async function routeFixture(t) {
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
  const adapter = guardedAdapter();
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast() {} });
  await app.register(providersModule, {
    config: { modelsPath: path.join(root, 'models.json') },
    claudeAuth: null,
    prefs,
    getProviderAdapters: async () => new Map([[adapter.id, adapter]]),
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
