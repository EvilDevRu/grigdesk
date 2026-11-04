import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebLogRuntime } from '../../web/src/shared/webLogRuntime.ts';

test('runtime сохраняет индивидуальный API открытия, фон суммирует и flush при mark', () => {
  const win = new EventTarget();
  const doc = new EventTarget();

  Object.defineProperty(doc, 'visibilityState', { value: 'visible' });

  const runtime = createWebLogRuntime({
    app: { config: { errorHandler: null } },
    router: {
      currentRoute: { value: { path: '/chats' } },
      beforeEach: () => () => {},
      afterEach: () => () => {},
      onError: () => () => {},
    },
    pinia: { use: () => {} },
    win,
    doc,
    fetch: async () => {
      throw new Error('offline');
    },
    url: '/api/web-log',
    storage: null,
    beacon: () => false,
  });

  try {
    for (let index = 0; index < 100; index += 1) {
      runtime.recordApi('api.complete', {
        method: 'GET',
        path: '/api/auth/state',
        ms: 1,
        attempt: 1,
        outcome: 'success',
      });
    }

    runtime.recordApi('api.complete', {
      method: 'GET',
      path: '/api/auth/state',
      ms: 2,
      attempt: 1,
      outcome: 'success',
      surface: 7,
    });
    runtime.mark('Проверка');

    const entries = runtime.log.snapshot().entries;

    assert.equal(entries.filter((row) => row.ev === 'api.complete').length, 1);
    assert.equal(entries.find((row) => row.ev === 'api.summary').data.count, 100);
    runtime.applyPolicy('off');
    runtime.applyPolicy('verbose');
    runtime.mark('Новый период');
    assert.equal(runtime.log.snapshot().entries.some((row) => row.ev === 'api.summary'), false);
  } finally {
    runtime.dispose();
  }
});
