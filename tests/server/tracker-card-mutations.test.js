import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { NO_TRACKER_CAPABILITIES } from '../../shared/trackers/contracts.ts';
import { TrackerError } from '../../server/src/lib/trackers/contract.ts';
import { TrackerFacade } from '../../server/src/lib/trackers/facade.ts';
import trackerModule from '../../server/src/modules/tracker/index.ts';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const OPERATIONS = [
  ['POST', 'checklist', { title: ' Пункт ', parentId: '10' }, 'addChecklistItem',
    ['42', { title: 'Пункт', parentId: '10' }]],
  ['POST', 'checklist', { title: 'Пункт', parentId: 10 }, 'addChecklistItem',
    ['42', { title: 'Пункт', parentId: '10' }]],
  ['PUT', 'checklist/11', { title: ' Имя ' }, 'updateChecklistItem', ['42', '11', { title: 'Имя' }]],
  ['PUT', 'checklist/11', { complete: false }, 'updateChecklistItem', ['42', '11', { complete: false }]],
  ['DELETE', 'checklist/11', undefined, 'deleteChecklistItem', ['42', '11']],
  ['PUT', 'tags', { tags: [' Тег '] }, 'updateTaskTags', ['42', ['Тег']]],
  ['PUT', 'tags', { tags: [] }, 'updateTaskTags', ['42', []]],
  ['POST', 'approve', undefined, 'approveTask', ['42']],
  ['POST', 'disapprove', undefined, 'disapproveTask', ['42']],
  ['POST', 'renew', undefined, 'renewTask', ['42']],
];

/**
 * Настоящие HTTP wrap и фасад вызывают управляемый драйвер без портала и реквизитов.
 * Проверки фиксируют допуск мутации, её аргументы и отказ до обращения к драйверу.
 */
async function fixture(t, override = {}) {
  const calls = [];
  const driver = {
    capabilities: {
      ...NO_TRACKER_CAPABILITIES,
      checklist: true,
      tags: true,
      review: true,
      renew: true,
      editing: true,
    },
    taskDetail: async () => ({ id: 42, title: 'Задача' }),
    ...Object.fromEntries([...new Set(OPERATIONS.map((row) => row[3])), 'updateTask'].map((name) => [
      name,
      async (...args) => {
        calls.push({ name, args });

        return { ok: true };
      },
    ])),
    ...override,
  };
  const tracker = new TrackerFacade({
    selection: { read: () => ({
      drivers: ['fixture'],
      default: 'fixture',
      externalId: 'fixture',
      revision: 7,
    }) },
    registry: {
      context: () => ({ generation: 7, dataRevision: 0 }),
      call: async (_id, operation) => operation(driver),
    },
  });
  const app = require('fastify')({ logger: false });

  await app.register(trackerModule, { tracker });
  await app.ready();
  t.after(() => app.close());

  return { app, calls };
}

for (const [method, path, payload, name, args] of OPERATIONS) {
  test(`Мутация ${method} ${path}: нормализация и успех через фасад`, async (t) => {
    const { app, calls } = await fixture(t);
    const response = await app.inject({
      method,
      url: `/api/tracker/task/42/${path}`,
      payload,
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(calls, [{ name, args }]);
  });

  test(`Мутация ${method} ${path}: 404 драйвера сохраняется`, async (t) => {
    const { app } = await fixture(t, {
      [name]: async () => {
        throw new TrackerError('task_not_found', 'Задача отсутствует', 404);
      },
    });
    const response = await app.inject({
      method,
      url: `/api/tracker/task/42/${path}`,
      payload,
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, 'task_not_found');
  });

  test(`Мутация ${method} ${path}: отсутствующий метод понятен человеку`, async (t) => {
    const { app, calls } = await fixture(t, { [name]: undefined });
    const response = await app.inject({
      method,
      url: `/api/tracker/task/42/${path}`,
      payload,
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /unsupported/u);
    assert.match(response.json().message, /Драйвер не поддерживает/u);
    assert.deepEqual(calls, []);
  });

  test(`Мутация ${method} ${path}: конфликт поколения до драйвера`, async (t) => {
    const { app, calls } = await fixture(t);
    const response = await app.inject({
      method,
      url: `/api/tracker/task/42/${path}`,
      payload,
      headers: { 'x-grigdesk-tracker-generation': '6' },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'tracker_context_changed');
    assert.deepEqual(calls, []);
  });
}

const INVALID = [
  ['POST', 'checklist', null],
  ['POST', 'checklist', []],
  ['POST', 'checklist', {}],
  ['POST', 'checklist', { title: ' ' }],
  ['POST', 'checklist', { title: 2 }],
  ['POST', 'checklist', { title: 'a'.repeat(256) }],
  ['POST', 'checklist', { title: 'Пункт', parentId: 'x2' }],
  ['POST', 'checklist', { title: 'Пункт', parentId: null }],
  ['POST', 'checklist', { title: 'Пункт', parentId: true }],
  ['POST', 'checklist', { title: 'Пункт', parentId: 2.1 }],
  ['PUT', 'checklist/x11', { complete: true }],
  ['DELETE', 'checklist/1.1', undefined],
  ['PUT', 'checklist/11', {}],
  ['PUT', 'checklist/11', { complete: 'false' }],
  ['PUT', 'checklist/11', { complete: 0 }],
  ['PUT', 'checklist/11', { title: '' }],
  ['PUT', 'checklist/11', { unknown: 1 }],
  ['PUT', 'tags', {}],
  ['PUT', 'tags', { tags: '' }],
  ['PUT', 'tags', { tags: [' '] }],
  ['PUT', 'tags', { tags: [1] }],
  ['PUT', 'tags', { tags: ['a'.repeat(101)] }],
  ['PUT', 'tags', { tags: Array(51).fill('Тег') }],
];

test('Неверные тела и номера пунктов отклоняются до адаптера', async (t) => {
  const { app, calls } = await fixture(t);

  for (const [method, path, payload] of INVALID) {
    const response = await app.inject({
      method,
      url: `/api/tracker/task/42/${path}`,
      payload,
    });

    assert.equal(response.statusCode, 400, `${method} ${path}: ${response.body}`);
    assert.equal(response.json().error, 'b24_bad_request');
  }

  assert.deepEqual(calls, []);
});

test('PUT участников принимает массивы и явную очистку, проверяет положительные id', async (t) => {
  const { app, calls } = await fixture(t);

  for (const value of ['', null, [], [7, '9']]) {
    const fields = { accomplices: value, auditors: value };
    const response = await app.inject({
      method: 'PUT',
      url: '/api/tracker/task/42',
      payload: fields,
    });
    const normalized = value === null ? '' : Array.isArray(value) ? value.map(Number) : value;

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(calls.at(-1), {
      name: 'updateTask',
      args: ['42', { accomplices: normalized, auditors: normalized }],
    });
  }

  const before = calls.length;

  for (const value of ['7', {}, [0], [-2], [1.5], [' '], [true], [null], [[7]]]) {
    for (const key of ['accomplices', 'auditors']) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/tracker/task/42',
        payload: { [key]: value },
      });

      assert.equal(response.statusCode, 400, response.body);
    }
  }

  assert.equal(calls.length, before);
});

test('Новые мутации отвергают повреждённый номер задачи до драйвера', async (t) => {
  const { app, calls } = await fixture(t);

  for (const [method, path, payload] of OPERATIONS.filter((row) => row[1] !== 'renew')) {
    const response = await app.inject({
      method,
      url: `/api/tracker/task/bad42/${path}`,
      payload,
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'b24_bad_request');
  }

  assert.deepEqual(calls, []);
});
