import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';

import { createPinia, setActivePinia } from '../../../web/node_modules/pinia/dist/pinia.mjs';
import { api, ApiError } from '../../../web/src/shared/apiClient.ts';
import { useBoardStore } from '../../../web/src/stores/board.ts';
import { useTasksStore } from '../../../web/src/stores/tasks.ts';
import { useTrackersStore } from '../../../web/src/stores/trackers.ts';
import { decodeTaskDetail } from '../../../web/src/shared/boardContracts.ts';
import { multiFixture } from '../../server/helpers/trackerMulti.js';
import { selectTracker } from '../../server/helpers/trackerFixture.js';
import { ownTask, seedTasks } from '../../server/helpers/grigdesk-tasks.js';

/**
 * Два оборота цикла пропускают продолжения Pinia и HTTP, без произвольного sleep.
 * Удержанные производители освобождаются самим тестом в finally.
 */
export async function flushMulti() {
  await setImmediate();
  await setImmediate();
}

/**
 * Pinia обращается к настоящим HTTP handlers изолированного серверного runtime.
 * Inject сохраняет auth, разбор тела и статусы, не требует внешнего портала или стенда.
 */
export async function webMultiFixture(t, { intercept = null, afterResponse = null } = {}) {
  setActivePinia(createPinia());

  const fixture = await multiFixture(t, { personal: true });

  await seedTasks(fixture.config, [ownTask()]);
  await selectTracker(fixture, 'fixture-a');

  const sourceA = (await fixture.request('GET', '/api/tracker/dashboard')).json().source;

  await selectTracker(fixture, 'fixture-b');

  const sourceB = (await fixture.request('GET', '/api/tracker/dashboard')).json().source;
  const calls = [];

  assert.equal(typeof sourceA, 'string', 'Исполняемый A должен подтвердить identity');
  assert.equal(typeof sourceB, 'string', 'Исполняемый B должен подтвердить identity');

  const sample = await fixture.request('GET', '/api/tracker/task/42');

  assert.equal(sample.statusCode, 200, sample.body);
  assert.doesNotThrow(() => decodeTaskDetail(sample.json()), 'Контрольный vendor DTO должен быть валиден');

  for (const [name, method] of [['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['del', 'DELETE']]) {
    t.mock.method(api, name, async (url, payload, options) => {
      const requestOptions = method === 'GET' ? payload : options;

      requestOptions?.signal?.throwIfAborted();
      calls.push({
        method,
        url,
        payload: method === 'GET' ? undefined : payload,
        options: requestOptions,
      });
      await intercept?.({
        method,
        url,
        payload,
        options: requestOptions,
      });

      const response = await fixture.request(method, url, method === 'GET' ? undefined : payload,
        requestOptions?.headers || {});
      const body = response.json();

      await afterResponse?.({
        method,
        url,
        body,
      });

      requestOptions?.signal?.throwIfAborted();

      if (response.statusCode >= 400) {
        throw new ApiError(body.message || body.error, response.statusCode, body);
      }

      return body;
    });
  }

  const board = useBoardStore();
  const trackers = useTrackersStore();
  const tasks = useTasksStore();

  t.after(() => board.stopPolling());

  return {
    ...fixture,
    board,
    trackers,
    tasks,
    sourceA,
    sourceB,
    calls,
  };
}

export const rowRefs = (board) => (board.data?.tasks || []).map((task) => [task.source, String(task.id)]);
