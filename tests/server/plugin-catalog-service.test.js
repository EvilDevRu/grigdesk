import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginCatalogService } from '../../server/src/lib/pluginCatalog.ts';
import { catalogFixture } from '../helpers/pluginCatalog.js';

const url = 'https://catalog.example.invalid/grigdesk/api/plugins/v1/index.json';

/**
 * Ответ имеет реальный ReadableStream и Content-Type, не подменяет разбор JSON сервиса.
 * Временная сеть принадлежит тесту, публичный сайт не вызывается.
 */
function json(value) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

test('CAT-S1: lazy boot, TTL, cooldown, stale, 24h и согласованные детали', async (t) => {
  const fixture = catalogFixture();
  const calls = [];
  let now = Date.parse(fixture.index.generatedAt);
  let fail = false;
  const service = new PluginCatalogService({
    urls: [url],
    applicationVersion: '1.0.0',
    now: () => now,
    fetch: async (input, options) => {
      calls.push({ input: String(input), options });

      if (fail) {
        throw new Error('fixture-private-error');
      }

      return json(String(input).endsWith('index.json') ? fixture.index : fixture.detail);
    },
  });

  t.after(() => service.close());
  assert.equal(calls.length, 0);
  assert.equal((await service.index()).state, 'fresh');
  assert.equal((await service.index()).state, 'fresh');
  assert.equal(calls.length, 1);
  assert.equal((await service.detail('demo')).plugin.id, 'demo');
  assert.equal(calls[1].input, url.replace('index.json', 'demo.json'));
  assert.equal(calls[0].options.redirect, 'error');
  fail = true;
  now += 301000;
  assert.equal((await service.index()).state, 'stale');


  const count = calls.length;

  assert.equal((await service.index(true)).state, 'stale');
  assert.equal(calls.length, count, 'cooldown действует и для принудительного refresh');
  now += 24 * 60 * 60 * 1000;
  assert.equal((await service.index()).state, 'unavailable');
});

test('CAT-S2: unsafe источники, malformed/oversized JSON и смена снимка', async (t) => {
  const fixture = catalogFixture();
  let network = 0;

  for (const address of ['', 'http://public.invalid/index.json', 'https://u:p@site.invalid/index.json',
    'https://site.invalid/index.json?token=x']) {
    const service = new PluginCatalogService({
      urls: [address],
      applicationVersion: '1.0.0',
      fetch: async () => {
        network += 1;

        return json(fixture.index);
      },
    });

    assert.equal((await service.index()).state, 'unavailable');
    await service.close();
  }

  assert.equal(network, 0);

  for (const body of [{}, 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    const service = new PluginCatalogService({
      urls: [url],
      applicationVersion: '1.0.0',
      fetch: async () => json(body),
    });

    assert.equal((await service.index()).state, 'unavailable');
    await service.close();
  }

  fixture.detail.generatedAt = '2026-10-21T10:00:00.000Z';


  const changed = new PluginCatalogService({
    urls: [url],
    applicationVersion: '1.0.0',
    fetch: async (input) => json(String(input).endsWith('index.json') ? fixture.index : fixture.detail),
  });

  t.after(() => changed.close());
  await assert.rejects(changed.detail('demo'), { statusCode: 409 });
  await assert.rejects(changed.detail('../other'), { statusCode: 404 });
});

test('CAT-S3: concurrent index deduplicated, close aborts без поздней публикации', async () => {
  let calls = 0;
  let started;
  const barrier = new Promise((resolve) => {
    started = resolve;
  });
  const service = new PluginCatalogService({
    applicationVersion: '1.0.0',
    fetch: async (_input, { signal }) => {
      calls += 1;
      started();

      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });
  const first = service.index();
  const second = service.index();

  await barrier;


  const closed = service.close();

  await Promise.allSettled([first, second, closed]);
  assert.equal(calls, 1);
  await assert.rejects(service.index(), { statusCode: 503 });
});
