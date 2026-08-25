// Редактирование основных полей задачи Битрикс24 из карточки Cockpit.
// Обновление частичное: сервер не отправляет поля, которых не было в запросе,
// а очистка описания и снятие проекта остаются значимыми изменениями.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  B24Client,
  B24ValidationError,
} from '../../server/src/lib/b24/b24-client.js';
import b24Module from '../../server/src/modules/b24/index.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

/** Собирает B24Client без сети и сохраняет единственный form-urlencoded запрос. */
function protocolClient(calls) {
  const client = Object.create(B24Client.prototype);
  client.ensureAuth = async () => {
    calls.push({ kind: 'auth' });
  };
  client.getSessid = async () => 'csrf-token';
  client.raw = async (path, options) => {
    calls.push({ kind: 'raw', path, options });
    return {
      json: async () => ({ status: 'success', data: { task: { id: 42 } } }),
    };
  };
  return client;
}

test('tasks.task.update передаёт пустое описание, снятый проект и нулевой приоритет', async () => {
  const calls = [];
  const client = protocolClient(calls);

  const result = await client.updateTask('42', {
    title: '  Новый заголовок  ',
    description: '',
    responsibleId: '17',
    groupId: null,
    priority: '0',
  });

  assert.deepEqual(result, { ok: true, id: 42 });
  const request = calls.find((call) => call.kind === 'raw');
  assert.equal(request.path, '/bitrix/services/main/ajax.php?action=tasks.task.update');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(request.options.body)), {
    taskId: '42',
    'fields[TITLE]': 'Новый заголовок',
    'fields[DESCRIPTION]': '',
    'fields[GROUP_ID]': '0',
    'fields[RESPONSIBLE_ID]': '17',
    'fields[PRIORITY]': '0',
    sessid: 'csrf-token',
  });
});

test('частичное обновление не дописывает отсутствующие поля и валидируется до сети', async () => {
  const calls = [];
  const client = protocolClient(calls);

  await client.updateTask(42, { title: 'Только заголовок' });
  const request = calls.find((call) => call.kind === 'raw');
  const params = new URLSearchParams(request.options.body);
  assert.equal(params.get('fields[TITLE]'), 'Только заголовок');
  assert.equal(params.has('fields[DESCRIPTION]'), false);
  assert.equal(params.has('fields[GROUP_ID]'), false);
  assert.equal(params.has('fields[RESPONSIBLE_ID]'), false);
  assert.equal(params.has('fields[PRIORITY]'), false);

  const before = calls.length;
  await assert.rejects(
    client.updateTask(42, { priority: 9 }),
    (error) => error instanceof B24ValidationError && error.code === 'b24_bad_request',
  );
  await assert.rejects(
    client.updateTask(42, { deadline: 'завтра' }),
    B24ValidationError,
  );
  assert.equal(calls.length, before, 'невалидные поля не должны доходить до авторизации');
});

/** Поднимает только HTTP-модуль с управляемой заглушкой портала. */
async function updateApp(t, overrides = {}) {
  const app = Fastify({ logger: false });
  const calls = [];
  const detail = {
    id: 42,
    title: 'Обновлённая задача',
    description: '',
    priority: 2,
    group_id: 7,
    responsible: { id: 17, name: 'Исполнитель' },
  };
  app.register(b24Module, {
    b24: {
      updateTask: async (id, fields) => {
        calls.push({ id, fields });
      },
      taskDetail: async () => detail,
      ...overrides,
    },
  });
  await app.ready();
  t.after(() => app.close());
  return { app, calls, detail };
}

test('PUT /api/b24/task/:id обновляет задачу и возвращает свежую карточку', async (t) => {
  const { app, calls, detail } = await updateApp(t);
  const response = await app.inject({
    method: 'PUT',
    url: '/api/b24/task/42',
    payload: {
      title: ' Обновлённая задача ',
      groupId: '7',
      responsibleId: 17,
      priority: 2,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [{
    id: '42',
    fields: {
      title: 'Обновлённая задача',
      groupId: 7,
      responsibleId: 17,
      priority: 2,
    },
  }]);
  assert.deepEqual(response.json(), detail);
});

test('PUT задачи отклоняет лишние поля как b24_bad_request до адаптера', async (t) => {
  const { app, calls } = await updateApp(t);
  const response = await app.inject({
    method: 'PUT',
    url: '/api/b24/task/42',
    payload: { title: 'Задача', deadline: 'завтра' },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'b24_bad_request');
  assert.match(response.json().message, /deadline/);
  assert.deepEqual(calls, []);
});
