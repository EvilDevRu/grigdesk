import assert from 'node:assert/strict';
import test from 'node:test';
import { resetSseForTests, setSseEnabled, sseSubscribe } from '../../web/src/composables/useSse.ts';

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
