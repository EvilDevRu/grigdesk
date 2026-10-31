// Месячная сводка B24 берётся из явных итогов портала: дневной ряд задач может
// учитывать одну и ту же задачу в нескольких днях и не равен числу закрытых.
import assert from 'node:assert/strict';
import test from 'node:test';

import { customClientModule } from './helpers/trackerPackage.js';

test('месячная сводка использует completed_tasks, а не сумму дневного ряда задач', async (t) => {
  const clientModule = await customClientModule(t);

  if (!clientModule) {
    return;
  }

  const { B24Client } = clientModule;
  const client = Object.create(B24Client.prototype);
  let apiCalls = 0;
  let requestedPath = '';
  client.discoverUserId = async () => 7;
  client.apiGet = async (path) => {
    apiCalls += 1;
    requestedPath = path;

    return {
      data: {
        mainData: {
          worked_hours: '196.82',
          completed_tasks: '26',
          min_hours: '150',
        },
        chartData: { tasks: [20, 19, 20] },
      },
    };
  };

  assert.deepEqual(await client.getMonthStats(), {
    hours: 196.82,
    completedTasks: 26,
    norm: 150,
  });
  assert.match(requestedPath, /action=getData/u);
  assert.match(requestedPath, /chart_period=day/u);
  assert.equal(apiCalls, 1);

  assert.deepEqual(await client.getMonthStats({
    worked_hours: 3.75,
    completed_tasks: 2,
    min_hours: 160,
  }), {
    hours: 3.75,
    completedTasks: 2,
    norm: 160,
  });
  assert.equal(apiCalls, 1, 'готовый mainData не должен повторно обращаться к порталу');
});
