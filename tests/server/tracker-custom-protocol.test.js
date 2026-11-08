import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startHttpFixture } from '../tracker/helpers/httpFixture.mts';
import { trackerFixture } from './helpers/trackerFixture.js';
import { copyCustomPackage, customClientModule } from './helpers/trackerPackage.js';

const charts = Object.fromEntries(['day', 'week', 'month'].map((period) => [period, {
  labels: [`Период ${period}`],
  hours: [82.5],
  hours_dept: [80],
  tasks: [900],
  tasks_dept: [8],
  avg_time: [1.5],
  avg_time_dept: [2],
}]));
const taskHtml = `
<div id="task-detail-files"><span id="disk-attach-71" data-name="shot.png"></span></div>
<div class="task-detail-comments">
  <div id="record-TASK_42-51-cover" bx-mpl-read-status="new">
    <span class="feed-com-name">Иван</span>
    <div id="record-TASK_42-51-text">Ответ человека</div>
  </div>
</div>
bitrix:forum.comments {"params":"signed.fixture","EXEMPLAR_ID":"fixture_7"}
`;

/**
 * Новый API-токенный пакет получает настоящий loopback HTTP через свой transport seam.
 * Старая сессионная версия сохраняет отдельную проверку, а ядро не копирует ни один клиент.
 */
async function apiPortal(t) {
  let version = 1;
  const task = () => ({
    id: 42,
    title: 'Фикстура CRM',
    status: 'in_progress',
    version,
    creator: { id: 7, name: 'Автор' },
    assignee: { id: 7, name: 'Исполнитель' },
  });
  const portal = await startHttpFixture(t, (request, response) => {
    const url = new URL(request.url, 'http://fixture');
    const route = url.pathname.replace('/api/v1', '');
    let data;

    assert.equal(request.headers.authorization, 'Bearer fixture-api-token');

    if (route === '/auth/token') {
      data = { user: { id: 7 } };
    } else if (route === '/tasks' && request.method === 'GET') {
      data = url.searchParams.get('role') === 'doing' ? [task()] : [];
    } else if (route === '/tasks' && request.method === 'POST') {
      data = { ...task(), id: 43 };
    } else if (route === '/tasks/42' || route === '/tasks/42/transition') {
      if (request.method !== 'GET') {
        const body = JSON.parse(request.body.toString());

        assert.equal(body.version, version);
        version += 1;
      }

      data = task();
    } else if (route === '/subjects/task/42/comments') {
      data = request.method === 'POST' ? { id: 52 } : [{
        id: 51,
        body: 'Ответ человека',
        author: { id: 7, name: 'Автор' },
      }];
    } else if (route === '/time/active') {
      data = [];
    } else if (route === '/time/start' || route === '/time/stop') {
      data = null;
    } else {
      assert.fail(`Неожиданный маршрут CRM: ${request.method} ${request.url}`);
    }

    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data }));
  });

  return {
    ...portal,
    /**
     * HTTPS origin и запрет redirect проверяются до передачи синтетическому HTTP-серверу.
     * Остальные параметры запроса, включая AbortSignal и Bearer, сохраняются без подмены.
     */
    fetch(input, options) {
      const url = new URL(String(input));

      assert.equal(url.origin, 'https://crm.fixture');
      assert.equal(options.redirect, 'error');

      return fetch(portal.baseUrl + url.pathname + url.search, options);
    },
  };
}

/**
 * Методы нового пакета проходят тот же host-контракт с token и optimistic version.
 * Вложения и виджеты не приписываются пакету, который не объявляет эти возможности.
 */
async function checkApiClient(t, createDiscriptTracker) {
  const portal = await apiPortal(t);
  const client = createDiscriptTracker({
    credentials: { read: () => ({ baseUrl: 'https://crm.fixture', accessToken: 'fixture-api-token' }) },
  }, portal.fetch);

  t.after(() => client.dispose());
  assert.equal((await client.accountIdentity()).userId, '7');
  assert.equal((await client.taskPageData('42')).comments[0].text, 'Ответ человека');
  assert.equal((await client.createTask({
    title: 'Новая',
    responsibleId: 7,
    priority: 1,
  })).id, 43);
  assert.equal((await client.addComment('42', 'Новый ответ')).commentId, 52);
  await client.timer('start', '42');
  await client.completeTask('42');
  await client.renewTask('42');

  const writes = portal.requests.filter((request) => request.url.endsWith('/transition'));

  assert.deepEqual(writes.map((request) => JSON.parse(request.body.toString())), [
    { action: 'complete', version: 1 },
    { action: 'reopen', version: 2 },
  ]);
}

/**
 * Synthetic portal выполняет настоящий session/CSRF/upload протокол на loopback.
 * Ни глобальный fetch, ни методы клиента не подменяются, повтор add проверяется по журналу HTTP.
 */
async function customPortal(t, { emptyChart = false } = {}) {
  let authenticated = false;
  let adds = 0;
  const portal = await startHttpFixture(t, (request, response) => {
    const url = new URL(request.url, 'http://fixture');
    let result;

    if (url.searchParams.get('login') === 'yes') {
      authenticated = true;
      response.setHeader('set-cookie', 'PHPSESSID=fixture-session; Path=/');
      response.end('Вход выполнен');

      return;
    }

    if (url.pathname === '/local/ajax/notifications.php') {
      result = { success: authenticated, count: 0 };
    } else if (url.pathname === '/salary/') {
      response.setHeader('content-type', 'text/html');
      response.end(`USER_ID=7; bitrix_sessid:"abcdef1234";
        ${emptyChart ? '' : `var chartDataByPeriod = ${JSON.stringify(charts)};`}`);

      return;
    } else if (url.pathname.includes('/tasks/task/view/42/')) {
      response.setHeader('content-type', 'text/html');
      response.end(taskHtml);

      return;
    } else if (url.pathname === '/local/ajax/dashboard.php') {
      result = { data: {
        mainData: {
          worked_hours: 82.5,
          completed_tasks: 17,
          min_hours: 160
        },
        todayData: {
          hours: 2,
          tasks_count: 1,
          avg_time: 2
        },
        currentTasks: [{
          id: 42,
          title: 'Задача портала',
          status: 3
        }],
      } };
    } else if (url.pathname === '/local/ajax/task_timer.php') {
      result = { success: true, data: { saved: true } };
    } else if (url.searchParams.get('action') === 'ui.fileuploader.upload') {
      result = { status: 'success', data: { file: { serverFileId: 'n71' } } };
    } else if (url.searchParams.get('action') === 'tasks.task.add') {
      adds += 1;
      result = adds === 1
        ? { status: 'error', errors: [{ message: 'csrf expired' }] }
        : { status: 'success', data: { task: { id: 42 } } };
    } else if (url.searchParams.get('action') === 'processComment') {
      result = { status: 'success', message: 'com52' };
    } else if (['tasks.task.complete', 'tasks.task.renew'].includes(url.searchParams.get('action'))) {
      result = { status: 'success', data: { ok: true } };
    } else {
      response.writeHead(500);
      result = { error: 'unexpected_fixture_request', path: request.url };
    }

    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(result));
  });

  return portal;
}

test('CUSTOM-PROTOCOL-01: login, page, upload, create CSRF, comment, timer, complete и renew', async (t) => {
  const clientModule = await customClientModule(t);

  if (!clientModule) {
    return;
  }

  if (typeof clientModule.createDiscriptTracker === 'function') {
    await checkApiClient(t, clientModule.createDiscriptTracker);

    return;
  }

  const portal = await customPortal(t);
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-custom-client-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const { B24Client } = clientModule;
  const client = new B24Client({
    baseUrl: portal.baseUrl,
    login: 'fixture-user',
    password: 'fixture-password',
    cookiePath: path.join(root, 'cookies.json'),
  });

  await client.ensureAuth();
  assert.equal(await client.discoverUserId(), 7);

  const page = await client.taskPageData('42');

  assert.equal(page.attachments[0].name, 'shot.png');
  assert.equal(page.comments[0].text, 'Ответ человека');

  const created = await client.createTask({
    title: 'Новая',
    responsibleId: 7,
    groupId: 11,
    priority: 0,
    images: [{ name: 'shot.png', buffer: Buffer.from([137, 80, 78, 71, 1]) }],
  });

  assert.equal(created.id, 42);
  assert.equal(created.files[0].id, 'n71');
  assert.equal(portal.requests.filter((request) => request.url.includes('ui.fileuploader.upload')).length, 1);
  assert.equal(portal.requests.filter((request) => request.url.includes('tasks.task.add')).length, 2);
  assert.equal((await client.addComment('42', 'Новый ответ')).commentId, 52);
  await client.timer('start', '42');
  await client.completeTask('42');
  await client.renewTask('42');

  const stopIndex = portal.requests.findIndex((request) => request.url === '/local/ajax/task_timer.php'
    && new URLSearchParams(request.body.toString()).get('action') === 'stop');
  const completeIndex = portal.requests.findIndex((request) => request.url.includes('tasks.task.complete'));

  assert.ok(stopIndex >= 0 && stopIndex < completeIndex);
  assert.ok(portal.requests.some((request) => request.headers.cookie?.includes('fixture-session')));
});

for (const emptyChart of [false, true]) {
  test(`CUSTOM-WIDGET-01: completed_tasks и все периоды, emptyChart=${emptyChart}`, async (t) => {
    const clientModule = await customClientModule(t);

    if (!clientModule) {
      return;
    }

    if (typeof clientModule.createDiscriptTracker === 'function') {
      const portal = await apiPortal(t);
      const fixture = await trackerFixture(t, {
        fetch: portal.fetch,
        setup: async (config, context) => {
          if (!await copyCustomPackage(config, context)) {
            return false;
          }

          await mkdir(path.dirname(config.trackerCredentialsPath), { recursive: true });
          await writeFile(config.trackerCredentialsPath, JSON.stringify({
            'grigdesk-b24-discript': {
              baseUrl: 'https://crm.fixture', accessToken: 'fixture-api-token',
            },
          }));
          await writeFile(config.trackerSettingsPath, JSON.stringify({
            externalId: 'grigdesk-b24-discript', revision: 0,
          }));
        },
      });
      const snapshot = await fixture.tracker.getDashboard();

      assert.equal(snapshot.tasks.length, 1);
      assert.equal(snapshot.tasks[0].id, 42);
      assert.deepEqual(snapshot.widgets, []);

      return;
    }

    const portal = await customPortal(t, { emptyChart });
    const fixture = await trackerFixture(t, {
      setup: async (config, context) => {
        if (!await copyCustomPackage(config, context)) {
          return false;
        }

        await mkdir(path.dirname(config.trackerCredentialsPath), { recursive: true });
        await writeFile(config.trackerCredentialsPath, JSON.stringify({
          'grigdesk-b24-discript': {
            baseUrl: portal.baseUrl,
            login: 'fixture-user',
            password: 'fixture-password',
          },
        }));
        await writeFile(config.trackerSettingsPath, JSON.stringify({
          externalId: 'grigdesk-b24-discript',
          revision: 0,
        }));
      },
    });

    if (!fixture) {
      return;
    }

    const snapshot = await fixture.tracker.getDashboard();

    assert.equal(snapshot.month.completedTasks, 17);
    assert.ok(Array.isArray(snapshot.widgets), 'Dashboard драйвера содержит widgets');

    const kpis = snapshot.widgets.filter((widget) => widget.kind === 'kpi').flatMap((widget) => widget.items);
    const widgetCharts = snapshot.widgets.filter((widget) => widget.kind === 'chart');

    assert.ok(kpis.some((item) => item.value === 17 && item.format === 'count'));
    assert.ok(kpis.some((item) => item.progress?.value === 82.5 && item.progress?.max === 160));

    if (emptyChart) {
      assert.equal(widgetCharts.length, 0);
      assert.equal(snapshot.tasks.length, 1);
    } else {
      assert.equal(widgetCharts.length, 3);

      for (const period of ['day', 'week', 'month']) {
        const values = widgetCharts.flatMap((widget) => widget.periods[period].series)
          .map((series) => series.values[0]).sort((left, right) => left - right);
        const expected = ['hours', 'hours_dept', 'tasks', 'tasks_dept', 'avg_time', 'avg_time_dept']
          .map((key) => charts[period][key][0]).sort((left, right) => left - right);

        assert.deepEqual(values, expected);
      }

      for (const widget of widgetCharts) {
        assert.deepEqual(Object.keys(widget.periods).sort(), ['day', 'month', 'week']);

        for (const period of ['day', 'week', 'month']) {
          assert.equal(widget.periods[period].labels[0], `Период ${period}`);
          assert.equal(widget.periods[period].series.length, 2);
        }
      }
    }
  });
}
