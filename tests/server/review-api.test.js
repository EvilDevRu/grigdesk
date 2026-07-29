import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import reviewsModule, { reviewPublicError } from '../../server/src/modules/reviews/index.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

function fixture(t, overrides = {}) {
  const calls = [];
  const reviews = {
    snapshot: async () => ({ pulls: [], summary: { count: 0, tone: '' } }),
    summary: async () => ({ count: 0, tone: '' }),
    sync: async (input) => { calls.push(['sync', input]); return { ok: true }; },
    markRead: async (id) => { calls.push(['read', id]); return { ok: true }; },
    analyze: async (id, options) => { calls.push(['analyze', id, options]); return { ok: true }; },
    setScope: async (id, items) => { calls.push(['scope', id, items]); return { ok: true }; },
    run: async (id) => { calls.push(['run', id]); return { run: { reviewRunId: 'rr-test' } }; },
    getRun: async (id) => ({ reviewRunId: id }),
    accept: async (id, input) => { calls.push(['accept', id, input]); return { reviewRunId: id }; },
    publish: async (id, input) => { calls.push(['publish', id, input]); return { reviewRunId: id }; },
    abandon: async (id, input) => { calls.push(['abandon', id, input]); return { reviewRunId: id }; },
    cleanup: async (id) => { calls.push(['cleanup', id]); return { reviewRunId: id }; },
    ...overrides,
  };
  const app = Fastify({ logger: false });
  app.register(reviewsModule, { reviews });
  t.after(() => app.close());
  return { app, calls };
}

test('API-SEC-02: review API запрещает cache для исходных комментариев', async (t) => {
  const { app } = fixture(t);
  const response = await app.inject({ method: 'GET', url: '/api/reviews' });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers.pragma, 'no-cache');
});

test('GATE-06: API передаёт scope серверному сервису и запускает асинхронно', async (t) => {
  const { app, calls } = fixture(t);
  const items = [{
    remarkId: 'remark-1',
    action: 'fix',
    acceptance: 'Тест проходит',
  }];
  const scope = await app.inject({
    method: 'PUT',
    url: '/api/reviews/pulls/pr-1/scope',
    payload: { items },
  });
  const run = await app.inject({
    method: 'POST',
    url: '/api/reviews/pulls/pr-1/run',
  });

  assert.equal(scope.statusCode, 200);
  assert.equal(run.statusCode, 202);
  assert.deepEqual(calls.slice(0, 2), [
    ['scope', 'pr-1', items],
    ['run', 'pr-1'],
  ]);
});

test('ANALYZE-09: ручной повтор передаёт только выбранное замечание', async (t) => {
  const { app, calls } = fixture(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/reviews/pulls/pr-1/analyze',
    payload: { remarkId: 'remark-2' },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [[
    'analyze',
    'pr-1',
    { manual: true, remarkId: 'remark-2' },
  ]]);
});

test('RB-04: прямой запуск без действующего scope возвращает конфликт', async (t) => {
  const error = Object.assign(new Error('Нужно решение человека'), {
    code: 'SCOPE_DECISION_REQUIRED',
  });
  const { app } = fixture(t, { run: async () => { throw error; } });
  const response = await app.inject({
    method: 'POST',
    url: '/api/reviews/pulls/pr-1/run',
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'SCOPE_DECISION_REQUIRED');
});

test('ISOLATE-04: пишущие review endpoints возвращают 503 без Factory executor', async (t) => {
  const endpoints = [
    { name: 'run', serviceMethod: 'run', url: '/api/reviews/pulls/pr-1/run' },
    { name: 'accept', serviceMethod: 'accept', url: '/api/reviews/runs/rr-1/accept' },
    { name: 'publish', serviceMethod: 'publish', url: '/api/reviews/runs/rr-1/publish' },
  ];
  for (const endpoint of endpoints) {
    await t.test(endpoint.name, async (st) => {
      const unavailable = Object.assign(new Error('executor отключён'), {
        code: 'REVIEW_EXECUTOR_UNAVAILABLE',
      });
      const { app } = fixture(st, {
        [endpoint.serviceMethod]: async () => { throw unavailable; },
      });
      const response = await app.inject({
        method: 'POST',
        url: endpoint.url,
        payload: {},
      });

      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error, 'REVIEW_EXECUTOR_UNAVAILABLE');
      assert.doesNotMatch(response.body, /executor отключён/);
    });
  }
});

test('PUBLISH-06: API передаёт только явный ручной retry неизвестной публикации', async (t) => {
  const { app, calls } = fixture(t);
  const reconcile = await app.inject({
    method: 'POST',
    url: '/api/reviews/runs/rr-1/publish',
    payload: {},
  });
  const retry = await app.inject({
    method: 'POST',
    url: '/api/reviews/runs/rr-1/publish',
    payload: { retryUnknown: true },
  });

  assert.equal(reconcile.statusCode, 200);
  assert.equal(retry.statusCode, 200);
  assert.equal(calls[0][2].retryUnknown, false);
  assert.equal(calls[1][2].retryUnknown, true);
});

test('внутренняя ошибка не раскрывает приватный текст и stack', async (t) => {
  const secret = 'private review body canary';
  const { app } = fixture(t, {
    snapshot: async () => { throw new Error(secret); },
  });
  const response = await app.inject({ method: 'GET', url: '/api/reviews' });

  assert.equal(response.statusCode, 500);
  assert.doesNotMatch(response.body, new RegExp(secret));
  assert.doesNotMatch(response.body, /stack/i);
});

test('MAP-06: неоднозначная Project binding возвращается как явный конфликт', async (t) => {
  const error = Object.assign(new Error('Репозиторий привязан дважды'), {
    code: 'AMBIGUOUS_REPOSITORY_BINDING',
  });
  const { app } = fixture(t, { snapshot: async () => { throw error; } });
  const response = await app.inject({ method: 'GET', url: '/api/reviews' });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'AMBIGUOUS_REPOSITORY_BINDING');
  assert.match(response.json().message, /привязан/);
});

test('PUBLISH-02: неверный operationId — клиентская ошибка, lock timeout — временная', async (t) => {
  const invalid = Object.assign(new Error('Некорректный ID публикации'), {
    code: 'PUBLICATION_ID_INVALID',
  });
  const first = fixture(t, { publish: async () => { throw invalid; } });
  const invalidResponse = await first.app.inject({
    method: 'POST',
    url: '/api/reviews/runs/rr-1/publish',
    payload: { operationId: '../bad' },
  });
  assert.equal(invalidResponse.statusCode, 400);
  assert.equal(invalidResponse.json().error, 'PUBLICATION_ID_INVALID');

  const timeout = Object.assign(new Error('lock занят'), { code: 'STATE_LOCK_TIMEOUT' });
  const second = fixture(t, { snapshot: async () => { throw timeout; } });
  const unavailable = await second.app.inject({ method: 'GET', url: '/api/reviews' });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().error, 'STATE_LOCK_TIMEOUT');
  assert.doesNotMatch(unavailable.body, /lock занят/);
});

test('kernel lock review-хранилищ отображается как временная недоступность', () => {
  for (const code of [
    'REVIEW_STORE_LOCK_TIMEOUT',
    'REVIEW_STORE_LOCK_UNAVAILABLE',
    'REVIEW_STORE_LOCK_LOST',
    'REVIEW_CONTROL_LOCK_UNAVAILABLE',
    'STATE_LOCK_LOST',
  ]) {
    const mapped = reviewPublicError(Object.assign(new Error('lock недоступен'), { code }));
    assert.equal(mapped.statusCode, 503, code);
    assert.equal(mapped.body.error, code);
    assert.doesNotMatch(mapped.body.message, /lock недоступен/);
  }
});
