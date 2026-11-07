import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  hasStudioDevelopment, studioIntegrationTest, studioPluginFixture, studioProduct,
} from './helpers/studio3dPluginFixture.js';

const { parseStudio3d } = hasStudioDevelopment
  ? await studioProduct('shared/studio3d/studio3dContracts.ts') : {};
const fixture = studioPluginFixture;

/**
 * Все четыре прежних mixed cases исполняют настоящий external loader/auth/core.
 * Assertions сохранены; изменился только адрес fixture API и способ доступа к runtime.
 */
function integrationTest(name, callback) {
  return studioIntegrationTest(test, name, callback);
}

integrationTest('AP-15/18 настоящие prefs hooks откатывают prepare и коммитят новую библиотеку',
  async (t) => {
  const f = await fixture(t, { realPlugins: true, enabled: false });

  assert.equal((await f.plugin('POST', '/toggle', { enabled: true })).statusCode, 200);

  const before = (await f.call('GET', '/state')).json();
  const old = f.server.studio3d.context;

  assert.equal(before.library.ok, true);
  f.prefsStore.fail = true;

  const next = path.join(f.root, 'next');
  const failure = await f.plugin('PUT', '/settings', {
    values: {
      libraryDir: next,
      autoImport: false,
      lowDiskGb: 10
    },
  });

  assert.equal(failure.statusCode, 500);
  assert.equal(f.server.studio3d.context, old);
  assert.equal((await f.call('GET', '/state')).json().libraryId, before.libraryId);
  f.prefsStore.fail = false;

  assert.equal((await f.plugin('PUT', '/settings', {
    values: {
      libraryDir: next,
      autoImport: false,
      lowDiskGb: 10
    },
  })).statusCode, 200);
  assert.notEqual((await f.call('GET', '/state')).json().libraryId, before.libraryId);
  assert.equal((await f.plugin('PUT', '/settings', { values: { libraryDir: '/' } })).statusCode, 409);
  assert.equal(f.prefsStore.value.pluginSettings.studio3d.libraryDir, next);
  assert.equal((await f.plugin('POST', '/toggle', { enabled: false })).statusCode, 200);
  assert.equal((await f.call('GET', '/state')).statusCode, 404);
});


integrationTest('AP-01/14 все ручки закрыты без auth и при выключенном плагине', async (t) => {
  const f = await fixture(t, { enabled: false, realAuth: true });
  const routes = [
    ['GET', '/state'], ['GET', '/models'], ['GET', '/models/fixture'], ['POST', '/models'],
    ['PATCH', '/models/fixture'], ['DELETE', '/models/fixture'],
    ['DELETE', '/models/fixture/versions/v01-fixture'],
    ...['lighten', 'redownload', 'retry', 'preview', 'save']
      .map((action) => ['POST', `/models/fixture/versions/v01-fixture/${action}`]),
    ['POST', '/models/fixture/versions/from-file'], ['GET', '/files/fixture/v01-fixture/model.glb'],
    ...['offers', 'quote', 'run', 'batches/quote', 'batches/run', 'uploads', 'scan', 'viewer/resolve']
      .map((url) => ['POST', `/${url}`]),
    ['GET', '/jobs/fixture'], ['GET', '/tasks'], ['POST', '/tasks/tripo/fixture/import'],
    ['POST', '/jobs/fixture/children/fixture/reconcile'],
    ['POST', '/jobs/fixture/children/fixture/close-unknown'],
    ['GET', '/viewer/file/fixture/model.glb'],
  ];

  for (const [method, url] of routes) {
    const unauthorized = await f.call(method, url, undefined, null);

    assert.equal(unauthorized.statusCode, 401, `${method} ${url} auth`);
    assert.equal(unauthorized.json().error, 'unauthorized', `${method} ${url} настоящий authPlugin`);
    assert.equal(unauthorized.headers['cache-control'], 'no-store');
    assert.equal(unauthorized.json().needsSetup, undefined);
    assert.equal((await f.call(method, url)).statusCode, 404, `${method} ${url} disabled`);
  }

  assert.equal(f.fake.requests.length, 0);
  await assert.rejects(fs.stat(path.join(f.root, '3d')));
});


integrationTest('AP-12 production authPlugin закрывает studio3d, тестовая cookie даёт session', async (t) => {
  const f = await fixture(t, { realAuth: true });

  assert.equal((await f.call('GET', '/state', undefined, null)).statusCode, 401);

  const authorized = await f.call('GET', '/state', undefined, null,
    { cookie: 'grigdesk_sid=fixture-session' });

  assert.equal(authorized.statusCode, 200);
  assert.equal(parseStudio3d.state(authorized.json()).library.ok, true);
});


integrationTest('AP-14b настоящий authPlugin: закодированные платные ручки требуют сессию', async (t) => {
  const f = await fixture(t, { realAuth: true });
  const request = {
    libraryId: f.libraryId,
    idempotencyKey: crypto.randomUUID(),
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Фикстура' },
    expectedPrice: 30
  };
  const cli = { 'x-grigdesk-token': 'fixture-cli-token' };
  const routes = ['/ru%6E', '/batches/ru%6E', '/models/fixture/versions/v01-fixture/retr%79',
    '/jobs/fixture/children/fixture/reconcil%65', '/jobs/fixture/children/fixture/close-unknow%6E'];

  for (const route of routes) {
    const denied = await f.call('POST', route, request, null, cli);

    assert.equal(denied.statusCode, 403, route);
    assert.equal(denied.json().error, 'human_session_required', route);
  }

  for (const route of ['/run', '/batches/run']) {
    const allowed = await f.call('POST', route, request, null, { cookie: 'grigdesk_sid=fixture-session' });

    assert.notEqual(allowed.statusCode, 403, route);
    assert.notEqual(allowed.statusCode, 401, route);
  }
});

