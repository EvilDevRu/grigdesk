import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeCatalogIndex, decodeCatalogDetail, decodeCatalogResponse,
} from '../helpers/pluginCatalogV1.mts';
import { catalogFixture } from '../helpers/pluginCatalog.js';
import { PluginCatalogService } from '../../server/src/lib/pluginCatalog.ts';
import { installHttpFixture } from './helpers/pluginInstallHttpFixture.js';

test('CAT-LEGACY-BASE: прежний reader и HTTP без api читают только api1', async (t) => {
  const data = catalogFixture();
  const response = {
    state: 'fresh',
    applicationVersion: '1.0.0',
    fetchedAt: data.index.generatedAt,
    catalog: data.index,
  };

  assert.deepEqual(decodeCatalogIndex(data.index), data.index);
  assert.deepEqual(decodeCatalogDetail(data.detail), data.detail);
  assert.deepEqual(decodeCatalogResponse(response), response);

  const modern = structuredClone(data);

  modern.index.plugins[0].latest.api = 2;
  modern.detail.plugin.versions[0].api = 2;
  assert.throws(() => decodeCatalogIndex(modern.index), /Каталог/u);
  assert.throws(() => decodeCatalogDetail(modern.detail), /Каталог/u);
  assert.throws(() => decodeCatalogResponse({ ...response, catalog: modern.index }), /Каталог/u);

  const calls = [];
  const catalog = new PluginCatalogService({
    urls: ['https://catalog.test/api/plugins/v1/index.json'],
    applicationVersion: '1.0.0',
    fetch: async (url) => {
      calls.push(String(url));

      return Response.json(String(url).endsWith('index.json') ? data.index : data.detail);
    },
  });

  t.after(() => catalog.close());

  const fixture = await installHttpFixture(t, { catalog });
  const index = await fixture.app.inject({ url: '/api/plugin-catalog', headers: fixture.session });
  const detail = await fixture.app.inject({ url: '/api/plugin-catalog/demo', headers: fixture.session });

  assert.equal(index.statusCode, 200);
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(decodeCatalogResponse(index.json()).catalog, data.index);
  assert.deepEqual(decodeCatalogDetail(detail.json()), data.detail);
  assert.ok(calls.every((url) => url.includes('/v1/')));
});
