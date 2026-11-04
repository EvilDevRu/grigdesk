import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { setImmediate } from 'node:timers/promises';
import { customReadModule } from './helpers/trackerPackage.js';

import { TaskFavoritesService } from '../../server/src/lib/taskFavoritesService.ts';
import { TaskSeenService } from '../../server/src/lib/taskSeenService.ts';
import { TaskShelfService } from '../../server/src/lib/taskShelfService.ts';
import favoritesModule from '../../server/src/modules/task-favorites/index.ts';
import seenModule from '../../server/src/modules/task-seen/index.ts';
import shelfModule from '../../server/src/modules/task-shelf/index.ts';

import b24Module from '../../server/src/modules/tracker/index.ts';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = require('fastify');

/**
 * События фиксируют начало чтения и отмену серверного потребителя без wall-clock замеров.
 * Все разрешающие функции принадлежат синтетической HTTP-фикстуре.
 */
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

test('HTTP-01: GET передаёт signal, успешный ответ не отменяет его', async (t) => {
  let signal;
  const app = Fastify({ logger: false });

  app.register(b24Module, {
    tracker: {
      async getDashboard(options = {}) {
        signal = options.signal;

        return { tasks: [] };
      },
    },
  });
  t.after(() => app.close());

  const response = await app.inject('/api/tracker/dashboard');

  assert.equal(response.statusCode, 200);
  assert.equal(signal instanceof AbortSignal, true);
  assert.equal(signal.aborted, false);
});

test('HTTP-02: disconnect настоящего GET отменяет серверного подписчика', {
  timeout: 5000,
}, async (t) => {
  const started = deferred();
  const aborted = deferred();
  const consumer = new AbortController();
  const app = Fastify({ logger: false });
  let serverSignal;

  app.register(b24Module, {
    tracker: {
      /**
       * Синтетический ответ остаётся открытым до ухода HTTP-потребителя.
       * Отмена наблюдается на сервере независимо от отклонения браузерного fetch.
       */
      getDashboard(options = {}) {
        serverSignal = options.signal;
        started.resolve();

        if (!serverSignal) {
          return {};
        }

        return new Promise((_resolve, reject) => {
          serverSignal.addEventListener('abort', () => {
            aborted.resolve();
            reject(serverSignal.reason);
          }, { once: true });
        });
      },
    },
  });
  t.after(async () => {
    consumer.abort();
    await app.close();
  });

  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const request = fetch(`${address}/api/tracker/dashboard`, {
    signal: consumer.signal,
  }).catch((error) => error);

  await started.promise;
  assert.equal(serverSignal instanceof AbortSignal, true);
  consumer.abort();
  assert.equal((await request).name, 'AbortError');
  await aborted.promise;
  assert.equal(serverSignal.aborted, true);
});

/**
 * Два HTTP-потребителя делят настоящее холодное определение identity адаптера.
 * В queued-режиме перед ним стоит мутация, отменённое определение не должно начаться.
 */
async function assertColdLocalCancellation(t, kind, queued) {
  const sessionModule = await customReadModule('src/session.ts', t);

  if (!sessionModule) {
    return;
  }

  const { CustomSession: B24Adapter } = sessionModule;
  const { currentB24Read } = await customReadModule('src/readOperations.ts', t);
  let tail = Promise.resolve();
  const serial = (fn) => {
    const work = tail.then(fn);

    tail = work.catch(() => undefined);

    return work;
  };
  const held = deferred();
  const bothSubscribed = deferred();
  const bothGone = deferred();
  let left = 0;
  const cancelled = deferred();
  const consumers = [new AbortController(), new AbortController()];
  const app = Fastify({ logger: false });
  let starts = 0;
  let subscriptions = 0;
  const signals = [];
  let master;
  const adapter = new B24Adapter({
    host: {
      credentials: { read: () => null },
      serial,
      cookiePath: '/tmp/unused-cold-local-cookie',
    },
  });

  adapter.client = () => ({
    baseUrl: 'https://portal.example.test',
    /**
     * Истинный контекст определяет общий signal холодной операции.
     * Барьер отделяет уход HTTP-потребителей от завершения самой работы.
     */
    async discoverUserId() {
      starts += 1;
      master = currentB24Read().signal;
      master.addEventListener('abort', () => cancelled.resolve(), { once: true });

      return held.promise;
    },
    timer: () => held.promise,
  });

  const original = adapter.accountIdentity.bind(adapter);

  adapter.accountIdentity = (options) => {
    subscriptions += 1;
    signals.push(options?.signal);
    options?.signal?.addEventListener('abort', () => {
      left += 1;

      if (left === 2) {
        bothGone.resolve();
      }
    }, { once: true });

    if (subscriptions === 2) {
      bothSubscribed.resolve();
    }

    return original(options);
  };

  const busy = queued ? adapter.timer('start', '42') : Promise.resolve();
  const store = {
    list: async () => ({
      revision: 0,
      taskIds: [],
      initialized: false,
      entries: [],
    }),
  };
  const configuration = {
    favorites: [favoritesModule, { favorites: new TaskFavoritesService({ store, tracker: adapter }) }],
    seen: [seenModule, { seen: new TaskSeenService({ store, tracker: adapter }) }],
    shelf: [shelfModule, { shelf: new TaskShelfService({ store, tracker: adapter }) }],
  };
  const [module, options] = configuration[kind];

  app.decorate('pluginEnabled', () => true);
  app.register(module, options);
  t.after(async () => {
    consumers.forEach((consumer) => consumer.abort());
    held.resolve(77);
    await busy;
    app.server.closeAllConnections();
    await app.close();
  });

  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const requests = consumers.map((consumer, index) => fetch(
    `${origin}/api/tracker/task-${kind}?slot=${index}`,
    { signal: consumer.signal },
  ).catch((error) => error));

  await bothSubscribed.promise;
  await setImmediate();
  assert.ok(signals.every((signal) => signal instanceof AbortSignal));
  consumers[0].abort();
  assert.equal((await requests[0]).name, 'AbortError');
  await setImmediate();

  if (!queued) {
    assert.equal(master.aborted, false);
  }

  consumers[1].abort();
  assert.equal((await requests[1]).name, 'AbortError');
  await bothGone.promise;
  await setImmediate();

  if (queued) {
    held.resolve(77);
    await busy;
    await setImmediate();
    assert.equal(starts, 0);
  } else {
    await cancelled.promise;
    assert.equal(master.aborted, true);
    assert.equal(starts, 1);
  }
}

for (const kind of ['favorites', 'seen', 'shelf']) {
  test(`HTTP-LOCAL: ${kind}, последний уход отменяет общую identity`, {
    timeout: 5000,
  }, (t) => assertColdLocalCancellation(t, kind, false));
}

test('HTTP-LOCAL-QUEUE: ушедшие клиенты не запускают холодную identity из очереди', {
  timeout: 5000,
}, (t) => assertColdLocalCancellation(t, 'favorites', true));
