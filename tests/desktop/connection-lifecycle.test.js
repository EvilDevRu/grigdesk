import assert from 'node:assert/strict';
import test from 'node:test';

import { createConnectionLifecycle, PermanentConnectionError } from '../../desktop/src/connectionLifecycle.ts';

const origin = 'http://127.0.0.1:28140';
const failure = {
  code: -102,
  url: origin + '/',
  isMainFrame: true,
};

/**
 * Подмены записывают эффект перед ожиданием, чтобы видеть порядок и отмену.
 * Каждое действие получает один и тот же сигнал собственного controller.
 */
function fixture(overrides = {}) {
  const calls = [];
  const addresses = [];
  const delays = [];
  const controller = new AbortController();
  let clock = 0;
  const action = (name, fallback) => async (...args) => {
    const signal = args.at(-1);

    assert.strictEqual(signal, controller.signal);
    calls.push(name);

    return (overrides[name] ?? fallback)(...args);
  };
  const lifecycle = createConnectionLifecycle({
    origin,
    controller,
    alive: action('alive', async () => true),
    wait: action('wait', async () => true),
    ensureSession: action('session', async () => 'session'),
    loadOffline: action('offline', async () => undefined),
    showUnavailable: action('unavailable', async () => undefined),
    loadGrigDesk: action('grigdesk', async (address) => {
      addresses.push(address);
    }),
    sleep: action('sleep', async (ms) => {
      delays.push(ms);
    }),
    now: () => clock,
    ...overrides.options,
  });

  return {
    lifecycle,
    calls,
    addresses,
    delays,
    controller,
    clock: () => clock,
    setNow: (value) => {
      clock = value;
    },
  };
}

/**
 * Каркас без действий завершается проверяемым assertion, а не зависшим deferred.
 * Обороты event loop ограничены собственным коротким сроком теста.
 */
async function observe(predicate) {
  const deadline = Date.now() + 1000;

  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(predicate(), true, 'Ожидаемое действие не началось');
}

test('DW-C1: сессия обеспечена до loadURL', async () => {
  const f = fixture();

  await f.lifecycle.connect();
  assert.deepEqual(f.calls, ['alive', 'session', 'grigdesk']);
});

test('DW-C2: offline сменяется сайтом', async () => {
  const waiting = Promise.withResolvers();
  const f = fixture({
    alive: async () => false,
    wait: () => waiting.promise,
  });
  const pending = f.lifecycle.connect();

  await observe(() => f.calls.includes('wait'));
  assert.deepEqual(f.calls, ['alive', 'offline', 'wait']);
  waiting.resolve(true);
  await pending;
  assert.deepEqual(f.calls, ['alive', 'offline', 'wait', 'session', 'grigdesk']);
});

test('DW-C3: провал load после probe не теряется', async () => {
  const load = Promise.withResolvers();
  let loads = 0;
  const f = fixture({
    grigdesk: () => {
      loads += 1;

      return loads === 1 ? load.promise : Promise.resolve();
    },
  });
  const pending = f.lifecycle.connect();

  await observe(() => loads === 1);
  assert.strictEqual(f.lifecycle.loadFailed(failure), pending);
  assert.strictEqual(f.lifecycle.connect(), pending);
  load.reject(new Error('главная загрузка не удалась'));
  await pending;
  assert.deepEqual(f.calls, ['alive', 'session', 'grigdesk', 'offline', 'wait', 'session', 'grigdesk']);
  assert.equal(loads, 2);
});

test('DW-C3: сбой offline является ошибкой приложения', async () => {
  const error = new Error('data URL не загрузился');
  const f = fixture({
    alive: async () => false,
    offline: async () => {
      throw error;
    },
  });

  await assert.rejects(f.lifecycle.connect(), error);
  assert.deepEqual(f.calls, ['alive', 'offline']);
});

test('DW-C4: повторный connect не размножает ожидания', async () => {
  const waiting = Promise.withResolvers();
  const f = fixture({
    alive: async () => false,
    wait: () => waiting.promise,
  });
  const first = f.lifecycle.connect();

  assert.strictEqual(f.lifecycle.connect(), first);
  await observe(() => f.calls.includes('wait'));

  for (const skipped of [
    {
      ...failure,
      code: -3,
    },
    {
      ...failure,
      isMainFrame: false,
    },
    {
      ...failure,
      url: 'http://127.0.0.1:28141/',
    },
    {
      ...failure,
      url: 'https://foreign.test/',
    },
    {
      ...failure,
      url: `blob:${origin}/identifier`,
    },
    {
      ...failure,
      url: 'data:text/plain,offline',
    },
  ]) {
    await f.lifecycle.loadFailed(skipped);
  }

  waiting.resolve(true);
  await first;
  assert.deepEqual(f.calls, ['alive', 'offline', 'wait', 'session', 'grigdesk']);

  const before = f.calls.length;

  await f.lifecycle.loadFailed({
    ...failure,
    code: -3,
  });
  assert.equal(f.calls.length, before);
  await f.lifecycle.loadFailed(failure);
  assert.deepEqual(f.calls.slice(before), ['offline', 'wait', 'session', 'grigdesk']);
});

test('DW-C5: stop отменяет каждый await', async () => {
  const stopped = fixture();

  stopped.lifecycle.stop();
  await stopped.lifecycle.connect();
  assert.deepEqual(stopped.calls, []);

  for (const blocked of ['alive', 'offline', 'wait', 'session', 'grigdesk']) {
    const deferred = Promise.withResolvers();
    const f = fixture({
      alive: async () => !['offline', 'wait'].includes(blocked),
      [blocked]: () => deferred.promise,
    });
    const pending = f.lifecycle.connect();

    await observe(() => f.calls.includes(blocked));

    const before = [...f.calls];

    f.lifecycle.stop();
    assert.equal(f.controller.signal.aborted, true);
    deferred.resolve(true);
    await pending;
    assert.deepEqual(f.calls, before);
    await f.lifecycle.loadFailed(failure);
    await f.lifecycle.connect();
    assert.deepEqual(f.calls, before);
  }
});

test('DW-C5: отказ отменённого действия не становится unhandled rejection', async () => {
  const request = Promise.withResolvers();
  const f = fixture({ alive: () => request.promise });
  const pending = f.lifecycle.connect();

  await observe(() => f.calls.includes('alive'));
  f.lifecycle.stop();
  request.reject(new DOMException('проверка отмены', 'AbortError'));
  await pending;
  assert.deepEqual(f.calls, ['alive']);
});

test('DW-C5: после загрузки нет фонового входа или heartbeat', async () => {
  const f = fixture();

  await f.lifecycle.connect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls, ['alive', 'session', 'grigdesk']);
});

test('DW-C6: unavailable показывает страницу отказа и не загружает интерфейс', async () => {
  const f = fixture({
    session: async () => 'unavailable',
    sleep: async () => {
      f.controller.abort();
    },
  });

  await f.lifecycle.connect();
  assert.deepEqual(f.calls, ['alive', 'session', 'unavailable', 'sleep']);
  assert.deepEqual(f.addresses, []);
});

test('DW-C6: отказ повторяется через 10 секунд и сменяется интерфейсом', async () => {
  const answers = ['unavailable', 'window-key'];
  const f = fixture({
    session: async () => answers.shift(),
  });

  await f.lifecycle.connect();
  assert.deepEqual(f.delays, [10_000]);
  assert.deepEqual(f.calls, ['alive', 'session', 'unavailable', 'sleep', 'alive', 'session', 'grigdesk']);
  assert.deepEqual(f.addresses, [origin + '/']);
});

test('DW-C7: главный документ с 401 входит заново и открывает тот же адрес', async () => {
  const f = fixture();

  await f.lifecycle.connect();

  const before = f.calls.length;

  f.lifecycle.navigated({ url: origin + '/chats#turn-42', httpResponseCode: 401 });
  await f.lifecycle.connect();

  assert.deepEqual(f.calls.slice(before), ['alive', 'session', 'grigdesk']);
  assert.deepEqual(f.addresses, [origin + '/', origin + '/chats#turn-42']);
});

test('DW-C7: чужой URL, подфрейм и data-страница вход не запускают', async () => {
  const f = fixture();

  await f.lifecycle.connect();

  const before = f.calls.length;

  for (const event of [
    { url: 'https://foreign.test/', httpResponseCode: 401 },
    { url: 'http://127.0.0.1:28141/', httpResponseCode: 401 },
    { url: 'data:text/html,<p>отказ</p>', httpResponseCode: 401 },
    {
      url: origin + '/chats',
      httpResponseCode: 401,
      isMainFrame: false,
    },
  ]) {
    f.lifecycle.navigated(event);
  }

  // События не запускают даже собственный цикл: новые calls появились бы сами.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, before);

  assert.deepEqual(f.addresses, [origin + '/']);
});

test('DW-C7: адрес восстановления берётся из успешной навигации и hash', async () => {
  const f = fixture();

  await f.lifecycle.connect();
  f.lifecycle.navigated({ url: origin + '/board', httpResponseCode: 200 });
  f.lifecycle.navigated({ url: 'https://foreign.test/board', httpResponseCode: 200 });
  f.lifecycle.navigated({ url: origin + '/chats#turn-7', isMainFrame: true });
  f.lifecycle.navigated({ url: origin + '/shot', isMainFrame: false });

  const before = f.calls.length;

  f.lifecycle.navigated({ url: origin + '/settings', httpResponseCode: 401 });
  await f.lifecycle.connect();

  assert.deepEqual(f.calls.slice(before), ['alive', 'session', 'grigdesk']);
  assert.deepEqual(f.addresses.at(-1), origin + '/settings');
});

test('DW-C8: повторный 401 в течение минуты не обменивает ключ заново', async () => {
  const f = fixture();

  await f.lifecycle.connect();

  const before = f.calls.length;

  f.lifecycle.navigated({ url: origin + '/chats', httpResponseCode: 401 });
  await f.lifecycle.connect();
  assert.deepEqual(f.calls.slice(before), ['alive', 'session', 'grigdesk']);
  assert.deepEqual(f.addresses, [origin + '/', origin + '/chats']);

  const afterFirst = f.calls.length;

  f.setNow(f.clock() + 59_000);
  f.lifecycle.navigated({ url: origin + '/chats', httpResponseCode: 401 });
  await f.lifecycle.connect();
  assert.deepEqual(f.calls.slice(afterFirst), ['unavailable', 'sleep', 'alive', 'session', 'grigdesk']);
  assert.deepEqual(f.delays, [10_000]);

  f.setNow(f.clock() + 61_000);
  f.lifecycle.navigated({ url: origin + '/chats', httpResponseCode: 401 });
  await f.lifecycle.connect();
  assert.deepEqual(f.calls.slice(afterFirst + 5), ['alive', 'session', 'grigdesk']);
});

test('DW-C8: два одновременных запроса входа дают один обмен', async () => {
  const exchange = Promise.withResolvers();
  const f = fixture({
    session: () => exchange.promise.then(() => 'window-key'),
  });
  const first = f.lifecycle.connect();

  await observe(() => f.calls.includes('session'));
  assert.strictEqual(f.lifecycle.connect(), first);
  exchange.resolve();
  await first;
  assert.deepEqual(f.calls, ['alive', 'session', 'grigdesk']);

  const second = fixture();

  await second.lifecycle.connect();

  const before = second.calls.length;

  second.lifecycle.navigated({ url: origin + '/chats', httpResponseCode: 401 });

  const pending = second.lifecycle.connect();

  assert.strictEqual(second.lifecycle.connect(), pending);
  await pending;
  assert.deepEqual(second.calls.slice(before), ['alive', 'session', 'grigdesk']);
});

test('DW-C10: сбой страницы отказа при восстановлении по 401 возвращается вызывающему', async () => {
  let sessions = 0;
  const f = fixture({
    session: async () => {
      sessions += 1;

      return sessions === 1 ? 'session' : 'unavailable';
    },
    unavailable: async () => {
      throw Object.assign(new Error('Страница отказа не загрузилась.'), { code: -2 });
    },
  });

  await f.lifecycle.connect();

  const quiet = f.lifecycle.navigated({ url: origin + '/board', httpResponseCode: 200 });

  assert.ok(quiet instanceof Promise, 'navigated не вернул обещание для обычной навигации');
  await quiet;

  const recovery = f.lifecycle.navigated({ url: origin + '/chats', httpResponseCode: 401 });

  assert.ok(recovery instanceof Promise, 'navigated не вернул обещание восстановления');
  await assert.rejects(recovery, /Страница отказа не загрузилась/u);
});

test('DW-C9: stop во время страницы отказа и повтора запрещает следующий эффект', async () => {
  for (const blocked of ['unavailable', 'sleep']) {
    const deferred = Promise.withResolvers();
    const f = fixture({
      session: async () => 'unavailable',
      [blocked]: () => deferred.promise,
    });
    const pending = f.lifecycle.connect();

    await observe(() => f.calls.includes(blocked));

    const before = [...f.calls];

    f.lifecycle.stop();
    deferred.resolve();
    await pending;
    assert.deepEqual(f.calls, before, blocked);

    f.lifecycle.navigated({ url: origin + '/chats', httpResponseCode: 401 });
    await f.lifecycle.connect();
    assert.deepEqual(f.calls, before, blocked);
  }
});

test('LC-01: успешный цикл вызывает onConnected один раз', async () => {
  let connected = 0;
  const f = fixture({
    options: {
      onConnected: () => {
        connected += 1;
        f.calls.push('connected');
      },
    },
  });

  await f.lifecycle.connect();
  assert.equal(connected, 1);
  assert.deepEqual(f.calls, ['alive', 'session', 'grigdesk', 'connected']);
});

test('LC-02: 401, сбой загрузки, повторный отказ и отмена не дают onConnected до успеха', async () => {
  let connected = 0;
  const options = {
    onConnected: () => {
      connected += 1;
    },
  };
  const load = Promise.withResolvers();
  let loads = 0;
  const f = fixture({
    options,
    grigdesk: () => {
      loads += 1;

      return loads === 1 ? load.promise : Promise.resolve();
    },
  });
  const pending = f.lifecycle.connect();

  await observe(() => loads === 1);
  f.lifecycle.navigated({ url: origin + '/', httpResponseCode: 401 });
  load.resolve();
  await pending;
  assert.equal(loads, 2);
  assert.equal(connected, 1, 'Первая загрузка с 401 не считается подключением.');

  const failed = Promise.withResolvers();
  let failedLoads = 0;
  const g = fixture({
    options,
    grigdesk: () => {
      failedLoads += 1;

      return failedLoads === 1 ? failed.promise : Promise.resolve();
    },
  });
  const recovering = g.lifecycle.connect();

  await observe(() => failedLoads === 1);
  g.lifecycle.loadFailed(failure);
  failed.reject(new Error('главная загрузка не удалась'));
  await recovering;
  assert.equal(failedLoads, 2);
  assert.equal(connected, 2, 'Сбой загрузки засчитывается только после повторного успеха.');

  g.setNow(10_000);
  g.lifecycle.navigated({ url: origin + '/chats', httpResponseCode: 401 });
  await g.lifecycle.connect();
  assert.equal(connected, 3, 'Следующий успешный цикл — ещё один вызов.');

  g.setNow(20_000);
  g.lifecycle.navigated({ url: origin + '/chats', httpResponseCode: 401 });
  await g.lifecycle.connect();
  assert.equal(connected, 4, 'Повторный отказ входа засчитывается только после успеха.');
  assert.ok(g.calls.includes('unavailable'));

  const cancelled = Promise.withResolvers();
  const h = fixture({
    options,
    grigdesk: () => cancelled.promise,
  });
  const stopped = h.lifecycle.connect();

  await observe(() => h.calls.includes('grigdesk'));
  h.lifecycle.stop();
  cancelled.resolve();
  await stopped;
  assert.equal(connected, 4, 'Отменённый цикл не сообщает о подключении.');
});

test('LC-03: retryMs управляет паузой после unavailable и после повторного 401', async () => {
  const answers = ['unavailable', 'window-key'];
  const f = fixture({
    session: async () => answers.shift() ?? 'session',
    options: {
      retryMs: () => 500,
    },
  });

  await f.lifecycle.connect();
  assert.deepEqual(f.delays, [500]);

  f.lifecycle.navigated({ url: origin + '/chats', httpResponseCode: 401 });
  await f.lifecycle.connect();
  f.setNow(f.clock() + 1000);
  f.lifecycle.navigated({ url: origin + '/chats', httpResponseCode: 401 });
  await f.lifecycle.connect();
  assert.deepEqual(f.delays, [500, 500]);
});

test('LC-04: без retryMs пауза прежняя — 10 000 мс', async () => {
  const answers = ['unavailable', 'window-key'];
  const f = fixture({
    session: async () => answers.shift() ?? 'session',
  });

  await f.lifecycle.connect();
  f.lifecycle.navigated({ url: origin + '/chats', httpResponseCode: 401 });
  await f.lifecycle.connect();
  f.lifecycle.navigated({ url: origin + '/chats', httpResponseCode: 401 });
  await f.lifecycle.connect();
  assert.deepEqual(f.delays, [10_000, 10_000]);
});

test('несовместимый пакет завершает подключение явной ошибкой без повторов', async () => {
  const error = new PermanentConnectionError('Версия не обслуживается');
  const run = fixture({ grigdesk: async () => {
    throw error;
  } });

  await assert.rejects(run.lifecycle.connect(), (failure) => failure === error);
  assert.deepEqual(run.calls, ['alive', 'session', 'grigdesk']);
});
