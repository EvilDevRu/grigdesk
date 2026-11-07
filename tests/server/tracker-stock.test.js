import assert from 'node:assert/strict';
import test from 'node:test';

import { startHttpFixture } from '../b24/helpers/httpFixture.mts';
import { selectTracker, STOCK_CAPABILITIES, trackerFixture } from './helpers/trackerFixture.js';

import { copyStockPackage } from './helpers/trackerPackage.js';

const TOKEN = 'fixture-stock-token-private';
const task = (id, extra = {}) => ({
  id: String(id),
  title: `Облачная ${id}`,
  status: '3',
  responsibleId: '7',
  createdBy: '9',
  groupId: '11',
  group: { id: '11', name: 'Облачный проект' },
  responsible: {
    id: '7',
    name: 'Исполнитель',
    workPosition: '',
  },
  accomplices: [],
  auditors: [],
  ...extra,
});

/**
 * Облако — настоящий loopback HTTP, а разрешённый HTTPS origin переписывается только transport seam.
 * Все обращения, включая неожиданные, остаются в fixture и записываются до отправки ответа.
 */
async function stockFixture(t, {
  failure = null, failingMethod = 'tasks.task.add', completeDenied = false,
} = {}) {
  let completed = false;
  const cloud = await startHttpFixture(t, (request, response) => {
    const method = new URL(request.url, 'http://fixture').pathname.replace('/rest/', '');
    const fields = request.headers['content-type']?.includes('application/json')
      ? JSON.parse(request.body.toString())
      : Object.fromEntries(new URLSearchParams(request.body.toString()));
    let result;

    if (method === 'tasks.task.complete' && completeDenied) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: '0',
        error_description: 'Действие над задачей не разрешено',
      }));

      return;
    }

    if (method === failingMethod && failure) {
      if (failure === 'timeout') {
        return;
      }

      const cases = {
        expired: [200, { error: 'expired_token', error_description: `Token expired: ${TOKEN}` }],
        forbidden: [403, { error: 'ACCESS_DENIED' }],
        rate: [429, { error: 'QUERY_LIMIT_EXCEEDED' }],
        unavailable: [503, { error: 'SERVER_ERROR' }],
        malformed: [200, 'not json'],
        missing: [200, { result: {} }],
        absent: [200, { error: 'TASK_NOT_FOUND' }],
      };
      const [status, body] = cases[failure];

      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));

      return;
    }

    if (method === 'user.current') {
      result = {
        ID: '7',
        NAME: 'Иван',
        LAST_NAME: 'Тестовый'
      };
    } else if (method === 'tasks.task.list') {
      const firstPage = Number(fields.start || 0) === 0;
      const filter = fields.filter ?? Object.fromEntries(Object.entries(fields)
        .filter(([key]) => /^filter\[[^\]]+\]$/u.test(key))
        .map(([key, value]) => [key.slice(7, -1), value]));
      const rows = (firstPage ? [task(42)] : [task(43), task(44, { responsibleId: '99' })])
        .filter((entry) => Object.entries(filter).every(([rawKey, value]) => {
          const key = rawKey.replace(/^[=@]+/u, '');
          const roleFields = {
            RESPONSIBLE_ID: entry.responsibleId,
            CREATED_BY: entry.createdBy,
            ACCOMPLICE: entry.accomplices,
            AUDITOR: entry.auditors,
          };

          if (!Object.hasOwn(roleFields, key)) {
            return true;
          }

          const actual = roleFields[key];

          return Array.isArray(actual) ? actual.map(String).includes(String(value))
            : String(actual) === String(value);
        }));
      const next = firstPage && rows.length > 0;

      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        result: { tasks: rows },
        ...(next ? { next: 50 } : {}),
      }));

      return;
    } else if (method === 'tasks.task.get') {
      result = { task: task(42, { status: completed ? '5' : '3' }) };
    } else if (method === 'tasks.task.add') {
      result = { task: task(45) };
    } else if (method === 'tasks.task.complete') {
      completed = true;
      result = true;
    } else if (method === 'tasks.task.delete') {
      result = { task: true };
    } else if (method === 'user.get') {
      result = [{
        ID: '7',
        NAME: 'Иван',
        LAST_NAME: 'Тестовый'
      }];
    } else if (method === 'sonet_group.get') {
      result = [{ ID: '11', NAME: 'Облачный проект' }];
    } else if (method === 'task.item.gettags') {
      result = ['Релиз'];
    } else if (method === 'tasks.task.starttimer' || method === 'tasks.task.pausetimer') {
      result = true;
    } else if (method === 'task.commentitem.getlist') {
      result = [];
    } else if (method === 'task.commentitem.add') {
      result = 777;
    } else if (method === 'tasks.task.update') {
      if (Number(fields.fields?.STATUS) === 5) {
        completed = true;
      }

      result = true;
    } else {
      response.writeHead(500);
      response.end(JSON.stringify({ error: 'UNEXPECTED_METHOD' }));

      return;
    }

    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ result }));
  });
  const signals = [];
  const fixture = await trackerFixture(t, {
    setup: copyStockPackage,
    fetch: async (input, options) => {
      const url = new URL(String(input));

      assert.equal(url.origin, 'https://cloud.fixture');
      signals.push(options?.signal);

      return fetch(`${cloud.baseUrl}${url.pathname}${url.search}`, options);
    },
  });

  if (!fixture) {
    return null;
  }

  await selectTracker(fixture, 'grigdesk-b24', {
    'grigdesk-b24': {
      baseUrl: 'https://cloud.fixture',
      authMode: 'token',
      accessToken: TOKEN,
    },
  });

  return {
    ...fixture,
    cloud,
    signals
  };
}

test('STOCK-01: две страницы, создание, завершение и справочники через исходящий REST', async (t) => {
  const fixture = await stockFixture(t);

  if (!fixture) {
    return;
  }

  const dashboard = await fixture.request('GET', '/api/tracker/dashboard');

  assert.equal(dashboard.statusCode, 200, dashboard.body);
  assert.deepEqual(dashboard.json().tasks.map((entry) => Number(entry.id)), [42, 43]);
  assert.equal(dashboard.json().tasks.some((entry) => Number(entry.id) === 44), false);
  assert.equal(dashboard.json().tasks[0].group, 'Облачный проект');
  assert.equal(dashboard.json().tasks[0].responsible, 'Исполнитель');
  assert.deepEqual(dashboard.json().capabilities, STOCK_CAPABILITIES);
  assert.deepEqual(dashboard.json().widgets, []);
  assert.equal(dashboard.json().tasks[0].timerRunning, false);
  assert.equal(dashboard.json().tasks[0].timerElapsed, 0);

  const creation = {
    title: 'Новая в облаке',
    responsibleId: 7,
    groupId: 11,
    priority: 2,
  };
  const created = await fixture.request('POST', '/api/tracker/tasks', creation);

  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().id, 45);
  assert.equal((await fixture.request('POST', '/api/tracker/task/42/complete', {})).statusCode, 200);

  const detail = await fixture.request('GET', '/api/tracker/task/42');

  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().status, 5);
  assert.equal(detail.json().statusText, 'Завершена');
  assert.deepEqual((await fixture.request('GET', '/api/tracker/users?q=Иван')).json(), {
    users: [{ id: 7, name: 'Иван Тестовый' }],
  });
  assert.deepEqual((await fixture.request('GET', '/api/tracker/groups')).json(), {
    groups: [{ id: 11, name: 'Облачный проект' }],
  });

  for (const request of fixture.cloud.requests) {
    assert.equal(request.method, 'POST');
    assert.match(request.url, /^\/rest\/[a-z_]+\.[a-z.]+$/u);
    assert.equal(request.url.includes(TOKEN), false);
    assert.ok(request.body.toString().includes(TOKEN));
  }

  assert.ok(fixture.signals.every((signal) => signal instanceof AbortSignal));

  const add = fixture.cloud.requests.find((request) => request.url === '/rest/tasks.task.add');
  const body = add.body.toString();
  const parsed = add.headers['content-type']?.includes('application/json')
    ? JSON.parse(body).fields
    : Object.fromEntries(new URLSearchParams(body));
  const field = (name) => parsed[name] ?? parsed[`fields[${name}]`];

  assert.equal(field('TITLE'), creation.title);
  assert.equal(Number(field('RESPONSIBLE_ID')), creation.responsibleId);
  assert.equal(Number(field('GROUP_ID')), creation.groupId);
  assert.equal(Number(field('PRIORITY')), creation.priority);

});

for (const failure of ['expired', 'forbidden', 'rate', 'unavailable', 'malformed', 'missing', 'timeout']) {
  test(`STOCK-02: ${failure} безопасно отказывает без повтора mutation`, { timeout: 40_000 }, async (t) => {
    const fixture = await stockFixture(t, { failure });

    if (!fixture) {
      return;
    }

    const response = await fixture.request('POST', '/api/tracker/tasks', { title: 'Не повторять' });

    assert.ok(response.statusCode >= 400);
    assert.equal(response.body.includes(TOKEN), false);
    assert.equal(fixture.logs.join('').includes(TOKEN), false);
    assert.equal(fixture.cloud.requests.filter((request) =>
      request.url === '/rest/tasks.task.add').length, 1);
    assert.ok(fixture.signals.every((signal) => signal instanceof AbortSignal));
  });
}

test('STOCK-02: TASK_NOT_FOUND отличается от доступа и сети при probeTaskNumber', async (t) => {
  const cases = [['absent', 'absent'], ['forbidden', 'unknown'], ['unavailable', 'unknown']];

  for (const [failure, expected] of cases) {
    await t.test(failure, async (s) => {
      const fixture = await stockFixture(s, { failure, failingMethod: 'tasks.task.get' });

      if (!fixture) {
        return;
      }

      assert.equal(await fixture.tracker.probeTaskNumber('42'), expected);
    });
  }
});

for (const [name, method, url, payload] of [
  ['images', 'POST', '/api/tracker/tasks', { title: 'С файлом', images: [{ path: '/fixture/image.png' }] }],
  ['STOCK-03-ATTACH', 'POST', '/api/tracker/tasks', { title: 'С кадром', frames: ['shot.png'] }],
]) {
  test(`STOCK-03 / B-VIDEO-01: ${name} отклонён до сети`, async (t) => {
    const fixture = await stockFixture(t);

    if (!fixture) {
      return;
    }

    const before = fixture.cloud.requests.length;
    const response = await fixture.request(method, url, payload);

    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json().error, /unsupported/u);

    if (name === 'STOCK-03-ATTACH' || name === 'images') {
      assert.equal(response.json().error, 'attachments_unsupported');
    }

    assert.equal(fixture.cloud.requests.length, before);
  });
}

test('STOCK-04: комментарий уходит в портал и возвращается с номером', async (t) => {
  const fixture = await stockFixture(t);

  if (!fixture) {
    return;
  }

  const response = await fixture.request('POST', '/api/tracker/task/42/comment', {
    text: 'Проверено эмулятором',
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true, commentId: 777 });

  const add = fixture.cloud.requests.find((request) => request.url === '/rest/task.commentitem.add');

  assert.ok(add);
  assert.ok(add.body.toString().includes('Проверено эмулятором'));

  const tab = await fixture.request('GET', '/api/tracker/task/42/comments');

  assert.equal(tab.statusCode, 200, tab.body);
  assert.deepEqual(tab.json(), {
    comments: [],
    tags: ['Релиз'],
    subtasks: [42, 43, 44].map((id) => ({
      id,
      title: `Облачная ${id}`,
      statusText: 'В работе (таймер не идёт)',
    })),
  });
  assert.ok(fixture.cloud.requests.some((request) => request.url === '/rest/task.commentitem.getlist'));
});

test('STOCK-04: правка задачи уходит в tasks.task.update', async (t) => {
  const fixture = await stockFixture(t);

  if (!fixture) {
    return;
  }

  const response = await fixture.request('PUT', '/api/tracker/task/42', {
    title: 'Переименована эмулятором',
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(Number(response.json().id), 42);

  const update = fixture.cloud.requests.find((request) => request.url === '/rest/tasks.task.update');

  assert.ok(update);
  assert.ok(update.body.toString().includes('Переименована эмулятором'));
  assert.equal(fixture.cloud.requests.filter((request) =>
    request.url === '/rest/tasks.task.update').length, 1);
});


test('STOCK-DELETE-01: удаление через HTTP-фасад отправляет tasks.task.delete один раз', async (t) => {
  const fixture = await stockFixture(t);

  assert.ok(fixture);

  const response = await fixture.request('DELETE', '/api/tracker/task/42');
  const calls = fixture.cloud.requests.filter((request) => request.url === '/rest/tasks.task.delete');

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].body.toString()).taskId, '42');
});


test('STOCK-COMPLETE-01: отказ нового модуля завершает через STATUS=5 без повторов', async (t) => {
  const fixture = await stockFixture(t, { completeDenied: true });

  assert.ok(fixture);

  const response = await fixture.request('POST', '/api/tracker/task/42/complete');
  const actions = fixture.cloud.requests.filter((request) =>
    ['/rest/tasks.task.complete', '/rest/tasks.task.update'].includes(request.url));

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true });
  assert.deepEqual(actions.map((request) => request.url), [
    '/rest/tasks.task.complete', '/rest/tasks.task.update',
  ]);
  assert.deepEqual(JSON.parse(actions[1].body.toString()).fields, { STATUS: 5 });
  assert.equal((await fixture.request('GET', '/api/tracker/task/42')).json().status, 5);
});


test('STOCK-CARD: таймер проходит HTTP-фасад, срок принимается и снимается', async (t) => {
  const fixture = await stockFixture(t);

  assert.ok(fixture);

  for (const action of ['start', 'pause', 'stop']) {
    const response = await fixture.request('POST', `/api/tracker/task/42/timer/${action}`, {});

    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await fixture.request('GET', '/api/tracker/task/42')).json().timerRunning,
      action === 'start');
  }

  for (const deadline of ['2026-11-05T19:00:00+07:00', null]) {
    const response = await fixture.request('PUT', '/api/tracker/task/42', { deadline });

    assert.equal(response.statusCode, 200, response.body);

    const updates = fixture.cloud.requests.filter((request) => request.url === '/rest/tasks.task.update');

    assert.deepEqual(JSON.parse(updates.at(-1).body.toString()).fields, { DEADLINE: deadline });
  }

  const timerCalls = fixture.cloud.requests.filter((request) => /timer$/u.test(request.url));

  assert.deepEqual(timerCalls.map((request) => request.url), [
    '/rest/tasks.task.starttimer', '/rest/tasks.task.pausetimer', '/rest/tasks.task.pausetimer',
  ]);
});

for (const [method, path, payload, restMethod] of [
  ['POST', 'renew', {}, 'tasks.task.renew'],
  ['POST', 'approve', {}, 'tasks.task.approve'],
  ['POST', 'disapprove', {}, 'tasks.task.disapprove'],
  ['POST', 'checklist', { title: 'Пункт' }, 'task.checklistitem.add'],
  ['PUT', 'checklist/11', { title: 'Имя' }, 'task.checklistitem.update'],
  ['PUT', 'checklist/11', { complete: true }, 'task.checklistitem.complete'],
  ['PUT', 'checklist/11', { complete: false }, 'task.checklistitem.renew'],
  ['DELETE', 'checklist/11', undefined, 'task.checklistitem.delete'],
  ['PUT', 'tags', { tags: [] }, 'task.item.update'],
]) {
  test(`STOCK-CARD: ${restMethod} сохраняет 404 через границу внешнего пакета`, async (t) => {
    const fixture = await stockFixture(t, { failure: 'absent', failingMethod: restMethod });

    if (!fixture) {
      return;
    }

    const response = await fixture.request(method, `/api/tracker/task/42/${path}`, payload);

    assert.equal(response.statusCode, 404, response.body);
    assert.equal(response.json().error, 'task_not_found');
    assert.equal(fixture.cloud.requests.filter((request) => request.url.endsWith(restMethod)).length, 1);
  });
}
