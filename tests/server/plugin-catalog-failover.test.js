import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginCatalogService } from '../../server/src/lib/pluginCatalog.ts';
import { catalogFixture } from '../helpers/pluginCatalog.js';

const primary = 'https://grigdesk.com/api/plugins/v1/index.json';
const secondary = 'https://grigdesk.ru/api/plugins/v1/index.json';

/**
 * Настоящий Response сохраняет декодирование и ограничение тела внутри сервиса.
 * Сеть полностью синтетическая, публичные сайты не вызываются.
 */
function json(value) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

test('CAT-F1: источники заданы без env, резервный обслуживает карточки, refresh возвращает приоритет',
  async (t) => {
    const fixture = catalogFixture();
    const calls = [];
    let primaryOnline = false;
    const service = new PluginCatalogService({
      applicationVersion: '1.0.0',
      fetch: async (input) => {
        const address = String(input);

        calls.push(address);

        if (address.startsWith('https://grigdesk.com/') && !primaryOnline) {
          return new Response(null, { status: 503 });
        }

        return json(address.endsWith('index.json') ? fixture.index : fixture.detail);
      },
    });

    t.after(() => service.close());
    assert.equal(calls.length, 0, 'boot не ждёт сеть');
    assert.equal((await service.index()).state, 'fresh');
    assert.deepEqual(calls, [primary, secondary]);
    assert.equal((await service.detail('demo')).plugin.id, 'demo');
    assert.equal(calls.at(-1), secondary.replace('index.json', 'demo.json'));
    await service.index();
    assert.equal(calls.length, 3, 'свежий кеш не вызывает повторных запросов');
    primaryOnline = true;
    await service.index(true);
    assert.equal(calls.at(-1), primary);
    await service.detail('demo');
    assert.equal(calls.at(-1), primary.replace('index.json', 'demo.json'));
    assert.equal(calls.some((address) => address.includes('localhost')), false);
  });

test('CAT-F2: неверный и слишком большой индекс также переключают на резервный сайт', async (t) => {
  const fixture = catalogFixture();

  for (const broken of [{}, 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    const calls = [];
    const service = new PluginCatalogService({
      applicationVersion: '1.0.0',
      fetch: async (input) => {
        const address = String(input);

        calls.push(address);

        return json(address === primary ? broken : fixture.index);
      },
    });

    t.after(() => service.close());
    assert.equal((await service.index()).state, 'fresh');
    assert.deepEqual(calls, [primary, secondary]);
  }
});

test('CAT-F3: отказ карточки переключает сайт после сверки полного индекса', async (t) => {
  const fixture = catalogFixture();
  const calls = [];
  const service = new PluginCatalogService({
    applicationVersion: '1.0.0',
    fetch: async (input) => {
      const address = String(input);

      calls.push(address);

      if (address === primary.replace('index.json', 'demo.json')) {
        throw new Error('Основной сайт недоступен');
      }

      return json(address.endsWith('index.json') ? fixture.index : fixture.detail);
    },
  });

  t.after(() => service.close());
  await service.index();
  assert.equal((await service.detail('demo')).plugin.id, 'demo');
  assert.deepEqual(calls, [
    primary,
    primary.replace('index.json', 'demo.json'),
    secondary,
    secondary.replace('index.json', 'demo.json'),
  ]);
});

test('CAT-F4: другой снимок резервного сайта не подменяет принятый индекс', async (t) => {
  const fixture = catalogFixture();
  const changed = structuredClone(fixture.index);
  const calls = [];

  const extra = structuredClone(changed.plugins[0]);

  extra.id = 'other';
  extra.details = 'other.json';
  changed.plugins.push(extra);

  const service = new PluginCatalogService({
    applicationVersion: '1.0.0',
    fetch: async (input) => {
      const address = String(input);

      calls.push(address);

      if (address === primary) {
        return json(fixture.index);
      }

      if (address === secondary) {
        return json(changed);
      }

      throw new Error('Карточка недоступна');
    },
  });

  t.after(() => service.close());
  await service.index();
  await assert.rejects(service.detail('demo'), { statusCode: 409 });
  assert.deepEqual((await service.index()).catalog, fixture.index);
  assert.equal(calls.includes(secondary.replace('index.json', 'demo.json')), false);
});

test('CAT-F5: отказ обоих сайтов сохраняет stale, cooldown и восстановление старшего источника',
  async (t) => {
    const fixture = catalogFixture();
    const calls = [];
    let now = Date.parse(fixture.index.generatedAt);
    let online = true;
    const service = new PluginCatalogService({
      applicationVersion: '1.0.0',
      now: () => now,
      fetch: async (input) => {
        calls.push(String(input));

        if (!online) {
          throw new Error('Сайты недоступны');
        }

        return json(fixture.index);
      },
    });

    t.after(() => service.close());

    const fresh = await service.index();

    online = false;
    now += 301000;

    const stale = await service.index();

    assert.equal(stale.state, 'stale');
    assert.equal(stale.fetchedAt, fresh.fetchedAt);
    assert.deepEqual(stale.catalog, fresh.catalog);
    assert.deepEqual(calls, [primary, primary, secondary]);
    await service.index(true);
    assert.equal(calls.length, 3);
    online = true;
    now += 30001;
    assert.equal((await service.index()).state, 'fresh');
    assert.equal(calls.at(-1), primary);
  });

test('CAT-F6: таймаут основного сайта отменяет его запрос и открывает резервный', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const fixture = catalogFixture();
  const calls = [];
  let primarySignal;
  const service = new PluginCatalogService({
    applicationVersion: '1.0.0',
    fetch: async (input, { signal }) => {
      const address = String(input);

      calls.push(address);

      if (address === primary) {
        primarySignal = signal;

        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Таймаут')), { once: true });
        });
      }

      return json(fixture.index);
    },
  });

  t.after(() => service.close());

  const pending = service.index();

  t.mock.timers.tick(5000);
  assert.equal((await pending).state, 'fresh');
  assert.equal(primarySignal.aborted, true);
  assert.deepEqual(calls, [primary, secondary]);
});

test('CAT-F7: refresh во время чтения карточки запрещает старую публикацию и новые запросы зеркал',
  async (t) => {
    const fixture = catalogFixture();
    const updated = structuredClone(fixture.index);
    const calls = [];
    let refreshing = false;
    let release;
    let started;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const entered = new Promise((resolve) => {
      started = resolve;
    });

    updated.generatedAt = '2026-10-23T10:00:00.000Z';

    const service = new PluginCatalogService({
      applicationVersion: '1.0.0',
      fetch: async (input) => {
        const address = String(input);

        calls.push(address);

        if (address === primary) {
          return json(refreshing ? updated : fixture.index);
        }

        started();

        return held;
      },
    });

    t.after(async () => {
      release(json(fixture.detail));
      await service.close();
    });
    await service.index();

    const reading = service.detail('demo');

    await entered;
    refreshing = true;
    await service.index(true);
    release(json(fixture.detail));
    await assert.rejects(reading, { statusCode: 409 });
    assert.equal((await service.index()).catalog.generatedAt, updated.generatedAt);
    assert.deepEqual(calls, [primary, primary.replace('index.json', 'demo.json'), primary]);
  });

test('CAT-F8: корректный пустой основной каталог не вызывает запрос резервного сайта', async (t) => {
  const calls = [];
  const empty = {
    schemaVersion: 1,
    generatedAt: null,
    plugins: [],
  };
  const service = new PluginCatalogService({
    applicationVersion: '1.0.0',
    fetch: async (input) => {
      calls.push(String(input));

      return json(empty);
    },
  });

  t.after(() => service.close());

  const response = await service.index();

  assert.equal(response.state, 'fresh');
  assert.deepEqual(response.catalog, empty);
  assert.deepEqual(calls, [primary]);
});

test('CAT-F9: карточка нового снимка не ждёт незавершённое чтение прежнего', async (t) => {
  const fixture = catalogFixture();
  const updatedIndex = structuredClone(fixture.index);
  const updatedDetail = structuredClone(fixture.detail);
  let refreshed = false;
  let release;
  let started;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });

  updatedIndex.generatedAt = '2026-10-23T10:00:00.000Z';
  updatedDetail.generatedAt = updatedIndex.generatedAt;

  const service = new PluginCatalogService({
    applicationVersion: '1.0.0',
    fetch: async (input) => {
      if (String(input) === primary) {
        return json(refreshed ? updatedIndex : fixture.index);
      }

      if (refreshed) {
        return json(updatedDetail);
      }

      started();

      return held;
    },
  });

  t.after(async () => {
    release(json(fixture.detail));
    await service.close();
  });
  await service.index();

  const previous = service.detail('demo');

  await entered;
  refreshed = true;
  await service.index(true);

  const current = service.detail('demo');

  release(json(fixture.detail));
  assert.equal((await current).generatedAt, updatedIndex.generatedAt);
  await assert.rejects(previous, { statusCode: 409 });
  assert.equal((await service.detail('demo')).generatedAt, updatedIndex.generatedAt);
});

test('CAT-F10: отвергнутое тело закрывается сразу, тип JSON сравнивается без регистра', async (t) => {
  const fixture = catalogFixture();
  const cancelled = [];

  /**
   * Тело отказа никто не читает; cancel должен освободить соединение до GC.
   * Метка показывает, какой из ответов сервис закрыл явно.
   */
  function rejected(label, init) {
    const body = new ReadableStream({
      cancel() {
        cancelled.push(label);
      },
    });

    return new Response(body, init);
  }

  const service = new PluginCatalogService({
    applicationVersion: '1.0.0',
    fetch: async (input) => {
      if (String(input) === primary) {
        return rejected('http', { status: 503, headers: { 'content-type': 'application/json' } });
      }

      return new Response(JSON.stringify(fixture.index), {
        headers: { 'content-type': 'Application/JSON; charset=UTF-8' },
      });
    },
  });

  t.after(() => service.close());

  const response = await service.index();

  assert.equal(response.state, 'fresh');
  assert.deepEqual(response.catalog, fixture.index);
  assert.deepEqual(cancelled, ['http']);

  const html = new PluginCatalogService({
    applicationVersion: '1.0.0',
    urls: [primary],
    fetch: async () => rejected('type', { headers: { 'content-type': 'text/html' } }),
  });

  t.after(() => html.close());
  assert.equal((await html.index()).state, 'unavailable');
  assert.deepEqual(cancelled, ['http', 'type']);
});

test('CAT-F11: карточка с README в пределах сайта читается, ответ больше 2 MiB — нет', async (t) => {
  const fixture = catalogFixture();
  const large = structuredClone(fixture.detail);

  // 200 тыс. трёхбайтовых символов: в пределах 256 тыс. символов сайта, но больше 512 KiB.
  large.plugin.readme = '中'.repeat(200_000);

  const service = new PluginCatalogService({
    applicationVersion: '1.0.0',
    urls: [primary],
    fetch: async (input) => json(String(input) === primary ? fixture.index : large),
  });
  const oversized = new PluginCatalogService({
    applicationVersion: '1.0.0',
    urls: [primary],
    fetch: async (input) => json(String(input) === primary ? fixture.index : 'x'.repeat(2 * 1024 * 1024 + 1)),
  });

  t.after(() => service.close());
  t.after(() => oversized.close());
  assert.equal((await service.detail('demo')).plugin.readme.length, 200_000);
  await assert.rejects(oversized.detail('demo'), { statusCode: 502 });
});
