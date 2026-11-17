import assert from 'node:assert/strict';

import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  EMPTY_CHAT_FILTERS, chatFilterQueryError, chatFiltersQuery, chatPageKey,
  hasChatFilters, normalizeChatFilters,
} from '../../shared/chat/chatPaging.ts';

import { ChatCatalogPaging } from '../../server/src/lib/chat/catalogPaging.ts';
import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';

import { chatPath, jsonRequest, listFixture, sampleChat } from './helpers/chat-list.js';

import { controlledExecutor, turnBody, waitFor } from './helpers/chat-turns.js';

// Контракт фильтров общий у сервера и окна: пустой набор не меняет прежние ключи.

test('FILTERS-KEY: пустые фильтры сохраняют прежний ключ страницы', () => {
  assert.equal(chatPageKey(' По ', false), chatPageKey('по', false, EMPTY_CHAT_FILTERS));

  assert.equal(chatPageKey('', true), '[true,""]');

  assert.equal(chatPageKey('', false), '[false,""]');
});

test('FILTERS-NORMALIZE: повреждённые значения откатываются к пустым фильтрам', () => {
  const restored = normalizeChatFilters({
    unread: '1',
    waiting: true,
    working: 'yes',
    task: 'abc',
    provider: 'x'.repeat(41),
    fresh: 'year',
  });

  assert.deepEqual(restored, {
    ...EMPTY_CHAT_FILTERS,
    unread: true,
    waiting: true
  });

  assert.deepEqual(normalizeChatFilters(null), EMPTY_CHAT_FILTERS);

  assert.deepEqual(normalizeChatFilters({
    task: '123',
    provider: 'qwen',
    fresh: 'week'
  }),
    {
      ...EMPTY_CHAT_FILTERS,
      task: '123',
      provider: 'qwen',
      fresh: 'week'
    });
});

test('FILTERS-QUERY: в запрос уходят только активные фильтры', () => {
  assert.deepEqual(chatFiltersQuery(EMPTY_CHAT_FILTERS), {});

  assert.deepEqual(chatFiltersQuery({
    ...EMPTY_CHAT_FILTERS,
    unread: true,
    task: '42',
    fresh: 'day'
  }),
    {
      unread: '1',
      task: '42',
      fresh: 'day'
    });

  assert.equal(hasChatFilters(EMPTY_CHAT_FILTERS), false);

  assert.equal(hasChatFilters({ ...EMPTY_CHAT_FILTERS, provider: 'kimi' }), true);
});

test('FILTERS-KEY-SCOPE: разные фильтры дают разные ключи страниц', () => {
  const unread = chatPageKey('', false, { ...EMPTY_CHAT_FILTERS, unread: true });

  const waiting = chatPageKey('', false, { ...EMPTY_CHAT_FILTERS, waiting: true });

  assert.notEqual(unread, waiting);

  assert.notEqual(unread, chatPageKey('', false));

  assert.equal(unread, chatPageKey('', false, normalizeChatFilters({ unread: '1' })));
});

test('FILTERS-VALIDATION: серверные значения проверяются до выборки', () => {
  assert.equal(chatFilterQueryError({}), false);

  assert.equal(chatFilterQueryError({
    unread: '1',
    waiting: '0',
    working: '1'
  }), false);

  assert.equal(chatFilterQueryError({ task: 'any' }), false);

  assert.equal(chatFilterQueryError({ task: 'none' }), false);

  assert.equal(chatFilterQueryError({ task: '123456789012' }), false);

  assert.equal(chatFilterQueryError({ provider: 'qwen-code_2' }), false);

  assert.equal(chatFilterQueryError({ fresh: 'month' }), false);

  for (const bad of [{ unread: '2' }, { waiting: 'true' }, { task: 'abc' },
  { task: '1234567890123' }, { provider: 'x'.repeat(41) }, { provider: 'плохой' },
  { fresh: 'year' }]) {
    assert.equal(chatFilterQueryError(bad), true, JSON.stringify(bad));
  }
});

const LIST = '/api/chat/store/list?page=1&archived=0&limit=40';

// Синтетическая шапка для unit-проверок предикатов без файлового каталога.

function head(id, extra = {}) {
  return {
    id,
    version: 'v1',
    previewSource: '',
    hasDraft: false,
    hasContent: true,
    pendingDelivery: false,
    lastReply: null,
    updatedAt: Date.now(),
    ...extra,
  };
}

/**
 * Каталог подменяется короткими проекциями: предикаты фильтров проверяются
 * без Fastify и без чтения файлов, с управляемыми waiting/working/реестром.
 */

function unitPaging(heads, { waiting = [], working = [], registry = {} } = {}) {
  const history = {
    webHeads: async () => heads,
    searchWeb: async () => [],
    registry: async () => registry,
  };

  return new ChatCatalogPaging(history, () => new Set(waiting), () => new Set(working));
}

test('FILTER-UNIT-STATE: unread/waiting/working сужают выдачу независимо', async () => {
  const heads = [
    head('h1', { unread: true }),
    head('h2'),
    head('h3'),
    head('h4'),
  ];

  const paging = unitPaging(heads, { waiting: ['h3'], working: ['h4'] });

  const unread = await paging.page({ archived: '0', unread: '1' });

  const waiting = await paging.page({ archived: '0', waiting: '1' });

  const working = await paging.page({ archived: '0', working: '1' });

  const both = await paging.page({
    archived: '0',
    unread: '1',
    waiting: '1'
  });

  assert.deepEqual(unread.sessions.map((entry) => entry.id), ['h1']);

  assert.deepEqual(waiting.sessions.map((entry) => entry.id), ['h3']);

  assert.deepEqual(working.sessions.map((entry) => entry.id), ['h4']);

  assert.deepEqual(both.sessions, []);
});

test('FILTER-UNIT-TASK: номер сравнивается строкой, any/none проверяют наличие', async () => {
  const heads = [
    head('t1', { taskId: 42 }),
    head('t2', { taskId: '42' }),
    head('t3', { taskId: null }),
    head('t4'),
  ];

  const paging = unitPaging(heads);

  const number = await paging.page({ archived: '0', task: '42' });

  const any = await paging.page({ archived: '0', task: 'any' });

  const none = await paging.page({ archived: '0', task: 'none' });

  assert.deepEqual(number.sessions.map((entry) => entry.id).sort(), ['t1', 't2']);

  assert.deepEqual(any.sessions.map((entry) => entry.id).sort(), ['t1', 't2']);

  assert.deepEqual(none.sessions.map((entry) => entry.id).sort(), ['t3', 't4']);
});

test('FILTER-UNIT-FRESH: окно считается от updatedAt, в архиве от closedAt', async (t) => {
  const now = Date.UTC(2026, 8, 1);

  t.mock.method(Date, 'now', () => now);

  const heads = [
    head('d1', { updatedAt: now - 3600e3 }),
    head('d2', { updatedAt: now - 3 * 86400e3 }),
    head('d3', { updatedAt: now - 20 * 86400e3 }),
    head('d4', { updatedAt: now - 40 * 86400e3 }),
    head('a1', {
      archived: true,
      closedAt: now - 2 * 86400e3,
      updatedAt: now - 40 * 86400e3
    }),
  ];

  const paging = unitPaging(heads);

  const day = await paging.page({ archived: '0', fresh: 'day' });

  const week = await paging.page({ archived: '0', fresh: 'week' });

  const month = await paging.page({ archived: '0', fresh: 'month' });

  const archivedWeek = await paging.page({ archived: '1', fresh: 'week' });

  assert.deepEqual(day.sessions.map((entry) => entry.id), ['d1']);

  assert.deepEqual(week.sessions.map((entry) => entry.id).sort(), ['d1', 'd2']);

  assert.deepEqual(month.sessions.map((entry) => entry.id).sort(), ['d1', 'd2', 'd3']);

  assert.deepEqual(archivedWeek.archived.map((entry) => entry.id), ['a1']);
});

test('FILTER-UNIT-PROVIDER: modelRef прямо, legacy через реестр, неизвестный не совпадает', async () => {
  const heads = [
    head('p1', { modelRef: { provider: 'qwen', model: 'm1' } }),
    head('p2', { model: 'opus' }),
    head('p3', { model: 'unknown-model' }),
  ];

  const paging = unitPaging(heads, { registry: { claude: [{ id: 'opus' }] } });

  const qwen = await paging.page({ archived: '0', provider: 'qwen' });

  const claude = await paging.page({ archived: '0', provider: 'claude' });

  const kimi = await paging.page({ archived: '0', provider: 'kimi' });

  assert.deepEqual(qwen.sessions.map((entry) => entry.id), ['p1']);

  assert.deepEqual(claude.sessions.map((entry) => entry.id), ['p2']);

  assert.deepEqual(kimi.sessions, []);
});

test('FILTER-API-UNREAD: сервер отдаёт только непрочитанные, сводка не меняется', async (t) => {
  const fixture = await listFixture(t, [
    sampleChat('u1', { unread: true, updatedAt: 300 }),
    sampleChat('u2', { updatedAt: 200 }),
    sampleChat('u3', { unread: true, updatedAt: 100 }),
  ]);

  const result = await jsonRequest(fixture.app, 'GET', `${LIST}&unread=1`);

  assert.deepEqual(result.sessions.map((entry) => entry.id), ['u1', 'u3']);

  assert.equal(result.summary.active, 3);

  assert.equal(result.filtersProtocol, 1);
});

test('FILTER-API-TASK: номер, с задачей и без задачи', async (t) => {
  const fixture = await listFixture(t, [
    sampleChat('k1', { taskId: 4920, updatedAt: 300 }),
    sampleChat('k2', { updatedAt: 200 }),
    sampleChat('k3', { taskId: '4920', updatedAt: 100 }),
  ]);

  const number = await jsonRequest(fixture.app, 'GET', `${LIST}&task=4920`);

  const any = await jsonRequest(fixture.app, 'GET', `${LIST}&task=any`);

  const none = await jsonRequest(fixture.app, 'GET', `${LIST}&task=none`);

  assert.deepEqual(number.sessions.map((entry) => entry.id), ['k1', 'k3']);

  assert.deepEqual(any.sessions.map((entry) => entry.id), ['k1', 'k3']);

  assert.deepEqual(none.sessions.map((entry) => entry.id), ['k2']);
});

test('FILTER-API-FRESH: сутки/неделя/месяц по серверному времени', async (t) => {
  const now = Date.UTC(2026, 8, 1);

  t.mock.method(Date, 'now', () => now);

  const fixture = await listFixture(t, [
    sampleChat('w1', { updatedAt: now - 3600e3 }),
    sampleChat('w2', { updatedAt: now - 3 * 86400e3 }),
    sampleChat('w3', { updatedAt: now - 20 * 86400e3 }),
    sampleChat('w4', { updatedAt: now - 40 * 86400e3 }),
  ]);

  const day = await jsonRequest(fixture.app, 'GET', `${LIST}&fresh=day`);

  const week = await jsonRequest(fixture.app, 'GET', `${LIST}&fresh=week`);

  const month = await jsonRequest(fixture.app, 'GET', `${LIST}&fresh=month`);

  assert.deepEqual(day.sessions.map((entry) => entry.id), ['w1']);

  assert.deepEqual(week.sessions.map((entry) => entry.id), ['w1', 'w2']);

  assert.deepEqual(month.sessions.map((entry) => entry.id), ['w1', 'w2', 'w3']);
});

test('FILTER-API-PROVIDER: исполнитель фильтрует через реестр фикстуры', async (t) => {
  const fixture = await listFixture(t, [
    sampleChat('e1', { updatedAt: 300 }),
    sampleChat('e2', { modelRef: { provider: 'other-provider', model: 'm' }, updatedAt: 200 }),
    sampleChat('e3', {
      model: 'unknown-model',
      modelRef: undefined,
      updatedAt: 100
    }),
  ]);

  const own = await jsonRequest(fixture.app, 'GET', `${LIST}&provider=test-provider`);

  const other = await jsonRequest(fixture.app, 'GET', `${LIST}&provider=other-provider`);

  assert.deepEqual(own.sessions.map((entry) => entry.id), ['e1']);

  assert.deepEqual(other.sessions.map((entry) => entry.id), ['e2']);
});

test('FILTER-API-COMBINE: поиск и фильтр работают в одном scope', async (t) => {
  const fixture = await listFixture(t, [
    sampleChat('c1', {
      title: 'Уникальный заголовок',
      unread: true,
      updatedAt: 300
    }),
    sampleChat('c2', { title: 'Уникальный заголовок', updatedAt: 200 }),
    sampleChat('c3', {
      title: 'Другой',
      unread: true,
      updatedAt: 100
    }),
  ]);

  const result = await jsonRequest(fixture.app, 'GET',
    `${LIST}&q=${encodeURIComponent('Уникальный')}&unread=1`);

  assert.deepEqual(result.sessions.map((entry) => entry.id), ['c1']);
});

test(
  'FILTER-API-CURSOR: продолжение только в том же наборе фильтров',
  async (t) => {
    const records = Array.from({ length: 5 }, (_, index) => sampleChat(`p${index}`, {
      unread: true,
      updatedAt: 1000 - index,
    }));

    records.push(sampleChat('plain', { updatedAt: 2000 }));

    const fixture = await listFixture(t, records);

    const first = await jsonRequest(fixture.app, 'GET',
      '/api/chat/store/list?page=1&archived=0&limit=2&unread=1');

    assert.deepEqual(first.sessions.map((entry) => entry.id), ['p0', 'p1']);

    const next = await jsonRequest(fixture.app, 'GET',
      '/api/chat/store/list?page=1&archived=0&limit=2&unread=1'
      + `&cursor=${encodeURIComponent(first.page.nextCursor)}`);

    assert.deepEqual(next.sessions.map((entry) => entry.id), ['p2', 'p3']);

    const foreign = await fixture.app.inject(
      {
        method: 'GET',
        url: '/api/chat/store/list?page=1&archived=0&limit=2'
          + `&cursor=${encodeURIComponent(first.page.nextCursor)}`,
      });

    assert.equal(foreign.statusCode, 400);
  });

test('FILTER-API-VALIDATION: неверные фильтры дают 400, working принят без ходов', async (t) => {
  const fixture = await listFixture(t, [sampleChat('v1')]);

  for (const suffix of ['&unread=2', '&waiting=true', '&task=abc', '&task=1234567890123',
    `&provider=${encodeURIComponent('плохой')}`, '&fresh=year']) {
    const response = await fixture.app.inject({ method: 'GET', url: LIST + suffix });

    assert.equal(response.statusCode, 400, suffix);
  }

  const working = await jsonRequest(fixture.app, 'GET', `${LIST}&working=1`);

  assert.deepEqual(working.sessions, []);
});

test('FILTER-TOP: top-сверка после reconnect уважает фильтры', async (t) => {
  const fixture = await listFixture(t, [
    sampleChat('top1', { unread: true, updatedAt: 300 }),
    sampleChat('top2', { updatedAt: 200 }),
  ]);

  const data = await jsonRequest(fixture.app, 'POST', '/api/chat/store/changes', {
    known: {},
    onlyKnown: true,
    top: { archived: false, unread: '1' },
  });

  assert.deepEqual(data.topHeads.map((entry) => entry.id), ['top1']);

  assert.equal(data.summary.active, 2);
});

test('FILTER-TOP-LEGACY: top без фильтров сохраняет прежнее поведение', async (t) => {
  const fixture = await listFixture(t, [
    sampleChat('old1', { updatedAt: 300 }),
    sampleChat('old2', { updatedAt: 200 }),
  ]);

  const data = await jsonRequest(fixture.app, 'POST', '/api/chat/store/changes', {
    known: {},
    onlyKnown: true,
    top: { archived: false, q: '' },
  });

  assert.deepEqual(data.topHeads.map((entry) => entry.id), ['old1', 'old2']);
});

test('FILTER-TOP-VALIDATION: неверные фильтры top дают 400', async (t) => {
  const fixture = await listFixture(t, [sampleChat('bad1')]);

  for (const top of [{ unread: '2' }, { task: 'abc' }, { fresh: 'year' }, { unknown: true }]) {
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/chat/store/changes',
      payload: {
        known: {},
        onlyKnown: true,
        top
      },
    });

    assert.equal(response.statusCode, 400, JSON.stringify(top));
  }
});

test('FILTER-API-WORKING: «работают» видит живой ход и отпускает после завершения', async (t) => {
  const control = controlledExecutor();

  const fixture = await listFixture(t, [
    sampleChat('busy1', { updatedAt: 300 }),
    sampleChat('idle1', { updatedAt: 200 }),
  ], { executor: control.executor });

  const started = await fixture.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('busy1', 'turn-working-0001'),
  });

  assert.equal(started.statusCode, 202, started.body);

  await control.waitForRuns(1);

  const working = await jsonRequest(fixture.app, 'GET', `${LIST}&working=1`);

  assert.deepEqual(working.sessions.map((entry) => entry.id), ['busy1']);

  control.runs[0].release('Готово');

  await waitFor(async () => (await jsonRequest(fixture.app, 'GET', `${LIST}&working=1`))
    .sessions.length === 0, { what: 'освобождение «работают» после завершения хода' });
});

test('PROJECT-API-IDENTITY: explicit проект виден, path и GrigDesk остаются без проекта', async (t) => {
  const project = sampleChat('scope-explicit', {
    workdir: {
      kind: 'project',
      projectId: 'alpha',
      repoKey: 'ag',
    },
    catalogProjectId: 'forged',
  });
  const fixture = await listFixture(t, [project,
    sampleChat('scope-path', { workdir: { kind: 'path', path: '/srv/alpha' } }),
    sampleChat('scope-default'),
  ]);
  const list = await jsonRequest(fixture.app, 'GET', '/api/chat/store/list?page=1&archived=0');
  const identity = Object.fromEntries(list.sessions.map((entry) => [entry.id, entry.catalogProjectId]));

  assert.deepEqual(identity, {
    'scope-explicit': 'alpha',
    'scope-path': null,
    'scope-default': null,
  });
});

test('PROJECT-TASK-TRUST: trusted task выше explicit, env PROFILE не используется', async (t) => {
  const reads = [];
  const fixture = await listFixture(t, [
    sampleChat('task-trusted', { taskId: '123',
      workdir: {
        kind: 'project',
        projectId: 'alpha',
        repoKey: null,
      } }),
    sampleChat('task-legacy', { taskId: '124' }),
  ], {
    prefs: { projects: { alpha: { repos: [] }, beta: { repos: [] } } },
    beforeChat: async (_app, { root, config }) => {
      config.profilesDir = path.join(root, 'profiles');
      await fs.mkdir(config.profilesDir, { recursive: true });
    },
    syntheticPorts: { factoryState: {
      readEnv: async () => ({ PROFILE: 'forged' }),
      readRegistry: async () => ({ registry: {} }),
      readTrustedAttempt: async (taskId) => {
        reads.push(taskId);

        return { profile: taskId === '123' ? 'beta' : 'unknown-profile' };
      },
    } },
  });
  const list = await jsonRequest(fixture.app, 'GET', '/api/chat/store/list?page=1&archived=0');

  assert.equal(list.sessions.find((entry) => entry.id === 'task-trusted').catalogProjectId, 'beta');
  assert.equal(list.sessions.find((entry) => entry.id === 'task-legacy').catalogProjectId, null);
  assert.equal(reads.includes('123'), true);
});

test('PROJECT-CATALOG-BOUNDS: дедупликация task и ограничение workers, cache и SSE', async (t) => {
  const tasks = Array.from({ length: 9 }, (_, index) => String(100 + index));
  const records = tasks.map((taskId) => sampleChat(`task-${taskId}`, { taskId }));

  records.push(sampleChat('duplicate-task', { taskId: tasks[0] }));

  const reads = [];
  let active = 0;
  let peak = 0;
  const fixture = await listFixture(t, records, {
    prefs: { projects: { beta: { repos: [] } } },
    beforeChat: async (_app, { root, config }) => {
      config.profilesDir = path.join(root, 'profiles');
      await fs.mkdir(config.profilesDir, { recursive: true });
    },
    syntheticPorts: { factoryState: {
      readEnv: async () => ({}),
      readRegistry: async () => ({ registry: {} }),
      readTrustedAttempt: async (id) => {
        reads.push(id);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;

        return { profile: 'beta' };
      },
    } },
  });

  reads.length = 0;

  const list = await jsonRequest(fixture.app, 'GET', '/api/chat/store/list?page=1&archived=0');

  assert.equal(reads.filter((id) => id === tasks[0]).length, 1);
  assert.equal(peak <= 4, true);
  assert.equal(peak > 1, true);
  assert.equal(list.sessions.every((head) => head.catalogProjectId === 'beta'), true);

  reads.length = 0;
  await jsonRequest(fixture.app, 'GET',
    '/api/chat/store/list?page=1&archived=0&q=' + encodeURIComponent('Разговор'));
  assert.equal(reads.length, tasks.length);

  reads.length = 0;
  await jsonRequest(fixture.app, 'POST', '/api/chat/store/changes', {
    known: {},
    onlyKnown: true,
    top: {
      archived: false,
      q: 'Разговор',
      project: 'beta',
    },
  });
  assert.equal(reads.length, tasks.length);

  reads.length = 0;
  peak = 0;
  await Promise.all([
    jsonRequest(fixture.app, 'GET', '/api/chat/store/list?page=1&archived=0'),
    jsonRequest(fixture.app, 'GET', '/api/chat/store/list?page=1&archived=0'),
  ]);
  assert.equal(reads.length, tasks.length * 2);
  assert.equal(peak <= 8, true);

  const file = chatPath(fixture, records[0]);
  const before = await fs.readFile(file, 'utf8');

  await jsonRequest(fixture.app, 'GET', '/api/chat/store/list?page=1&archived=0');
  assert.equal(await fs.readFile(file, 'utf8'), before);

  const restarted = new ChatHistoryStore({
    chatsDir: fixture.config.chatsDir,
    registryProvider: async () => ({ 'test-provider': [{ id: 'test-model', efforts: [] }] }),
    catalogTaskProject: async () => 'beta',
  });
  const restored = await restarted.webHeads();

  assert.equal(restored.every((head) => head.catalogProjectId === 'beta'), true);
  assert.equal(restored.find((head) => head.id === records[0].id).version,
    list.sessions.find((head) => head.id === records[0].id).version);

  const patched = await fixture.app.inject({
    method: 'PATCH',
    url: `/api/chat/store/chat/${records[0].id}`,
    payload: { patch: { title: 'Новое имя' } },
  });

  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().head.catalogProjectId, 'beta');
  await waitFor(() => fixture.events.some((event) => event.event === 'chat-store'
    && event.data.head?.title === 'Новое имя'), { what: 'SSE с project меткой' });

  const broadcast = fixture.events.findLast((event) => event.event === 'chat-store'
    && event.data.id === records[0].id);

  assert.equal(broadcast.data.head.catalogProjectId, 'beta');
});

test('PROJECT-QUERY: project входит в нормализацию, URL и ключ, @none не конфликтует с ID', () => {
  const filters = normalizeChatFilters({ project: 'alpha', unread: '1' });

  assert.equal(filters.project, 'alpha');
  assert.equal(chatFiltersQuery(filters).project, 'alpha');
  assert.notEqual(chatPageKey('', false, filters), chatPageKey('', false, { ...filters, project: 'beta' }));
  assert.notEqual(chatPageKey('', false, { project: '@none' }), chatPageKey('', false, { project: 'none' }));
  assert.equal(chatFilterQueryError({ project: '../escape' }), true);
  assert.equal(chatFilterQueryError({ project: ['alpha'] }), true);
  assert.equal(chatFilterQueryError({ project: '@none' }), false);
  assert.equal(Object.hasOwn(normalizeChatFilters({}), 'project'), false);
});

test('PROJECT-API-SCOPE: проект пересекается с поиском/unread, @none видит непривязанные', async (t) => {
  const records = [
    sampleChat('alpha-chat', {
      title: 'Общий поиск',
      unread: true,
      workdir: {
        kind: 'project',
        projectId: 'alpha',
        repoKey: null,
      },
    }),
    sampleChat('beta-chat', {
      title: 'Общий поиск',
      unread: true,
      workdir: {
        kind: 'project',
        projectId: 'beta',
        repoKey: null,
      },
    }),
    sampleChat('plain-chat', { title: 'Общий поиск' }),
  ];
  const { app } = await listFixture(t, records);
  const base = '/api/chat/store/list?page=1&archived=0';
  const filtered = await jsonRequest(app, 'GET',
    base + '&project=alpha&unread=1&q=' + encodeURIComponent('поиск'));
  const none = await jsonRequest(app, 'GET', base + '&project=%40none');

  assert.deepEqual(filtered.sessions.map((entry) => entry.id), ['alpha-chat']);
  assert.deepEqual(none.sessions.map((entry) => entry.id), ['plain-chat']);
  assert.equal(filtered.projectFiltersProtocol, 1);
  assert.equal(filtered.filtersProtocol, 1);
});

test('PROJECT-API-CURSOR: project сохраняется на второй странице и входит в scope', async (t) => {
  const records = Array.from({ length: 45 }, (_, index) => sampleChat(`alpha-${index}`, {
    updatedAt: 1000 - index,
    workdir: {
      kind: 'project',
      projectId: 'alpha',
      repoKey: null,
    },
  }));

  records.push(sampleChat('foreign-first', {
    updatedAt: 2000,
    workdir: {
      kind: 'project',
      projectId: 'beta',
      repoKey: null,
    } }));

  const { app } = await listFixture(t, records);
  const base = '/api/chat/store/list?page=1&archived=0&project=alpha';
  const first = await jsonRequest(app, 'GET', base);
  const next = await jsonRequest(app, 'GET', base + '&cursor=' + encodeURIComponent(first.page.nextCursor));
  const foreign = await app.inject(base.replace('project=alpha', 'project=beta')
    + '&cursor=' + encodeURIComponent(first.page.nextCursor));

  assert.equal(first.sessions.length, 40);
  assert.equal(next.sessions.length, 5);
  assert.equal([...first.sessions, ...next.sessions].some((entry) => entry.id === 'foreign-first'), false);
  assert.equal(foreign.statusCode, 400);
});

test('PROJECT-API-ARCHIVE-TOP: архив и top сверка используют один project', async (t) => {
  const { app } = await listFixture(t, [
    sampleChat('alpha-active', { workdir: {
      kind: 'project',
      projectId: 'alpha',
      repoKey: null,
    } }),
    sampleChat('alpha-archive', {
      archived: true,
      workdir: {
        kind: 'project',
        projectId: 'alpha',
        repoKey: null,
      } }),
    sampleChat('beta-archive', {
      archived: true,
      workdir: {
        kind: 'project',
        projectId: 'beta',
        repoKey: null,
      } }),
  ]);
  const archive = await jsonRequest(app, 'GET', '/api/chat/store/list?page=1&archived=1&project=alpha');
  const changes = await jsonRequest(app, 'POST', '/api/chat/store/changes', {
    known: {},
    onlyKnown: true,
    top: { archived: true, project: 'alpha' },
  });

  assert.deepEqual(archive.archived.map((entry) => entry.id), ['alpha-archive']);
  assert.deepEqual(changes.topHeads.map((entry) => entry.id), ['alpha-archive']);

  const invalid = await app.inject({
    method: 'POST',
    url: '/api/chat/store/changes',
    payload: {
      known: {},
      onlyKnown: true,
      top: { project: '../escape' },
    },
  });

  assert.equal(invalid.statusCode, 400);
});
test('PROJECT-API-HISTORICAL: удалённая регистрация сохраняет фильтруемую метку истории', async (t) => {
  const { app } = await listFixture(t, [sampleChat('retained', {
    workdir: {
      kind: 'project',
      projectId: 'retired',
      repoKey: null,
    },
  })], { prefs: { projectsMeta: { tombstones: {
    retired: { deletedAt: '2026-11-17T00:00:00Z', revision: 2 },
  } } } });
  const historical = await jsonRequest(app, 'GET',
    '/api/chat/store/list?page=1&archived=0&project=retired');
  const unknown = await jsonRequest(app, 'GET',
    '/api/chat/store/list?page=1&archived=0&project=unknown');
  const top = await jsonRequest(app, 'POST', '/api/chat/store/changes', {
    known: {},
    onlyKnown: true,
    top: { archived: false, project: 'retired' },
  });

  assert.deepEqual(historical.sessions.map((head) => head.id), ['retained']);
  assert.deepEqual(unknown.sessions, []);
  assert.deepEqual(top.topHeads.map((head) => head.id), ['retained']);
});
