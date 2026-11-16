import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { trackerCalls } from './helpers/trackerFixture.js';
import { driverContext, generationHeader, multiFixture, saveMulti } from './helpers/trackerMulti.js';

const OPERATIONS = [
  ['GET', 'dashboard', undefined, 'getDashboard'],
  ['GET', 'task/42', undefined, 'taskDetail'],
  ['PUT', 'task/42', { title: 'Изменено' }, 'updateTask'],
  ['GET', 'task/42/comments', undefined, 'taskPageData'],
  ['POST', 'task/42/comment', { text: 'Комментарий' }, 'addComment'],
  ['POST', 'task/42/timer/start', undefined, 'timer'],
  ['POST', 'task/42/complete', undefined, 'completeTask'],
  ['POST', 'task/42/renew', undefined, 'renewTask'],
  ['POST', 'task/42/checklist', { title: 'Пункт' }, 'addChecklistItem'],
  ['PUT', 'task/42/checklist/11', { complete: true }, 'updateChecklistItem'],
  ['DELETE', 'task/42/checklist/11', undefined, 'deleteChecklistItem'],
  ['PUT', 'task/42/tags', { tags: ['Тег'] }, 'updateTaskTags'],
  ['POST', 'task/42/approve', undefined, 'approveTask'],
  ['POST', 'task/42/disapprove', undefined, 'disapproveTask'],
  ['GET', 'users?q=Иван', undefined, 'findUsers'],
  ['GET', 'groups', undefined, 'listGroups'],
  ['POST', 'tasks', { title: 'Создано' }, 'createTask'],
  ['DELETE', 'task/42', undefined, 'deleteTask'],
];

for (const [method, suffix, payload, operation] of OPERATIONS) {
  test(`MD-TARGET: ${method} ${suffix} направлен только A при default B`, async (t) => {
    const fixture = await multiFixture(t);
    const response = await fixture.request(method, `/api/tracker/fixture-a/${suffix}`, payload);

    assert.equal(response.statusCode, 200, response.body);

    const a = await trackerCalls(fixture.config, 'fixture-a');
    const b = await trackerCalls(fixture.config, 'fixture-b');

    assert.equal(a.filter((call) => call.method === operation).length, 1);
    assert.deepEqual(b, []);

    if (suffix.startsWith('task/42')) {
      const effect = a.find((call) => call.method === operation);

      if (operation === 'timer') {
        assert.deepEqual(effect.args.slice(0, 2), ['start', '42']);
      } else {
        assert.equal(effect.args[0], '42');
      }
    }

    if (method === 'PUT' && suffix === 'task/42') {
      assert.equal(response.json().title, 'fixture-a');
      assert.equal(a.filter((call) => call.method === 'taskDetail').length, 1);
    }
  });
}

test('MD-TARGET: JSON board выбирается до поколения и не попадает в пакет', async (t) => {
  const fixture = await multiFixture(t);
  const a = await driverContext(fixture, 'fixture-a');
  const response = await fixture.request('POST', '/api/tracker/tasks', {
    board: 'fixture-a',
    title: 'Явная цель',
  }, generationHeader(a));

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual((await trackerCalls(fixture.config, 'fixture-a'))
    .filter((call) => call.method === 'createTask').map((call) => call.args), [[{ title: 'Явная цель' }]]);

  const conflict = await fixture.request('POST', '/api/tracker/fixture-b/tasks', {
    board: 'fixture-a',
    title: 'Конфликт',
  });

  assert.equal(conflict.statusCode, 400, conflict.body);
  assert.equal(conflict.json().error, 'tracker_target_conflict');
  assert.deepEqual(await trackerCalls(fixture.config, 'fixture-b'), []);
});

test('MD-TOKEN: поколение A переживает смену B, старое A запрещает эффект', async (t) => {
  const fixture = await multiFixture(t);
  const a = await driverContext(fixture, 'fixture-a');

  assert.equal((await saveMulti(fixture, ['fixture-a', 'fixture-b'], 'fixture-b', {
    'fixture-b': { endpoint: 'https://changed-b.fixture' },
  })).statusCode, 200);
  assert.equal((await fixture.request('POST', '/api/tracker/fixture-a/task/42/comment', {
    text: 'A не менялся',
  }, generationHeader(a))).statusCode, 200);
  assert.equal((await saveMulti(fixture, ['fixture-a', 'fixture-b'], 'fixture-b', {
    'fixture-a': { endpoint: 'https://changed-a.fixture' },
  })).statusCode, 200);

  for (const suffix of ['task/42/comment', 'tasks']) {
    const response = await fixture.request('POST', `/api/tracker/fixture-a/${suffix}`, {
      text: 'Старый A',
      title: 'Старый A',
    }, generationHeader(a));

    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'tracker_context_changed');
  }

  assert.equal((await trackerCalls(fixture.config, 'fixture-a'))
    .filter((call) => ['createTask', 'addComment'].includes(call.method)).length, 1);

  for (const generation of ['', '-1', '1.2', '1e3', '9007199254740993']) {
    const malformed = await fixture.request('POST', '/api/tracker/fixture-a/task/42/comment', {
      text: 'Неправильное поколение',
    }, { 'x-grigdesk-tracker-generation': generation });

    assert.equal(malformed.statusCode, 409, malformed.body);
  }
});

test('MD-TARGET: JSON board B проверяет поколение B при default A до эффекта', async (t) => {
  const fixture = await multiFixture(t);
  const b = await driverContext(fixture, 'fixture-b');
  const selected = await saveMulti(fixture, ['fixture-a', 'fixture-b'], 'fixture-a');

  assert.equal(selected.statusCode, 200, selected.body);

  const response = await fixture.request('POST', '/api/tracker/tasks', {
    board: 'fixture-b',
    title: 'Цель B',
  }, generationHeader(b));

  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await saveMulti(fixture, ['fixture-a', 'fixture-b'], 'fixture-a', {
    'fixture-b': { endpoint: 'https://changed-b.fixture' },
  })).statusCode, 200);

  const stale = await fixture.request('POST', '/api/tracker/tasks', {
    board: 'fixture-b',
    title: 'Устаревшая цель B',
  }, generationHeader(b));

  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal((await trackerCalls(fixture.config, 'fixture-b'))
    .filter((call) => call.method === 'createTask').length, 1);
  assert.equal((await trackerCalls(fixture.config, 'fixture-a'))
    .filter((call) => call.method === 'createTask').length, 0);
});

test('MD-ROUTES: допустимый driverId task не перехватывает старый task/42', async (t) => {
  const fixture = await multiFixture(t, { ids: ['task', 'fixture-b'] });

  for (const [url, title] of [
    ['/api/tracker/task/42', 'fixture-b'],
    ['/api/tracker/task/task/42', 'task'],
  ]) {
    const response = await fixture.request('GET', url);

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().title, title);
  }

  assert.equal((await fixture.request('GET', '/api/tracker/task/users')).statusCode, 200);
});

test('MD-REFUSAL: неизвестная и отключённая цель не перенаправляются в default', async (t) => {
  const fixture = await multiFixture(t);

  assert.equal((await saveMulti(fixture, ['fixture-b'], 'fixture-b')).statusCode, 200);

  for (const [id, status] of [['unknown-driver', 404], ['fixture-a', 409]]) {
    const response = await fixture.request('POST', `/api/tracker/${id}/tasks`, { title: 'Отказ' });

    assert.equal(response.statusCode, status, response.body);
    assert.match(response.json().message, new RegExp(id));
  }

  assert.deepEqual(await trackerCalls(fixture.config, 'fixture-b'), []);
});

test('MD-AUTH: адресные чтения и записи закрыты общим auth', async (t) => {
  const fixture = await multiFixture(t);

  for (const [method, suffix, payload] of OPERATIONS) {
    const response = await fixture.app.inject({
      method,
      url: `/api/tracker/fixture-a/${suffix}`,
      payload,
    });

    assert.equal(response.statusCode, 401, `${method} ${suffix}`);
  }

  assert.deepEqual(await trackerCalls(fixture.config, 'fixture-a'), []);
});

test('MD-ID: адресный PROJ-123 не превращается в числовую задачу', async (t) => {
  const fixture = await multiFixture(t);

  for (const method of ['GET', 'PUT', 'DELETE']) {
    const response = await fixture.request(method, '/api/tracker/fixture-a/task/PROJ-123',
      method === 'PUT' ? { title: 'Не записывать' } : undefined);

    assert.equal(response.statusCode, 400, response.body);
  }

  assert.deepEqual(await trackerCalls(fixture.config, 'fixture-a'), []);
});

test('OWN-REMOVE-BARRIER-DEFAULT: создание не меняет сохранённый выбор B', async (t) => {
  const fixture = await multiFixture(t);
  const file = fixture.config.trackerSettingsPath;
  const before = await readFile(file, 'utf8');

  for (const url of ['/api/tracker/fixture-a/tasks', '/api/tracker/tasks']) {
    const response = await fixture.request('POST', url, { title: 'Внешняя задача' });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal(fixture.runtime.selection.read().default, 'fixture-b');
  }

  for (const id of ['fixture-a', 'fixture-b']) {
    const effects = (await trackerCalls(fixture.config, id)).filter((call) => call.method === 'createTask');

    assert.equal(effects.length, 1, id);
    assert.deepEqual(effects[0].args, [{ title: 'Внешняя задача' }]);
  }

  await saveMulti(fixture, ['fixture-b'], 'fixture-b');

  const disabledBytes = await readFile(file, 'utf8');

  for (const [id, status] of [['fixture-a', 409], ['unknown-driver', 404]]) {
    const response = await fixture.request('POST', `/api/tracker/${id}/tasks`, { title: 'Отказ' });

    assert.equal(response.statusCode, status, response.body);
    assert.equal(await readFile(file, 'utf8'), disabledBytes);
  }

  assert.equal((await trackerCalls(fixture.config, 'fixture-b'))
    .filter((call) => call.method === 'createTask').length, 1);
});
