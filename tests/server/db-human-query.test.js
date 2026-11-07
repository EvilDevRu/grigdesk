import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { createHumanDbQueries } from '../../server/src/lib/db/humanQueries.ts';
import dbModule from '../../server/src/modules/db/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Настоящие маршруты и служба консоли работают с управляемым движком без сети.
 * Независимые обещания execute и cancel воспроизводят оба порядка ответов драйвера.
 */
async function humanApi(t, engine, auditFailure = false) {
  const app = Fastify({ logger: false });
  const queries = new Map();
  const audit = [];
  const auditErrors = [];
  const session = {
    id: 'session-a',
    profile: { projectId: 'project-a' },
    engine,
    handle: {},
  };
  const service = createHumanDbQueries({
    queries,
    sessions: {
      find: (id) => id === session.id ? session : null,
      trackRun: () => () => {},
      close: async () => {},
    },
    settings: () => ({ maxRows: 1000, maxBytes: 4096 }),
    audit: {
      async append(entry) {
        if (auditFailure) {
          throw new Error('audit unavailable');
        }

        audit.push(entry);
      },
    },
    publish: () => {},
    onAuditError: (error) => auditErrors.push(error),
  });

  app.decorateRequest('authKind', null);
  app.addHook('onRequest', async (request) => {
    request.authKind = 'session';
  });
  app.decorate('pluginEnabled', () => true);
  await app.register(dbModule, { service: {
    query: service.query,
    cancelQuery: service.cancel,
    getQuery: (id) => queries.get(id),
  } });
  t.after(() => app.close());

  return {
    audit,
    auditErrors,
    start: async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/db/sessions/session-a/query',
        payload: { text: 'SELECT fixture', params: ['PRIVATE_PARAM'] },
      });

      assert.equal(response.statusCode, 202);

      return response.json().queryId;
    },
    cancel: (id) => app.inject({ method: 'POST', url: `/api/db/queries/${id}/cancel` }),
    get: async (id) => (await app.inject(`/api/db/queries/${id}`)).json(),
  };
}

for (const late of ['success', 'failure']) {
  test(`отмена сохраняет cancelled после позднего ${late} движка`, async (t) => {
    const execution = Promise.withResolvers();
    const api = await humanApi(t, {
      execute: () => execution.promise,
      cancel: async () => ({ ok: true, method: 'query' }),
    });
    const id = await api.start();

    assert.equal((await api.cancel(id)).json().ok, true);

    if (late === 'success') {
      execution.resolve([{ secret: 'LATE_RESULT' }]);
    } else {
      execution.reject(Object.assign(new Error('interrupted'), { code: 'ER_QUERY_INTERRUPTED' }));
    }

    await flush();

    const query = await api.get(id);

    assert.equal(query.state, 'cancelled');
    assert.equal(query.result, null);
    assert.deepEqual(api.audit.map((entry) => entry.outcome), ['cancelled']);
    assert.equal(JSON.stringify(api.audit).includes('PRIVATE_PARAM'), false);
  });
}

test('ответ execute до подтверждения отмены не публикует ложный done', async (t) => {
  const execution = Promise.withResolvers();
  const cancellation = Promise.withResolvers();
  const cancelEntered = Promise.withResolvers();
  const api = await humanApi(t, {
    execute: () => execution.promise,
    cancel: () => {
      cancelEntered.resolve();

      return cancellation.promise;
    },
  });
  const id = await api.start();
  const cancelling = api.cancel(id);

  await cancelEntered.promise;
  execution.resolve([{ interrupted: 1 }]);
  await flush();
  assert.equal((await api.get(id)).state, 'running');
  assert.equal(api.audit.length, 0);
  cancellation.resolve({ ok: true, method: 'query' });
  await cancelling;
  await flush();
  assert.equal((await api.get(id)).state, 'cancelled');
  assert.deepEqual(api.audit.map((entry) => entry.outcome), ['cancelled']);
});

test('неподдержанная отмена сохраняет настоящий успешный результат', async (t) => {
  const execution = Promise.withResolvers();
  const api = await humanApi(t, {
    execute: () => execution.promise,
    cancel: async () => ({ ok: false, method: 'wait' }),
  });
  const id = await api.start();

  assert.equal((await api.cancel(id)).json().ok, false);
  execution.resolve([{ id: 42 }]);
  await flush();
  assert.equal((await api.get(id)).state, 'done');
  assert.deepEqual((await api.get(id)).result.rows, [{ id: 42 }]);
});

test('консоль получает очищенные код и сообщение, без внутренностей драйвера', async (t) => {
  const api = await humanApi(t, {
    execute: async () => {
      throw Object.assign(new Error('\u001b[31mSyntax error near SELECT\u001b[0m'), {
        code: 'ER_PARSE_ERROR',
        sql: 'PRIVATE_SQL',
        params: ['PRIVATE_PARAM'],
        config: { password: 'PRIVATE_PASSWORD' },
      });
    },
  });
  const id = await api.start();

  await flush();

  const query = await api.get(id);

  assert.equal(query.state, 'error');
  assert.deepEqual(query.result, {
    ok: false,
    error: 'ER_PARSE_ERROR',
    message: 'Syntax error near SELECT',
  });
  assert.equal(/PRIVATE_|stack|config/.test(JSON.stringify(query.result)), false);
  assert.equal(JSON.stringify(api.audit).includes('Syntax error'), false);
});

test('отказ записи аудита не превращает выполненный запрос в ошибку', async (t) => {
  const api = await humanApi(t, { execute: async () => [{ id: 1 }] }, true);
  const id = await api.start();

  await flush();
  assert.equal((await api.get(id)).state, 'done');
  assert.equal(api.auditErrors.length, 1);
});
