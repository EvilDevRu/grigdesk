import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reconnectSse, resetSseForTests, setSseEnabled, sseRecovering, sseRetryAt, sseSubscribe,
} from '../../web/src/composables/useSse.ts';

test('W7: отзыв доступа останавливает SSE и повтор, возврат сохраняет подписчиков', (t) => {
  const original = globalThis.EventSource;
  const sources = [];

  globalThis.EventSource = class {
    constructor() {
      sources.push(this);
    }
    addEventListener() {}
    close() {
      this.closed = true;
    }
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    resetSseForTests();
    globalThis.EventSource = original;
  });
  sseSubscribe(() => {});
  assert.equal(sources.length, 1);
  sources[0].onerror();
  setSseEnabled(false);
  t.mock.timers.tick(5000);
  assert.equal(sources.length, 1);
  setSseEnabled(true);
  assert.equal(sources.length, 2);
});

test('поток событий: паузы растут, ручной повтор не создаёт второй поток и hello доходит до чатов', (t) => {
  const original = globalThis.EventSource;
  const sources = [];
  const events = [];

  globalThis.EventSource = class {
    handlers = new Map();

    constructor() {
      sources.push(this);
    }
    addEventListener(name, callback) {
      this.handlers.set(name, callback);
    }
    close() {
      this.closed = true;
    }
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    resetSseForTests();
    globalThis.EventSource = original;
  });
  sseSubscribe((name) => events.push(name));

  for (const delay of [1000, 1000, 1000, 2000, 4000, 8000, 16000, 30000]) {
    const count = sources.length;

    sources.at(-1).onerror();
    assert.equal(sseRecovering.value, true);
    assert.ok(sseRetryAt.value > 0);
    t.mock.timers.tick(delay - 1);
    assert.equal(sources.length, count);
    t.mock.timers.tick(1);
    assert.equal(sources.length, count + 1);
  }

  const old = sources.at(-1);

  old.onerror();
  reconnectSse();

  const current = sources.at(-1);
  const count = sources.length;

  old.onerror();
  t.mock.timers.tick(30000);
  assert.equal(sources.length, count);
  current.onopen();
  current.handlers.get('hello')({ data: '{"boot":"fixture"}' });
  assert.equal(sseRecovering.value, false);
  assert.equal(sseRetryAt.value, 0);
  assert.deepEqual(events, ['hello']);
  setSseEnabled(false);
  reconnectSse();
  assert.equal(sources.length, count);
});
