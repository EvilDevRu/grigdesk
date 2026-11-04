import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginCatalogService } from '../../server/src/lib/pluginCatalog.ts';
import { catalogFixture } from '../helpers/pluginCatalog.js';
import { moduleCatalogFixture } from '../helpers/pluginCatalogModules.js';

const primary = 'https://grigdesk.com/api/plugins/v1/index.json';
const secondary = 'https://grigdesk.ru/api/plugins/v1/index.json';
const local = 'http://127.0.0.1:4174/api/plugins/v1/index.json';

for (const api of [1, 2]) {
  test(`CAT-LOCAL: плагины api${api} читаются из локального v1 после публичных источников`, async (t) => {
    const data = api === 2 ? moduleCatalogFixture() : catalogFixture();
    const calls = [];
    let primaryOnline = false;
    const service = new PluginCatalogService({
      applicationVersion: '1.0.0',
      fetch: async (input, options) => {
        const address = String(input);

        calls.push(address);
        assert.equal(options.redirect, 'error');
        assert.equal(options.credentials, 'omit');

        if ((primaryOnline && address === primary) || address === local) {
          return Response.json(data.index);
        }

        if (address === local.replace('index.json', 'demo.json')) {
          return Response.json(data.detail);
        }

        return new Response(null, { status: 503 });
      },
    });

    t.after(() => service.close());
    assert.equal(calls.length, 0);

    const result = await service.index();

    assert.equal(result.state, 'fresh');
    assert.deepEqual(result.catalog, data.index);
    assert.deepEqual(calls, [primary, secondary, local]);
    assert.deepEqual(await service.detail('demo'), data.detail);
    assert.equal(calls.at(-1), local.replace('index.json', 'demo.json'));
    await service.index();
    assert.equal(calls.length, 4, 'свежий кеш не повторяет сеть');
    primaryOnline = true;
    await service.index(true);
    assert.equal(calls.at(-1), primary, 'refresh снова начинает с публичного сайта');
  });
}

test('CAT-LOCAL-URL: HTTP разрешён только заданному origin без credentials, query и hash', async () => {
  const data = moduleCatalogFixture();
  let calls = 0;

  const origins = [
    'http://public.invalid:4174',
    'http://localhost:4174',
    'http://127.0.0.1',
    'http://127.0.0.1:4173',
    'http://127.0.0.2:4174',
    'http://127.0.0.1.example.invalid:4174',
    'ftp://127.0.0.1:4174',
    'http://u:p@127.0.0.1:4174',
  ];
  const urls = [
    ...origins.map((origin) => `${origin}/api/plugins/v1/index.json`),
    `${local}?url=x`,
    `${local}#x`,
    local.replace('/v1/', '/v2/'),
    primary.replace('/v1/', '/v2/'),
    local.replace('/v1/index.json', '/index.json'),
  ];

  for (const address of urls) {
    const service = new PluginCatalogService({
      applicationVersion: '1.0.0',
      urls: [address],
      fetch: async () => {
        calls += 1;

        return Response.json(data.index);
      },
    });

    try {
      assert.equal((await service.index()).state, 'unavailable');
    } finally {
      await service.close();
    }
  }

  assert.equal(calls, 0);
});
