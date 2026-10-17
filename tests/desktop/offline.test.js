import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cockpitAlive,
  offlineHtml,
  offlineUrl,
  waitForCockpit,
} from '../../desktop/src/offline.ts';

const origin = 'http://127.0.0.1:12345';

function response(status = 200, body = {
  configured: true,
  authenticated: false,
}) {
  return {
    status,
    json: async () => body,
  };
}

test('DW-21: HTML безопасно показывает адрес', () => {
  const html = offlineHtml('http://127.0.0.1:1/?x="<>&\'');

  assert.match(html, /lang="ru"/);
  assert.match(html, /charset="utf-8"/);
  assert.match(html, /Ждём сервер Кокпита/);

  const expectedMessage = 'Окно подключится само, как только сервер ответит\\. ' +
    'Если ожидание затянулось, выполните в терминале <code>cockpit status</code>\\.';

  assert.match(html, new RegExp(expectedMessage));
  assert.match(html, /http:\/\/127\.0\.0\.1:1\/\?x=&quot;&lt;&gt;&amp;&#39;/);
  assert.match(html, /default-src 'none'; style-src 'unsafe-inline'/);
  assert.match(html, /#0b0d11/);
  assert.doesNotMatch(html, /<script\b|<img\b|src\s*=|href\s*=|@import|url\(/i);
});

test('DW-22: data URL обратимо кодирует HTML', () => {
  const prefix = 'data:text/html;charset=utf-8;base64,';
  const url = offlineUrl(origin);

  assert.equal(url.startsWith(prefix), true);
  assert.equal(Buffer.from(url.slice(prefix.length), 'base64').toString('utf8'), offlineHtml(origin));
});

test('DW-23: готовность требует ответ auth/state', async () => {
  for (const configured of [true, false]) {
    for (const authenticated of [true, false]) {
      assert.equal(await cockpitAlive(origin, {
        fetchImpl: async (url, options) => {
          assert.equal(url, origin + '/api/auth/state');
          assert.equal(options.method, 'GET');
          assert.equal(options.redirect, 'error');
          assert.equal(options.signal instanceof AbortSignal, true);
          assert.equal(options.signal.aborted, false);

          return response(200, {
            configured,
            authenticated,
          });
        },
      }), true);
    }
  }

  for (const reply of [
    response(500),
    response(302),
    response(200, {}),
    response(200, []),
    response(200, null),
    response(200, {
      configured: 'true',
      authenticated: false,
    }),
    response(200, { configured: true }),
    {
      status: 200,
      json: async () => {
        throw new SyntaxError('Вместо JSON получен HTML');
      },
    },
  ]) {
    assert.equal(await cockpitAlive(origin, { fetchImpl: async () => reply }), false);
  }

  assert.equal(await cockpitAlive(origin, {
    fetchImpl: async () => {
      throw new Error('Тестовый сетевой отказ');
    },
  }), false);
});

test('DW-23/таймаут: зависший fetch получает abort через 2 с без реального ожидания', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let signal;
  const pending = cockpitAlive(origin, {
    fetchImpl: (_url, options) => {
      signal = options.signal;

      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });

  assert.equal(signal instanceof AbortSignal, true);
  t.mock.timers.tick(1999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  assert.equal(await pending, false);
});

test('DW-23/JSON: позднее тело ответа после внешней отмены не даёт готовность', async () => {
  const controller = new AbortController();
  const body = Promise.withResolvers();
  let reading = false;
  const pending = cockpitAlive(origin, {
    signal: controller.signal,
    fetchImpl: async () => ({
      status: 200,
      json: () => {
        reading = true;

        return body.promise;
      },
    }),
  });

  // Каркас должен попасть в assertion, а не повиснуть на не вызванной фикстуре JSON.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(reading, true);
  controller.abort();
  body.resolve({
    configured: true,
    authenticated: true,
  });
  assert.equal(await pending, false);
});

test('DW-24: ожидание ограничено отменой — два отказа и успех', async () => {
  let requests = 0;
  const sleeps = [];

  assert.equal(await waitForCockpit(origin, {
    fetchImpl: async () => {
      requests += 1;

      return response(requests < 3 ? 500 : 200);
    },
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      assert.equal(signal, undefined);
    },
  }), true);
  assert.equal(requests, 3);
  assert.deepEqual(sleeps, [2000, 2000]);
});

test('DW-24/до начала: отмена не вызывает fetch или sleep', async () => {
  const controller = new AbortController();
  let requests = 0;

  controller.abort();
  assert.equal(await waitForCockpit(origin, {
    signal: controller.signal,
    fetchImpl: async () => {
      requests += 1;

      return response();
    },
    sleep: async () => assert.fail('Сон после отмены не нужен'),
  }), false);
  assert.equal(requests, 0);
});

test('DW-24/запрос: отмена прерывает fetch без последующего сна', async () => {
  const controller = new AbortController();
  let signal;
  const pending = waitForCockpit(origin, {
    signal: controller.signal,
    fetchImpl: (_url, options) => {
      signal = options.signal;

      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    sleep: async () => assert.fail('После отменённого запроса сон не нужен'),
  });

  assert.equal(signal instanceof AbortSignal, true);
  controller.abort();
  assert.equal(signal.aborted, true);
  assert.equal(await pending, false);
});

test('DW-24/сон: отмена собственного сна завершается false', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const controller = new AbortController();
  let requests = 0;
  const pending = waitForCockpit(origin, {
    signal: controller.signal,
    intervalMs: 30,
    fetchImpl: async () => {
      requests += 1;

      return response(500);
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  controller.abort();
  assert.equal(await pending, false);
  t.mock.timers.tick(10000);
  assert.equal(requests, 1);
});

test('DW-24/подмена сна: Abort rejection не уходит в caller', async () => {
  const controller = new AbortController();

  assert.equal(await waitForCockpit(origin, {
    signal: controller.signal,
    fetchImpl: async () => response(500),
    sleep: async (_ms, signal) => {
      assert.equal(signal, controller.signal);
      controller.abort();

      throw new DOMException('Тестовая отмена', 'AbortError');
    },
  }), false);
});

test('DW-24/поздний ответ: успех после abort не загружает сайт', async () => {
  const controller = new AbortController();
  const reply = Promise.withResolvers();
  let requests = 0;
  const pending = waitForCockpit(origin, {
    signal: controller.signal,
    fetchImpl: async () => {
      requests += 1;
      await reply.promise;

      return response();
    },
    sleep: async () => assert.fail('Поздний ответ не должен запустить новый цикл'),
  });

  assert.equal(requests, 1);
  controller.abort();
  reply.resolve();
  assert.equal(await pending, false);
});
