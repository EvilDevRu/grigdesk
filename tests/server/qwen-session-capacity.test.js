import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatLiveSessions } from '../../server/src/lib/chat/liveSessions.ts';
import qwen from '../../server/src/lib/executors/qwen.ts';

/**
 * Двойник заменяет только запуск native CLI, сохраняя политику настоящего адаптера.
 * Все процессы и барьеры принадлежат тесту, внешняя модель и systemd не нужны.
 */
function fixture(t, options = {}) {
  const handles = [];
  const pool = new ChatLiveSessions({ maxSessions: 1, ...options });
  const executor = {
    ...qwen,
    session: {
      ...qwen.session,
      enabled: () => true,
      fingerprint: () => 'host-test',
      open: async (spec) => {
        const handle = {
          spec,
          alive: true,
          sends: 0,
          send: async () => {
            handle.sends += 1;

            return { sessionId: `synthetic-${spec.chatKey}` };
          },
          interrupt: async () => {},
          close: async () => {
            handle.alive = false;
          },
        };

        handles.push(handle);

        return handle;
      },
    },
  };

  t.after(() => pool.closeAll());

  return {
    pool,
    executor,
    handles,
  };
}

/**
 * Барьер позволяет наблюдать незавершённый open или send без ожидания по таймеру.
 * Освобождает только принадлежащую тесту работу.
 */
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

test('Qwen Host: больше четырёх сессий, повторный ход и архив не вытесняют процессы', async (t) => {
  let archiveChecks = 0;
  const f = fixture(t, {
    maxSessions: 4,
    isArchived: async () => {
      archiveChecks += 1;

      return true;
    },
  });

  for (let index = 0; index < 8; index += 1) {
    await f.pool.run({ chatKey: `qwen-${index}`, executor: f.executor }, {});
  }

  await f.pool.run({ chatKey: 'qwen-0', executor: f.executor }, {});
  assert.equal(f.handles.length, 8);
  assert.equal(f.handles[0].sends, 2);
  assert.ok(f.handles.every((handle) => handle.alive));
  assert.equal(archiveChecks, 0, 'Архивный Qwen тоже не вытесняется по лимиту');
  assert.equal(f.pool.limits().pooledLive, 0);
  assert.equal(f.pool.limits().unlimitedLive, 8);
  assert.ok(f.pool.stats().every((entry) => entry.keepAlive && entry.limitExempt));
});

test('Qwen Host: заполненный работающими агентами пул допускает новый разговор', async (t) => {
  const f = fixture(t);
  const started = deferred();
  const finish = deferred();
  const ordinary = {
    id: 'ordinary',
    session: {
      mode: 'persistent',
      open: async () => ({
        alive: true,
        send: async () => {
          started.resolve();
          await finish.promise;

          return {};
        },
        interrupt: async () => {},
        close: async () => {},
      }),
    },
  };
  const running = f.pool.run({ chatKey: 'busy', executor: ordinary }, {});

  try {
    await started.promise;
    await f.pool.run({ chatKey: 'qwen', executor: f.executor }, {});
    assert.equal(f.pool.stats().find((entry) => entry.chatKey === 'busy').busy, true);
    assert.equal(f.pool.limits().live, 2);
  } finally {
    finish.resolve();
    await running;
  }
});

test('Qwen Host: обычный пул считает и вытесняет только свои процессы', async (t) => {
  const f = fixture(t, { isArchived: async () => true });
  const ordinary = {
    ...f.executor,
    id: 'ordinary',
    session: {
      ...f.executor.session,
      keepAlive: false,
      limitExempt: false,
    },
  };

  await f.pool.run({ chatKey: 'qwen', executor: f.executor }, {});
  await f.pool.run({ chatKey: 'ordinary-1', executor: ordinary }, {});
  await f.pool.run({ chatKey: 'ordinary-2', executor: ordinary }, {});
  assert.equal(f.handles[0].alive, true);
  assert.equal(f.handles[1].alive, false);
  assert.equal(f.handles[2].alive, true);
  assert.equal(f.pool.limits().pooledLive, 1);
  assert.equal(f.pool.limits().unlimitedLive, 1);
});

test('Qwen Host: параллельные открытия не занимают резерв обычного пула', async (t) => {
  const f = fixture(t);
  const opened = deferred();
  const finish = deferred();
  const nativeOpen = f.executor.session.open;
  let opening = 0;

  f.executor.session.open = async (spec) => {
    opening += 1;

    if (opening === 6) {
      opened.resolve();
    }

    await finish.promise;

    return nativeOpen(spec);
  };

  const running = Promise.all(Array.from({ length: 6 }, (_, index) =>
    f.pool.run({ chatKey: `qwen-${index}`, executor: f.executor }, {})));
  const ordinary = {
    ...f.executor,
    id: 'limited-host',
    session: {
      ...f.executor.session,
      limitExempt: false,
      open: nativeOpen,
    },
  };

  try {
    await Promise.race([opened.promise, running]);
    await f.pool.run({ chatKey: 'limited', executor: ordinary }, {});
    await assert.rejects(f.pool.run({ chatKey: 'blocked', executor: ordinary }, {}), /слот/);
  } finally {
    finish.resolve();
    await running;
  }

  assert.equal(f.pool.limits().live, 7);
  assert.equal(f.pool.limits().pooledLive, 1);
});

test('Qwen Host: неподтверждённое закрытие видно и не блокирует новые сессии', async (t) => {
  const f = fixture(t);

  await f.pool.run({ chatKey: 'retained', executor: f.executor }, {});

  const handle = f.handles[0];
  const close = handle.close;

  handle.close = async () => {
    throw new Error('scope completion unknown');
  };
  t.after(() => {
    handle.close = close;
  });

  await assert.rejects(f.pool.close('retained'), /scope completion unknown/);
  await f.pool.run({ chatKey: 'new', executor: f.executor }, {});
  assert.equal(f.pool.has('retained'), true);
  assert.equal(f.pool.limits().live, 2);
  handle.close = close;
  await f.pool.close('retained');
  assert.equal(f.pool.has('retained'), false);
  assert.equal(f.pool.has('new'), true);
});

test('Qwen Host: завершение процесса снимает запись и журнал сохраняет причину', async (t) => {
  const events = [];
  const f = fixture(t, { log: { info: (fields, message) => events.push({ fields, message }) } });

  await f.pool.run({ chatKey: 'exited', executor: f.executor }, {});
  f.handles[0].alive = false;
  f.handles[0].spec.hooks.onExit({ reason: 'synthetic exit' });
  assert.equal(f.pool.has('exited'), false);
  assert.equal(f.pool.limits().live, 0);
  assert.equal(events.at(-1).fields.reason, 'synthetic exit');
});
