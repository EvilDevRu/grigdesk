import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginCatalogService } from '../../server/src/lib/pluginCatalog.ts';
import { installHttpFixture } from './helpers/pluginInstallHttpFixture.js';
import { catalogFixture } from '../helpers/pluginCatalog.js';
import { moduleCatalogFixture } from '../helpers/pluginCatalogModules.js';
import { decodeCatalogResponse, decodeCatalogDetail } from '../helpers/pluginCatalogV1.mts';

test('CAT-R1: auth до сети, same-origin API, строгие query, детали и 404', async (t) => {
  const data = catalogFixture();
  const calls = [];
  const catalog = new PluginCatalogService({
    urls: ['https://catalog.example.invalid/api/plugins/v1/index.json'],
    applicationVersion: '1.0.0',
    fetch: async (input) => {
      calls.push(String(input));

      return new Response(JSON.stringify(String(input).endsWith('index.json') ? data.index : data.detail), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  t.after(() => catalog.close());


  const fixture = await installHttpFixture(t, { catalog });

  assert.equal((await fixture.app.inject('/api/plugin-catalog')).statusCode, 401);
  assert.equal((await fixture.app.inject('/api/plugin-catalog/demo')).statusCode, 401);
  assert.equal(calls.length, 0);

  for (const headers of [fixture.session, fixture.cli, fixture.internal]) {
    const response = await fixture.app.inject({ url: '/api/plugin-catalog', headers });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().state, 'fresh');
  }

  for (const address of ['/api/plugin-catalog?url=https://foreign.invalid',
    '/api/plugin-catalog?refresh=true']) {
    assert.equal((await fixture.app.inject({ url: address, headers: fixture.session })).statusCode, 400);
  }

  const detail = await fixture.app.inject({ url: '/api/plugin-catalog/demo', headers: fixture.session });

  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().plugin.id, 'demo');
  assert.equal((await fixture.app.inject({
    url: '/api/plugin-catalog/missing', headers: fixture.session,
  })).statusCode, 404);
  assert.equal(calls.some((value) => value.includes('foreign.invalid')), false);
});


test('CAT-R2-API-NEGOTIATION: modern и legacy маршруты сохраняют auth и строгие query', async (t) => {
  const data = moduleCatalogFixture();
  const calls = [];
  const catalog = new PluginCatalogService({
    urls: ['https://catalog.test/api/plugins/v1/index.json'],
    applicationVersion: '1.0.0',
    fetch: async (input) => {
      const url = String(input);
      const channel = url.includes('/v2/') ? data.modern : data.legacy;

      calls.push(url);

      return Response.json(url.endsWith('index.json') ? channel.index : channel.detail);
    },
  });

  t.after(() => catalog.close());

  const fixture = await installHttpFixture(t, { catalog });

  for (const url of ['/api/plugin-catalog?api=2', '/api/plugin-catalog/demo?api=2']) {
    assert.equal((await fixture.app.inject(url)).statusCode, 401);
  }

  assert.deepEqual(calls, []);

  for (const headers of [fixture.session, fixture.cli, fixture.internal]) {
    const index = await fixture.app.inject({ url: '/api/plugin-catalog?api=2', headers });
    const detail = await fixture.app.inject({ url: '/api/plugin-catalog/demo?api=2', headers });

    assert.equal(index.statusCode, 200);
    assert.equal(detail.statusCode, 200);
    assert.deepEqual(index.json().catalog, data.modern.index);
    assert.deepEqual(detail.json(), data.modern.detail);
  }

  const legacyIndex = await fixture.app.inject({ url: '/api/plugin-catalog', headers: fixture.session });
  const legacyDetail = await fixture.app.inject({
    url: '/api/plugin-catalog/demo', headers: fixture.session,
  });

  assert.equal(legacyIndex.statusCode, 200);
  assert.equal(legacyDetail.statusCode, 200);
  assert.deepEqual(decodeCatalogResponse(legacyIndex.json()).catalog, data.legacy.index);
  assert.deepEqual(decodeCatalogDetail(legacyDetail.json()), data.legacy.detail);

  for (const root of ['/api/plugin-catalog', '/api/plugin-catalog/demo']) {
    for (const query of ['api=1', 'api=3', 'api=x', 'api=2&foreign=1']) {
      const response = await fixture.app.inject({ url: `${root}?${query}`, headers: fixture.session });

      assert.equal(response.statusCode, 400, `${root}?${query}`);
    }
  }
});
