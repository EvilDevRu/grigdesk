import assert from 'node:assert/strict';
import test from 'node:test';

import { ActionTokens } from '../../server/src/lib/mobile/actionTokens.ts';
import { registerTaskRoutes } from '../../server/src/lib/mobile/facade/tasks.ts';
import { mobileFacadeFixture, mutation } from './helpers/mobile-facade.js';

/**
 * Снимок exact attempt меняется независимо от HTTP-вызова телефона.
 * Fake воспроизводит только внешнюю границу, владелец CAS проверяется отдельно настоящим модулем.
 */
async function setup(t) {
  const calls = [];
  const snapshot = {
    profile: 'demo',
    attempt: 'a_' + 'a'.repeat(32),
    node: 'gate_plan',
    state: 'paused',
    stop: null,
    sequence: 8,
    headEventHash: 'b'.repeat(64),
    orchPid: 0,
    terminal: null,
  };
  const tasks = [
    {
      task: '101',
      title: 'Ждёт ворот',
      stages: {
        PLAN: 'done',
        GATE_PLAN: 'wait',
      },
      updatedAt: 1,
    },
    {
      task: '102',
      title: 'В работе',
      stages: { BUILD: 'run' },
      daemonAlive: true,
      updatedAt: 2,
    },
    {
      task: '103',
      title: 'Неизвестная остановка',
      stages: {},
      stall: { reason: 'Нужен оператор' },
    },
  ];
  let plan = 'Полное основание решения';
  let resumed = true;
  const deps = {
    tokens: new ActionTokens(),
    callApi: async (method, path, body) => {
      calls.push({
        method,
        path,
        body,
      });

      if (method === 'POST') {
        return {
          statusCode: 200,
          body: {
            ok: true,
            resumed,
            resumeError: resumed ? null : 'Нет исполнителя',
          },
        };
      }

      const payload =
        path === '/api/tasks'
          ? { tasks }
          : path.includes('/103/')
            ? {
                identity: null,
                statuses: {},
              }
            : path.endsWith('/mobile-state')
              ? {
                  identity: snapshot,
                  running: false,
                }
              : path.includes('/doc/')
                ? { text: plan }
                : path.endsWith('/graph')
                  ? {
                      keys: {
                        plan: 'PLAN',
                        gate_plan: 'GATE_PLAN',
                      },
                      statuses: {
                        plan: 'done',
                        gate_plan: 'wait',
                      },
                      nodes: {
                        plan: ['agent', 'План'],
                        gate_plan: ['gate', 'Утверждение плана'],
                      },
                      pos: {
                        plan: [0, 0],
                        gate_plan: [0, 1],
                      },
                    }
                  : tasks.find((item) => path.endsWith('/' + item.task));

      return {
        statusCode: payload ? 200 : 404,
        body: payload || {},
      };
    },
  };
  const { app } = await mobileFacadeFixture(t, (mobile) => registerTaskRoutes(mobile, deps));

  return {
    app,
    calls,
    snapshot,
    setPlan: (value) => {
      plan = value;
    },
    setResumed: () => {
      resumed = false;
    },
  };
}

test('MC-14/15: gate отличается от прочих вмешательств, граф не читается для running', async (t) => {
  const { app, calls } = await setup(t);
  const list = await app.inject('/api/mobile/v1/tasks');

  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().tasks[0].needsHuman.kind, 'gate');
  assert.match(list.json().tasks[0].needsHuman.text, /утвердить план/);
  assert.equal(list.json().tasks[2].needsHuman.kind, 'other');
  assert.equal(list.json().tasks[2].needsHuman.actionToken, null);
  assert.equal(
    calls.some((call) => call.path === '/api/tasks/102/graph'),
    false,
  );

  const detail = await app.inject('/api/mobile/v1/tasks/101');

  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().task.stages[1].key, 'GATE_PLAN');
});

test('MC-16/17/38: полное чтение плана, точная identity и частичный успех', async (t) => {
  const { app, calls, setPlan, setResumed } = await setup(t);

  setPlan('x'.repeat(70000));

  const task = (await app.inject('/api/mobile/v1/tasks/101')).json().task;
  const command = {
    gate: 'GATE_PLAN',
    decision: 'approve',
    comment: '',
    actionToken: task.needsHuman.actionToken,
  };
  const unread = await mutation(app, '/api/mobile/v1/tasks/101/gate', command);

  assert.equal(unread.statusCode, 409);
  assert.equal(
    calls.some((call) => call.method === 'POST'),
    false,
  );

  const fresh = (await app.inject('/api/mobile/v1/tasks/101')).json().task;
  let offset = 0;
  let revision;

  for (;;) {
    const page = await app.inject(
      '/api/mobile/v1/tasks/101/plan?offset=' +
        offset +
        (revision ? '&contentRevision=' + revision : ''),
    );

    assert.equal(page.statusCode, 200, page.body);

    const body = page.json();

    revision = body.contentRevision;

    if (!body.hasMore) {
      break;
    }

    offset = body.nextOffset;
  }

  setResumed();

  const result = await mutation(
    app,
    '/api/mobile/v1/tasks/101/gate',
    {
      ...command,
      actionToken: fresh.needsHuman.actionToken,
    },
    'task-gate-success',
  );

  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().resumed, false);
  assert.equal(calls.at(-1).body.expectedMobile.sequence, 8);
  assert.equal(calls.at(-1).body.attempt, 'a_' + 'a'.repeat(32));
});
