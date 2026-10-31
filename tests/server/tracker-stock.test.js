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
  accomplices: [],
  auditors: [],
  ...extra,
});

/**
 * Облако — настоящий loopback HTTP, а разрешённый HTTPS origin переписывается только transport seam.
 * Все обращения, включая неожиданные, остаются в fixture и записываются до отправки ответа.
 */
async function stockFixture(t, { failure = null, failingMethod = 'tasks.task.add' } = {}) {
  let completed = false;
  const cloud = await startHttpFixture(t, (request, response) => {
    const method = new URL(request.url, 'http://fixture').pathname.replace('/rest/', '');
    const fields = request.headers['content-type']?.includes('application/json')
      ? JSON.parse(request.body.toString())
      : Object.fromEntries(new URLSearchParams(request.body.toString()));
    let result;

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
    } else if (method === 'user.get') {
      result = [{
        ID: '7',
        NAME: 'Иван',
        LAST_NAME: 'Тестовый'
      }];
    } else if (method === 'sonet_group.get') {
      result = [{ ID: '11', NAME: 'Облачный проект' }];
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
    'grigdesk-b24': { baseUrl: 'https://cloud.fixture', accessToken: TOKEN },
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
  assert.deepEqual(dashboard.json().capabilities, STOCK_CAPABILITIES);
  assert.deepEqual(dashboard.json().widgets, []);
  assert.equal(Object.hasOwn(dashboard.json().tasks[0], 'timerRunning'), false);

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
  ['timer', 'POST', '/api/tracker/task/42/timer/start', {}],
  ['comments', 'POST', '/api/tracker/task/42/comment', { text: 'Не поддерживается' }],
  ['editing', 'PUT', '/api/tracker/task/42', { title: 'Не менять' }],
  ['renew', 'POST', '/api/tracker/task/42/renew', {}],
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
