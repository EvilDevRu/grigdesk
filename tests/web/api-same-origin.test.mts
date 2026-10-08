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
