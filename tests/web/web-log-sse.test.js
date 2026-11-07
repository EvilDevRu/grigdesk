import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resetSseForTests, setSseLogSink, sseSubscribe }
  from '../../web/src/composables/useSse.ts';

test('SSE сообщает open до hello и сохраняет boot из валидного hello', () => {
  const originalSource = globalThis.EventSource;
  const events = [];
  let source;
  class FakeEventSource {
    listeners = new Map();
    constructor() { source = this; }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    close() {}
  }
  globalThis.EventSource = FakeEventSource;
  setSseLogSink((ev, data) => events.push({ ev, data }));
  try {
    const off = sseSubscribe(() => {});
    source.onopen();
    source.listeners.get('hello')({ data: JSON.stringify({ at: Date.now(),
      bootId: 'boot-aaaaaaaaaaaaaaaa' }) });
    assert.deepEqual(events.map((item) => item.ev), ['sse.open', 'sse.hello']);
    assert.equal(events[1].data.boot, 'boot-aaaaaaaaaaaaaaaa');
    off();
  } finally {
    resetSseForTests();
    setSseLogSink(null);
    globalThis.EventSource = originalSource;
  }
});

test('SSE фиксирует ошибки JSON и обоих видов подписчиков, сохраняя доставку остальным', async (t) => {
  const events = [];
  const delivered = [];
  let source;

  class FakeEventSource {
    listeners = new Map();

    constructor() {
      source = this;
    }

    addEventListener(name, fn) {
      this.listeners.set(name, fn);
    }

    close() {}
  }

  const original = globalThis.EventSource;

  globalThis.EventSource = FakeEventSource;
  setSseLogSink((event, data) => events.push({ event, data }));
  t.after(() => {
    resetSseForTests();
    setSseLogSink(null);
    globalThis.EventSource = original;
  });
  sseSubscribe(() => {
    const failure = new TypeError('secret-subscriber');

    failure.stack = 'secret\n at /assets/fault-abcdef12.js:1:20';

    throw failure;
  });
  sseSubscribe(async () => {
    throw new RangeError('secret-async');
  });
  sseSubscribe(() => {
    throw Object.defineProperty(new Error(), 'message', {
      get() {
        throw new Error('secret-getter');
      },
    });
  });
  sseSubscribe((name, data) => delivered.push({ name, data }));
  source.listeners.get('providers-update')({ data: 'secret-invalid-json' });
  await new Promise((resolve) => setImmediate(resolve));

  const faults = events.filter((entry) => entry.event === 'sse.fault');

  assert.deepEqual(faults.map((entry) => entry.data.phase), [
    'parse', 'subscriber', 'subscriber', 'subscriber',
  ]);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].data, null);
  assert.equal(faults[2].data.error.message, 'unclassified');
  assert.equal(faults[1].data.error.stack, '/assets/fault-abcdef12.js:1:20');
  assert.doesNotMatch(JSON.stringify(events), /secret/u);
});
