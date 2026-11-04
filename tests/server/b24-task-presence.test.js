import assert from 'node:assert/strict';
import test from 'node:test';

import { customClientModule } from './helpers/trackerPackage.js';

const cases = [
  ['exists', { success: true, data: { id: '100000000001', title: 'Занята' } }, 'exists'],
  ['absent-text', { success: false, error: 'Задача не найдена' }, 'absent'],
  ['absent-code', { success: false, error: 'TASK_NOT_FOUND' }, 'absent'],
  ['absent-en', { success: false, error: 'Task not found' }, 'absent'],
  ['absent-en с пробелами', { success: false, error: '  Task not found  ' }, 'absent'],
  ['чужой номер', { success: true, data: { id: '42' } }, 'unknown'],
  ['пустые детали', { success: true, data: {} }, 'unknown'],
  ['права', { success: false, error: 'Задача не найдена или нет доступа' }, 'unknown'],
  ['логин', { success: false, error: 'AUTH_REQUIRED' }, 'unknown'],
  ['сеть', new Error('ECONNRESET'), 'unknown'],
];

for (const [name, reply, expected] of cases) {
  test(`PRESENCE-01: ${name} имеет явный результат ${expected}`, async (t) => {
    const clientModule = await customClientModule(t);

    if (!clientModule) {
      return;
    }

    const { B24Client } = clientModule;
    const client = Object.create(B24Client.prototype);
    const calls = [];

    client.apiGet2 = async (url, body) => {
      calls.push([url, body]);

      if (reply instanceof Error) {
        throw reply;
      }

      return reply;
    };

    // На исходнике тот же raw getTaskDetails доступен через прежний detail-reader.
    // Его бизнес-ответ отличается от безопасного probe, но сетевой fixture остаётся тем же.
    const reader = client.probeTaskNumber || client.taskDetails;
    const result = await reader.call(client, '100000000001').catch(() => 'legacy-error');

    assert.equal(result, expected);
    assert.equal(typeof client.probeTaskNumber, 'function');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/local/ajax/dashboard.php');
    assert.equal(new URLSearchParams(calls[0][1]).get('taskId'), '100000000001');
  });
}
