import assert from 'node:assert/strict';
import test from 'node:test';

import { ActionTokens } from '../../server/src/lib/mobile/actionTokens.ts';
import { registerTrackerRoutes } from '../../server/src/lib/mobile/facade/tracker.ts';
import { mobileFacadeFixture, mutation } from './helpers/mobile-facade.js';

/**
 * Синтетический портал не делает сетевых обращений и отдаёт реальные внутренние имена полей.
 * Отдельный список factory проверяет onPipeline независимо от статуса Б24.
 */
async function setup(t) {
  const calls = [];
  const options = {
    profile: 'demo',
    routes: ['feature', 'explicit'],
    defaultRoute: 'feature',
    defaultRunner: 'test-runner',
    catalogHash: 'a'.repeat(64),
    routeOptions: {
      feature: {
        title: 'Разработка',
        instrumentationMode: 'disabled',
      },
      explicit: {
        title: 'Замер',
        instrumentationRequired: true,
      },
    },
  };
  const deps = {
    tokens: new ActionTokens(),
    callApi: async (method, path, body) => {
      calls.push({
        method,
        path,
        body,
      });

      return {
        statusCode: 200,
        body:
          method === 'POST'
            ? { ok: true }
            : path.endsWith('/launch-options')
              ? options
              : path === '/api/tasks'
                ? { tasks: [{ task: '101' }] }
                : path === '/api/tracker/dashboard'
                  ? {
                      tasks: [
                        {
                          id: 101,
                          title: 'Задача',
                          priority: 1,
                          statusLabel: 'В работе',
                          deadlineRaw: '',
                        },
                      ],
                    }
                  : {
                      id: 101,
                      title: 'Задача',
                      description: '<img src=x onerror=alert(1)>',
                      status: 2,
                      deadline: '',
                      responsible: 'Исполнитель',
                    },
      };
    },
  };
  const { app } = await mobileFacadeFixture(t, (mobile) => registerTrackerRoutes(mobile, deps));

  return {
    app,
    calls,
    options,
  };
}

test('MC-19/20/21: текст Б24, onPipeline и закреплённый выбор маршрута', async (t) => {
  const { app, calls } = await setup(t);
  const list = (await app.inject('/api/mobile/v1/tracker/tasks')).json();

  assert.equal(list.tasks[0].onPipeline, true);
  assert.equal(list.tasks[0].deadline, null);

  const detail = (await app.inject('/api/mobile/v1/tracker/tasks/101')).json();

  assert.equal(detail.task.description, '<img src=x onerror=alert(1)>');

  const already = (await app.inject('/api/mobile/v1/tracker/tasks/101/launch-options')).json();

  assert.equal(already.reason, 'Задача уже на конвейере.');
  assert.equal(already.actionToken, null);
  assert.deepEqual(already.options, []);

  const launch = (await app.inject('/api/mobile/v1/tracker/tasks/102/launch-options')).json();

  assert.equal(launch.options[1].disabledReason, 'Нужны параметры инструментации в GrigDesk.');

  const bad = await mutation(app, '/api/mobile/v1/tracker/tasks/102/launch', {
    optionId: 'forged',
    actionToken: launch.actionToken,
  });

  assert.equal(bad.statusCode, 400);
  assert.equal(
    calls.some((call) => call.method === 'POST'),
    false,
  );

  const fresh = (await app.inject('/api/mobile/v1/tracker/tasks/102/launch-options')).json();
  const result = await mutation(
    app,
    '/api/mobile/v1/tracker/tasks/102/launch',
    {
      optionId: 'feature',
      actionToken: fresh.actionToken,
    },
    'launch-success-001',
  );

  assert.equal(result.statusCode, 200, result.body);
  assert.equal(calls.at(-1).body.route, 'feature');
  assert.equal(calls.at(-1).body.profile, 'demo');
  assert.equal(calls.at(-1).body.expectedCatalogHash, 'a'.repeat(64));
  assert.match(calls.at(-1).body.expectedLaunch, /^[a-f0-9]{64}$/);
});
