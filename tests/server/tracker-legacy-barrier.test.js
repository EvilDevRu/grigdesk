import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { legacyQueueAdapter } from './helpers/trackerQueue.js';
import trackerModule from '../../server/src/modules/tracker/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));

/**
 * Настоящий HTTP-модуль получает управляемую границу трекера.
 * Сеть и сессия портала в этом барьере не нужны: проверяем прежний wire contract.
 */
async function legacyFixture(t) {
  const app = requireFromServer('fastify')({ logger: false });
  const calls = [];
  const detail = {
    id: 42,
    title: 'Задача',
    description: 'https://t.me/fixture/1',
    status: 3
  };
  const dashboard = {
    userId: 7,
    tasks: [detail],
    toReview: [],
    created: [],
    today: { hours: 2, tasks_count: 1 },
    month: {
      hours: 82.5,
      norm: 160,
      completedTasks: 17
    },
    charts: { day: { labels: ['Сегодня'], hours: [2] } },
  };
  const b24 = {};
  const results = {
    getDashboard: dashboard,
    taskDetail: detail,
    findUsers: [{ id: 7, name: 'Исполнитель' }],
    listGroups: [{ id: 9, name: 'Проект' }],
    taskPageData: { comments: [{ mid: 1, text: 'Ответ' }, { mid: 2, isSystem: true }] },
    createTask: { ok: true, id: 43 },
    updateTask: { ok: true, id: 42 },
    addComment: { ok: true },
    timer: { ok: true },
    completeTask: { ok: true },
    renewTask: { ok: true },
  };

  for (const [name, result] of Object.entries(results)) {
    b24[name] = async (...args) => {
      calls.push({ name, args });

      return structuredClone(result);
    };
  }

  app.decorate('telegramDiscussion', async () => ({ links: [{ url: 'https://t.me/fixture/1' }] }));
  app.decorate('mediaFramePath', (name) => name === 'shot.png' ? '/fixture/shot.png' : null);
  app.decorate('mediaClipPath', (name) => name === 'clip.mp4' ? '/fixture/clip.mp4' : null);
  await app.register(trackerModule, { tracker: b24 });
  await app.ready();
  t.after(() => app.close());

  return {
    app,
    b24,
    calls,
    detail,
    dashboard
  };
}

test('LEGACY-HTTP-01: прежние пути, тела и ответы B24 сохраняются', async (t) => {
  const { app, calls, detail, dashboard } = await legacyFixture(t);
  const rows = [
    ['GET', '/api/tracker/dashboard', undefined, dashboard, 'getDashboard', []],
    ['GET', '/api/tracker/users?q=Иван', undefined,
      { users: [{ id: 7, name: 'Исполнитель' }] }, 'findUsers', ['Иван']],
    ['GET', '/api/tracker/groups', undefined,
      { groups: [{ id: 9, name: 'Проект' }] }, 'listGroups', []],
    ['GET', '/api/tracker/task/42', undefined,
      { ...detail, telegram: { links: [{ url: 'https://t.me/fixture/1' }] } }, 'taskDetail', ['42']],
    ['GET', '/api/tracker/task/42/comments', undefined,
      { comments: [{ mid: 1, text: 'Ответ' }] }, 'taskPageData', ['42']],
    ['POST', '/api/tracker/tasks', {
      title: 'Новая',
      frames: ['shot.png'],
      clips: ['clip.mp4']
    },
      { ok: true, id: 43 }, 'createTask', [{
        title: 'Новая',
        images: [
          { path: '/fixture/clip.mp4', name: 'фрагмент.mp4' },
          { path: '/fixture/shot.png', name: 'запись.jpg' },
        ],
      }]],
    ['POST', '/api/tracker/task/42/comment', { text: 'Ответ' },
      { ok: true }, 'addComment', ['42', 'Ответ']],
    ...['start', 'pause', 'stop'].map((action) => [
      'POST', `/api/tracker/task/42/timer/${action}`, {}, { ok: true }, 'timer', [action, '42'],
    ]),
    ['POST', '/api/tracker/task/42/complete', {}, { ok: true }, 'completeTask', ['42']],
    ['POST', '/api/tracker/task/42/renew', {}, { ok: true }, 'renewTask', ['42']],
  ];

  for (const [method, url, payload, expected, name, args] of rows) {
    const response = await app.inject({
      method,
      url,
      payload
    });

    assert.equal(response.statusCode, 200, url);
    assert.deepEqual(response.json(), expected, url);

    const actual = calls.at(-1);

    if (method === 'GET') {
      const options = actual.args.at(-1);

      assert.deepEqual(Object.keys(options), ['signal'], url);
      assert.equal(options.signal instanceof AbortSignal, true, url);
      assert.equal(options.signal.aborted, false, url);
      assert.deepEqual(actual, { name, args: [...args, options] }, url);
    } else {
      assert.deepEqual(actual, { name, args }, url);
    }
  }

  calls.length = 0;

  const updated = await app.inject({
    method: 'PUT',
    url: '/api/tracker/task/42',
    payload: {
      title: ' Только заголовок ',
      description: '',
      groupId: null,
      priority: 0
    },
  });

  assert.equal(updated.statusCode, 200);
  assert.deepEqual(calls, [
    { name: 'updateTask', args: ['42', {
      title: 'Только заголовок',
      description: '',
      groupId: null,
      priority: 0,
    }] },
    { name: 'taskDetail', args: ['42', {}] },
  ]);
  assert.equal(updated.json().telegram.links.length, 1);
});

test('LEGACY-HTTP-01: прежние отказы не вызывают эффект', async (t) => {
  const { app, b24, calls } = await legacyFixture(t);

  for (const [method, url, payload, error] of [
    ['GET', '/api/tracker/task/no-id', undefined, 'bad_task_id'],
    ['PUT', '/api/tracker/task/42', { deadline: 'завтра' }, 'b24_bad_request'],
  ]) {
    const response = await app.inject({
      method,
      url,
      payload
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, error);
  }

  assert.deepEqual(calls, []);

  const invalidTimer = await app.inject({ method: 'POST', url: '/api/tracker/task/42/timer/invalid' });

  assert.equal(invalidTimer.statusCode, 502);
  assert.deepEqual(calls, []);

  b24.getDashboard = async () => {
    throw new Error('B24 не настроен');
  };

  const unavailable = await app.inject('/api/tracker/dashboard');

  assert.equal(unavailable.statusCode, 400);
  assert.equal(unavailable.json().error, 'b24_error');

  b24.getDashboard = async () => {
    throw new Error('Ошибка сети');
  };

  const failed = await app.inject('/api/tracker/dashboard');

  assert.equal(failed.statusCode, 502);
  assert.equal(failed.json().error, 'b24_error');
});

test('LEGACY-QUEUE-01: detail, dashboard и mutation сериализованы, reject не запирает очередь',
  async (t) => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const order = [];
    let active = 0;
    let maximum = 0;

    /**
     * Удерживает первый вызов и считает одновременный допуск в клиент.
     * Освобождение счётчика гарантировано и при запланированном отказе.
     */
    const operation = async (name, held = false, fails = false) => {
      active += 1;
      maximum = Math.max(maximum, active);
      order.push(name);

      try {
        if (held) {
          entered.resolve();
          await release.promise;
        }

        if (fails) {
          throw new Error('Ожидаемый отказ');
        }

        return name;
      } finally {
        active -= 1;
      }
    };

    const adapter = await legacyQueueAdapter(operation, t);

    if (!adapter) {
      return;
    }

    const detail = adapter.taskDetail('42');
    const rejected = assert.rejects(detail, /Ожидаемый отказ/u);

    await entered.promise;

    const dashboard = adapter.getDashboard();
    const mutation = adapter.completeTask('42');

    try {
      assert.deepEqual(order, ['detail']);
    } finally {
      release.resolve();
    }

    await rejected;
    assert.deepEqual(await Promise.all([dashboard, mutation]), ['dashboard', 'complete']);
    assert.equal(maximum, 1);
    assert.deepEqual(order, ['detail', 'dashboard', 'complete']);
    assert.equal(await adapter.completeTask('42'), 'complete');
  });
