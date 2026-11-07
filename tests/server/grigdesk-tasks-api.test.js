import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { TASK_INPUT, ownTask, seedTasks, tasksFixture } from './helpers/grigdesk-tasks.js';

const headers = { 'x-grigdesk-token': 'test-task-token' };

test('LOCAL-API-01: создание без Б24 сохраняет задачу, список и деталь после рестарта', async (t) => {
  const fx = await tasksFixture(t);
  const response = await fx.create();

  assert.equal(response.statusCode, 201, response.body);

  const { task, revision } = response.json();

  assert.equal(task.source, 'grigdesk');
  assert.match(task.id, /^[1-9]\d{11}$/);
  assert.equal(task.description, TASK_INPUT.description);
  assert.equal(task.projectId, 'beta');
  assert.equal(task.sourceUrl, `${TASK_INPUT.clientOrigin}/#/board?openTask=${task.id}`);
  assert.equal(revision, 1);

  const projects = await fx.app.inject({ url: '/api/grigdesk-tasks/projects', headers });

  assert.equal(projects.statusCode, 200, projects.body);
  assert.deepEqual(projects.json().projects, fx.projects.map(({ id, title }) => ({ id, title })));
  assert.deepEqual(fx.portalCalls, []);
  assert.deepEqual(fx.enqueued, []);
  assert.deepEqual(fx.probes, []);

  const restarted = await tasksFixture(t, { root: fx.root });
  const list = await restarted.app.inject({ url: '/api/grigdesk-tasks', headers });
  const detail = await restarted.app.inject({ url: `/api/grigdesk-tasks/${task.id}`, headers });

  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().trackerConfigured, false);
  assert.equal(list.json().tasks[0].id, task.id);
  assert.equal('description' in list.json().tasks[0], false);
  assert.deepEqual(detail.json(), task);
  assert.equal(await readFile(fx.config.grigdeskTasksPath, 'utf8').then(JSON.parse)
    .then((document) => document.revision), 1);
});

test('LOCAL-API-02: неверные поля, origin и недоступные проекты не сохраняются', async (t) => {
  const fx = await tasksFixture(t);

  for (const patch of [
    { title: '   ' }, { id: '42' }, { sourceUrl: 'https://forged.test/' }, { attachments: [] },
    { projectId: 'missing' }, { clientOrigin: 'http://client.test/path' },
    { clientOrigin: 'https://user:password@client.test' },
  ]) {
    const response = await fx.create({ ...TASK_INPUT, ...patch });

    assert.equal(response.statusCode, 400, JSON.stringify(patch) + response.body);
  }

  for (const patch of [{ archivedAt: '2026-10-01' }, { profile: { present: false } }, { routes: [] }]) {
    Object.assign(fx.projects[1], patch);

    const response = await fx.create();

    assert.ok([400, 409].includes(response.statusCode), response.body);
    Object.assign(fx.projects[1], {
      archivedAt: null,
      profile: { present: true },
      routes: ['feature']
    });
  }

  const list = await fx.app.inject({ url: '/api/grigdesk-tasks', headers });

  assert.equal(list.statusCode, 200, list.body);
  assert.deepEqual(list.json().tasks, []);
});

test('LOCAL-DETAIL-01: собственная запись и сбой хранилища не вызывают Б24', async (t) => {
  const fx = await tasksFixture(t, { configured: true });
  const task = ownTask();

  await seedTasks(fx.config, [task]);

  const detail = await fx.app.inject({ url: `/api/grigdesk-tasks/${task.id}`, headers });

  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json(), task);
  await writeFile(fx.config.grigdeskTasksPath, '{битый документ');

  const failed = await fx.app.inject({ url: `/api/grigdesk-tasks/${task.id}`, headers });

  assert.equal(failed.statusCode, 503, failed.body);
  assert.deepEqual(fx.portalCalls, []);
  assert.deepEqual(fx.probes, []);
});

test('LOCAL-DETAIL-02: отсутствие собственной записи даёт точный 404 без Б24', async (t) => {
  const fx = await tasksFixture(t, { configured: true });
  const response = await fx.app.inject({ url: '/api/grigdesk-tasks/42', headers });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, 'grigdesk_task_not_found');
  assert.deepEqual(fx.portalCalls, []);
  assert.deepEqual(fx.probes, []);
});

test('LOCAL-AUTH-01: новые чтения и создание требуют авторизации', async (t) => {
  const fx = await tasksFixture(t, { authenticated: false });

  for (const url of ['/api/grigdesk-tasks', '/api/grigdesk-tasks/projects', '/api/grigdesk-tasks/42']) {
    const response = await fx.app.inject({ url });

    assert.equal(response.statusCode, 401, response.body);
  }

  const response = await fx.app.inject({
    method: 'POST',
    url: '/api/grigdesk-tasks',
    payload: TASK_INPUT
  });

  assert.equal(response.statusCode, 401, response.body);
});
