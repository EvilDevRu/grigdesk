import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginCatalogService } from '../../server/src/lib/pluginCatalog.ts';
import { installHttpFixture } from './helpers/pluginInstallHttpFixture.js';
import { catalogFixture } from '../helpers/pluginCatalog.js';

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
