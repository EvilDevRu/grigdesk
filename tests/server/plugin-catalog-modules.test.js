import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginCatalogService } from '../../server/src/lib/pluginCatalog.ts';
import { moduleCatalogFixture } from '../helpers/pluginCatalogModules.js';

const primary = 'https://a.test/api/plugins/v1/index.json';
const secondary = 'https://b.test/api/plugins/v1/index.json';
const primaryV2 = primary.replace('/v1/', '/v2/');
const secondaryV2 = secondary.replace('/v1/', '/v2/');

/**
 * Источники обслуживаются настоящими Response, а содержимое выбирается по каналу URL.
 * Отказы и отличия зеркал задаются отдельно, без обращения к публичным сайтам.
 */
function catalogService(t, reply) {
  const data = moduleCatalogFixture();
  const calls = [];
  const service = new PluginCatalogService({
    urls: [primary, secondary],
    applicationVersion: '1.0.0',
    fetch: async (input, options) => {
      const url = String(input);

      calls.push(url);

      return reply(url, options, data);
    },
  });

  t.after(() => service.close());

  return {
    service,
    calls,
    ...data,
  };
}

/**
 * Одинаковое правило формирует index и detail каждой выдачи из одного fixture.
 * Старый api1 релиз в v1 не заменяется старшим api2 из modern.
 */
function channelReply(url, _options, data) {
  const channel = url.includes('/v2/') ? data.modern : data.legacy;

  return Response.json(url.endsWith('index.json') ? channel.index : channel.detail);
}

test('CAT-MODERN-SOURCE: modern и legacy одновременно сохраняют свои index/detail/cache', async (t) => {
  const { service, calls, modern, legacy } = catalogService(t, channelReply);

  assert.deepEqual((await service.index(false, true)).catalog, modern.index);
  assert.deepEqual(await service.detail('demo', true), modern.detail);
  assert.deepEqual((await service.index()).catalog, legacy.index);
  assert.deepEqual(await service.detail('demo'), legacy.detail);
  assert.deepEqual((await service.index(false, true)).catalog, modern.index);
  assert.deepEqual(await service.detail('demo', true), modern.detail);
  assert.deepEqual(calls, [primaryV2, primaryV2.replace('index.json', 'demo.json'),
    primary, primary.replace('index.json', 'demo.json')]);
});

for (const [label, available, expected] of [
  ['резервный v2', secondaryV2, [primaryV2, secondaryV2]],
  ['основной v1', primary, [primaryV2, secondaryV2, primary]],
  ['резервный v1', secondary, [primaryV2, secondaryV2, primary, secondary]],
]) {
  test(`CAT-MODERN-FALLBACK: ${label}`, async (t) => {
    const { service, calls, modern, legacy } = catalogService(t, (url, options, data) =>
      url === available ? channelReply(url, options, data) : new Response(null, { status: 503 }));
    const result = await service.index(false, true);

    assert.equal(result.state, 'fresh');
    assert.deepEqual(result.catalog, available.includes('/v2/') ? modern.index : legacy.index);
    assert.deepEqual(calls, expected);
  });
}

test('CAT-MODERN-FALLBACK: корректный пустой v2 не подменяется v1', async (t) => {
  const empty = {
    schemaVersion: 1,
    generatedAt: null,
    plugins: [],
  };
  const { service, calls } = catalogService(t, () => Response.json(empty));

  assert.deepEqual((await service.index(false, true)).catalog, empty);
  assert.deepEqual(calls, [primaryV2]);
});

for (const otherFeed of ['v2', 'v1']) {
  test(`CAT-MODERN-SNAPSHOT: другой снимок ${otherFeed} даёт 409 без подмены индекса`, async (t) => {
    const { service, calls, modern } = catalogService(t, (url, options, data) => {
      if (url === primaryV2) {
        return channelReply(url, options, data);
      }
      if (url === secondaryV2 && otherFeed === 'v2') {
        const changed = structuredClone(data.modern.index);

        changed.generatedAt = '2026-10-22T11:00:00.000Z';

        return Response.json(changed);
      }
      if (url === primary && otherFeed === 'v1') {
        return Response.json(data.legacy.index);
      }

      return new Response(null, { status: 503 });
    });
    const original = await service.index(false, true);

    assert.deepEqual(original.catalog, modern.index);
    await assert.rejects(service.detail('demo', true), { statusCode: 409 });
    assert.deepEqual((await service.index(false, true)).catalog, original.catalog);
    assert.ok(calls.includes(otherFeed === 'v2' ? secondaryV2 : primary));
  });
}

test('CAT-MODERN-CLOSE: close отменяет modern fetch и запрещает создание нового чтения', async (t) => {
  const entered = Promise.withResolvers();
  let aborted = false;
  const { service, calls } = catalogService(t, (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      aborted = true;
      reject(new DOMException('Закрыто', 'AbortError'));
    }, { once: true });
    entered.resolve();
  }));
  const reading = service.index(false, true);
  const settled = Promise.allSettled([reading]);

  await entered.promise;
  await service.close();
  await settled;
  assert.equal(aborted, true);
  assert.deepEqual(calls, [primaryV2]);
  await assert.rejects(service.index(false, true), { statusCode: 503 });
  await assert.rejects(service.index(), { statusCode: 503 });
  assert.deepEqual(calls, [primaryV2]);
});

test('CAT-LEGACY-ROOT-V1: корневой сервис не отдаёт api2 даже при v2 в urls', async (t) => {
  const { modern } = moduleCatalogFixture();
  const service = new PluginCatalogService({
    urls: [primaryV2],
    applicationVersion: '1.0.0',
    fetch: async () => Response.json(modern.index),
  });

  t.after(() => service.close());

  const result = await service.index();

  assert.equal(result.state, 'unavailable');
  assert.equal(result.catalog, null);
});
