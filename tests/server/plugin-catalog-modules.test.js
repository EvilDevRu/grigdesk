import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginCatalogService } from '../../server/src/lib/pluginCatalog.ts';
import { moduleCatalogFixture } from '../helpers/pluginCatalogModules.js';

const primary = 'https://a.test/api/plugins/v1/index.json';
const secondary = 'https://b.test/api/plugins/v1/index.json';

test('CAT-MIXED-SOURCE: единый v1 читает api1/2 и кеширует индекс и карточку', async (t) => {
  const data = moduleCatalogFixture();
  const calls = [];
  const service = new PluginCatalogService({
    urls: [primary, secondary],
    applicationVersion: '1.0.0',
    fetch: async (input) => {
      const url = String(input);

      calls.push(url);

      return Response.json(url.endsWith('index.json') ? data.index : data.detail);
    },
  });

  t.after(() => service.close());
  assert.deepEqual((await service.index()).catalog, data.index);
  assert.deepEqual(await service.detail('demo'), data.detail);
  assert.deepEqual((await service.index()).catalog, data.index);
  assert.deepEqual(await service.detail('demo'), data.detail);
  assert.deepEqual(calls, [primary, primary.replace('index.json', 'demo.json')]);
  await service.index(true);
  assert.deepEqual(await service.detail('demo'), data.detail);
  assert.equal(calls.length, 4, 'обновление индекса сбрасывает кеш карточки');
});

for (const matches of [true, false]) {
  test(`CAT-MIXED-SNAPSHOT: зеркало сверяет весь снимок api1/2, совпадение=${matches}`, async (t) => {
    const data = moduleCatalogFixture();
    const other = structuredClone(data.index);
    const calls = [];

    if (!matches) {
      other.generatedAt = '2026-10-22T11:00:00.000Z';
    }

    const service = new PluginCatalogService({
      urls: [primary, secondary],
      applicationVersion: '1.0.0',
      fetch: async (input) => {
        const url = String(input);

        calls.push(url);

        if (url === primary) {
          return Response.json(data.index);
        }

        if (url === secondary) {
          return Response.json(other);
        }

        return url === secondary.replace('index.json', 'demo.json')
          ? Response.json(data.detail) : new Response(null, { status: 503 });
      },
    });

    t.after(() => service.close());
    assert.deepEqual((await service.index()).catalog, data.index);

    if (matches) {
      assert.deepEqual(await service.detail('demo'), data.detail);
    } else {
      await assert.rejects(service.detail('demo'), { statusCode: 409 });
    }

    assert.deepEqual((await service.index()).catalog, data.index);
    assert.equal(calls.includes(secondary.replace('index.json', 'demo.json')), matches);
  });
}
