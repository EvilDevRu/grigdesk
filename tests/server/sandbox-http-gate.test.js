// Граница раздела «Песочницы» в HTTP: подъём стенда занимает слот и десяток минут,
// поэтому ручки открыты только СЕССИИ человека. CLI-токен агента сюда не пускается —
// у агента остаётся обычный Bash со своими правилами подтверждения.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import sandboxesModule from '../../server/src/modules/sandboxes/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const OVERVIEW = {
  profiles: [{ id: 'demo-profile', canRaise: true, reason: null }],
  sandboxes: [],
  jobs: [],
  manualRange: { from: 990000, to: 999999 },
};

function serviceStub(overrides = {}) {
  const calls = [];

  return {
    calls,
    overview: async () => OVERVIEW,
    raise: async (input) => {
      calls.push(['raise', input]);

      return { task: input.task || '990000', job: { task: '990000', state: 'running' } };
    },
    dismantle: async (input) => {
      calls.push(['dismantle', input]);

      return { task: input.task, job: { task: input.task, state: 'running' } };
    },
    run: async (input) => {
      calls.push(['run', input]);

      return { task: input.task, job: { task: input.task, state: 'running' } };
    },
    jobLog: async (task) => {
      calls.push(['jobLog', task]);

      return {
        task, action: 'run', state: 'done', text: 'ИТОГ: ок', truncated: false,
      };
    },
    ...overrides,
  };
}

async function fixture(t, { authKind = 'session', service = serviceStub() } = {}) {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    request.authKind = authKind;
  });
  await app.register(sandboxesModule, { service });
  t.after(() => app.close());

  return { app, service };
}

test('токен агента в раздел песочниц не пускается — это действие человека', async (t) => {
  const { app, service } = await fixture(t, { authKind: 'cli' });
  const requests = [
    ['GET', '/api/sandboxes', undefined],
    ['POST', '/api/sandboxes', { profile: 'demo-profile' }],
    ['POST', '/api/sandboxes/990000/down', {}],
    ['POST', '/api/sandboxes/990000/actions/scan-schedule', { args: { project: '1' } }],
    ['GET', '/api/sandboxes/990000/log', undefined],
  ];

  for (const [method, url, payload] of requests) {
    const response = await app.inject({ method, url, payload });

    assert.equal(response.statusCode, 403, `${method} ${url}`);
    assert.equal(response.json().error, 'session_required', `${method} ${url}`);
  }

  assert.deepEqual(service.calls, []);
});

test('обзор отдаёт профили, стенды и задания одним ответом', async (t) => {
  const { app } = await fixture(t);

  const response = await app.inject({ method: 'GET', url: '/api/sandboxes' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), OVERVIEW);
});

test('подъём принимает профиль и необязательный номер задачи', async (t) => {
  const { app, service } = await fixture(t);

  const withTask = await app.inject({
    method: 'POST',
    url: '/api/sandboxes',
    payload: { profile: 'demo-profile', task: '4242' },
  });
  const withoutTask = await app.inject({
    method: 'POST',
    url: '/api/sandboxes',
    payload: { profile: 'demo-profile' },
  });

  assert.equal(withTask.statusCode, 200);
  assert.equal(withoutTask.statusCode, 200);
  assert.deepEqual(service.calls, [
    ['raise', { profile: 'demo-profile', task: '4242' }],
    ['raise', { profile: 'demo-profile', task: null }],
  ]);
});

test('кривой профиль и кривой номер отклоняются до вызова службы', async (t) => {
  const { app, service } = await fixture(t);
  const requests = [
    ['/api/sandboxes', { profile: '../../etc', task: null }, 'bad_profile'],
    ['/api/sandboxes', { profile: '', task: null }, 'bad_profile'],
    ['/api/sandboxes', { profile: 'demo-profile', task: '0' }, 'bad_task'],
    ['/api/sandboxes', { profile: 'demo-profile', task: 't42; rm -rf /' }, 'bad_task'],
  ];

  for (const [url, payload, code] of requests) {
    const response = await app.inject({ method: 'POST', url, payload });

    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().error, code, JSON.stringify(payload));
  }

  const badDown = await app.inject({ method: 'POST', url: '/api/sandboxes/0/down', payload: {} });

  assert.equal(badDown.statusCode, 400);
  assert.equal(badDown.json().error, 'bad_task');
  assert.deepEqual(service.calls, []);
});

test('снос передаёт явный признак «вместе с незакоммиченным»', async (t) => {
  const { app, service } = await fixture(t);

  await app.inject({ method: 'POST', url: '/api/sandboxes/990000/down', payload: {} });
  await app.inject({ method: 'POST', url: '/api/sandboxes/990000/down', payload: { force: true } });

  assert.deepEqual(service.calls, [
    ['dismantle', { task: '990000', force: false }],
    ['dismantle', { task: '990000', force: true }],
  ]);
});

test('действие профиля уходит службе с аргументами, журнал — по номеру стенда', async (t) => {
  const { app, service } = await fixture(t);

  const started = await app.inject({
    method: 'POST',
    url: '/api/sandboxes/990000/actions/scan-schedule',
    payload: { args: { project: '389' } },
  });
  const log = await app.inject({ method: 'GET', url: '/api/sandboxes/990000/log' });

  assert.equal(started.statusCode, 200);
  assert.equal(log.statusCode, 200);
  assert.equal(log.json().text, 'ИТОГ: ок');
  assert.deepEqual(service.calls, [
    ['run', { task: '990000', action: 'scan-schedule', args: { project: '389' } }],
    ['jobLog', '990000'],
  ]);

  const badAction = await app.inject({
    method: 'POST',
    url: '/api/sandboxes/990000/actions/Bad%20Id',
    payload: {},
  });
  const badTask = await app.inject({ method: 'GET', url: '/api/sandboxes/0/log' });

  assert.equal(badAction.statusCode, 400);
  assert.equal(badAction.json().error, 'bad_action');
  assert.equal(badTask.statusCode, 400);
  assert.equal(service.calls.length, 2);
});

test('отказ службы доезжает до клиента своим кодом и статусом', async (t) => {
  const service = serviceStub({
    raise: async () => {
      const error = new Error('стенд этой задачи уже поднят');
      error.status = 409;
      error.code = 'sandbox_exists';

      throw error;
    },
    dismantle: async () => {
      throw new Error('down.sh не найден');
    },
  });
  const { app } = await fixture(t, { service });

  const conflict = await app.inject({
    method: 'POST',
    url: '/api/sandboxes',
    payload: { profile: 'demo-profile' },
  });
  const unknown = await app.inject({ method: 'POST', url: '/api/sandboxes/990000/down', payload: {} });

  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(conflict.json(), { error: 'sandbox_exists', message: 'стенд этой задачи уже поднят' });
  assert.equal(unknown.statusCode, 500);
  assert.deepEqual(unknown.json(), { error: 'sandbox_error' });
});
