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
