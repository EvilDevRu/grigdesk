import assert from 'node:assert/strict';
import test from 'node:test';

test('LO-12b: API, события и WebSocket используют origin интерфейса', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');

  t.after(() => {
    if (original) {
      Object.defineProperty(globalThis, 'location', original);
    } else {
      Reflect.deleteProperty(globalThis, 'location');
    }
  });

  for (const [origin, websocket] of [
    ['http://localhost:28140', 'ws://localhost:28140/api/terminal'],
    ['https://example.test', 'wss://example.test/api/terminal'],
  ]) {
    Object.defineProperty(globalThis, 'location', {
      value: new URL(origin!),
      configurable: true,
    });

    const source = new URL('../../web/src/shared/apiClient.ts', import.meta.url);

    source.searchParams.set('origin', origin!);

    const { api } = await import(source.href) as typeof import('../../web/src/shared/apiClient.ts');

    assert.equal(api.url('/api/health'), '/api/health');
    assert.equal(api.eventsUrl(), '/api/events');
    assert.equal(api.wsUrl('/api/terminal'), websocket);
  }
});

test('Vite подключает авторизованный dev-транспорт после удаления серверной раздачи UI', async (t) => {
  const previous = process.env.GRIGDESK_PORT;

  process.env.GRIGDESK_PORT = '28141';
  t.after(() => {
    if (previous === undefined) {
      delete process.env.GRIGDESK_PORT;
    } else {
      process.env.GRIGDESK_PORT = previous;
    }
  });

  const { loadConfigFromFile } = await import('../../web/node_modules/vite/dist/node/index.js');
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' },
    new URL('../../web/vite.config.js', import.meta.url).pathname);
  const plugins = loaded?.config.plugins?.flat();

  assert.equal(loaded?.config.server?.host, '127.0.0.1');
  assert.ok(plugins?.some((plugin) => plugin && 'name' in plugin
    && plugin.name === 'grigdesk-local-api'));
});
