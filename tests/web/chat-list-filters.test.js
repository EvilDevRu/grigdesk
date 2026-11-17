import assert from 'node:assert/strict';

import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { EMPTY_CHAT_FILTERS } from '../../shared/chat/chatPaging.ts';

import { readChat, sampleChat, writeChat } from '../server/helpers/chat-list.js';

import { controlledExecutor, TEST_MODEL_REF, waitFor } from '../server/helpers/chat-turns.js';

import { serverWorld, windowApi } from './helpers/chat-lazy.js';

import { chatStoreFixture } from './helpers/chat-store.js';

import { drain } from './helpers/chat-load.js';

/**
 * Окно стора подключается к настоящему временному серверу фикстуры.
 * Журнал windowApi доказывает, какие фильтры действительно ушли на сервер.
 */

async function filterWorld(t, records, options = {}) {
  const world = await serverWorld(t, records, options);

  const network = windowApi(world.app);

  const { chat, sse } = await world.open(network);

  return {
    world,
    network,
    chat,
    sse
  };
}

test('FILTER-STORE-PARAMS: фильтры уходят в запрос и разделяют страницы', async (t) => {
  const { network, chat } = await filterWorld(t, [
    sampleChat('f-1', { unread: true, updatedAt: 300 }),
    sampleChat('f-2', { updatedAt: 200 }),
    sampleChat('f-3', { unread: true, updatedAt: 100 }),
  ]);

  const filters = { ...EMPTY_CHAT_FILTERS, unread: true };

  await chat.ensureChatPage('', false, filters);

  await drain();

  const call = network.calls.find((entry) => entry.url.includes('unread=1'));

  assert.ok(call, 'запрос страницы содержит фильтр');

  assert.deepEqual(chat.pageFor('', false, filters).ids, ['f-1', 'f-3']);

  assert.notEqual(chat.pageFor('', false), chat.pageFor('', false, filters));

  assert.equal(chat.filtersProtocol, 1);
});

test('FILTER-STORE-LIST: список показывает только строки своей фильтрованной страницы', async (t) => {
  const { chat } = await filterWorld(t, [
    sampleChat('l-1', { unread: true, updatedAt: 300 }),
    sampleChat('l-2', { updatedAt: 200 }),
  ]);

  const filters = { ...EMPTY_CHAT_FILTERS, unread: true };

  await chat.ensureChatPage('', false, filters);

  await drain();

  assert.deepEqual(chat.list('', false, filters).map((row) => row.id), ['l-1']);

  assert.deepEqual(chat.list('', false).map((row) => row.id).sort(), ['l-1', 'l-2']);
});

test('FILTER-STORE-CURSOR: продолжение фильтрованной страницы сохраняет фильтр', async (t) => {
  const records = Array.from({ length: 45 }, (_, index) => sampleChat(`cur-${index}`, {
    unread: true,
    updatedAt: 10000 - index,
  }));

  records.push(sampleChat('cur-plain', { updatedAt: 20000 }));

  const { network, chat } = await filterWorld(t, records);

  const filters = { ...EMPTY_CHAT_FILTERS, unread: true };

  await chat.ensureChatPage('', false, filters);

  await drain();

  const page = chat.pageFor('', false, filters);

  assert.equal(page.ids.length, 40);

  assert.equal(page.hasMore, true);

  await chat.loadChatPage('', false, false, filters);

  await drain();

  assert.equal(page.ids.length, 45);

  assert.equal(page.hasMore, false);

  const continuations = network.calls.filter((entry) => entry.url.includes('cursor='));

  assert.ok(continuations.length >= 1);

  assert.ok(continuations.every((entry) => entry.url.includes('unread=1')));
});

test(
  'FILTER-STORE-EXPIRED: 410-пересбор восстанавливает фильтрованную страницу с глубиной',
  async (t) => {
    const records = Array.from({ length: 85 }, (_, index) => sampleChat(`exp-${index}`, {
      unread: true,
      updatedAt: 10000 - index,
    }));

    records.push(sampleChat('exp-plain', { updatedAt: 20000 }));

    const { network, chat } = await filterWorld(t, records);

    const filters = { ...EMPTY_CHAT_FILTERS, unread: true };

    const get = network.api.get;

    let expireNextCursor = false;

    network.api.get = async (url) => {
      if (expireNextCursor && url.includes('cursor=')) {
        expireNextCursor = false;

        throw Object.assign(new Error('Истёк список'), {
          status: 410, data: { error: 'chat_page_expired' },
        });
      }

      return get(url);
    };

    await chat.ensureChatPage('', false, filters);

    await drain();

    await chat.loadChatPage('', false, false, filters);

    assert.equal(chat.pageFor('', false, filters).ids.length, 80);

    const before = network.calls.length;

    expireNextCursor = true;

    await chat.loadChatPage('', false, false, filters);

    const pageState = () => chat.pageFor('', false, filters);

    for (let i = 0; i < 300 && (pageState().needsRefresh || pageState().loading
      || pageState().ids.length < 80); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    assert.equal(pageState().needsRefresh, false, 'фильтрованная страница восстановилась сама');

    assert.equal(pageState().ids.length, 80, 'прежняя глубина фильтрованного списка вернулась');

    assert.equal(pageState().error, '', 'ошибка истёкшего cursor не осталась');

    const recovery = network.calls.slice(before);

    assert.ok(recovery.length >= 2, 'пересбор перечитал первую страницу и догрузил глубину');

    assert.ok(recovery.every((entry) => entry.url.includes('unread=1')),
      'все запросы восстановления несут фильтр');
  });

test('FILTER-STORE-ROLLBACK: открытая вкладка восстанавливает список после HTTP 400', async (t) => {
  const { network, chat } = await filterWorld(t, [
    sampleChat('rollback-unread', { unread: true }),
    sampleChat('rollback-read', { unread: false }),
  ]);

  const filters = { ...EMPTY_CHAT_FILTERS, unread: true };

  await chat.ensureChatPage('', false, filters);

  assert.equal(chat.filtersProtocol, 1);

  const get = network.api.get;

  const requests = [];

  network.api.get = async (url, options) => {
    requests.push(url);

    if (url.includes('unread=1')) {
      throw Object.assign(new Error('bad_chat_page'), { status: 400 });
    }

    const result = await get(url, options);

    const { filtersProtocol, ...oldPage } = result;

    return oldPage;
  };

  await chat.refreshChatPage('', false, filters);

  assert.equal(chat.filtersProtocol, 0, 'сброшен реальным ответом транспорта, не тестом');

  assert.equal(requests.filter((url) => url.includes('unread=1')).length, 1);

  assert.equal(requests.length, 3, 'один отказ, одна проба и штатная обычная страница');

  assert.ok(requests.slice(1).every((url) => !url.includes('cursor=')));

  assert.deepEqual([...chat.pageFor('', false).ids].sort(), ['rollback-read', 'rollback-unread']);

  assert.equal(chat.pageFor('', false).error, '');

  await chat.refreshChatPage('', false, filters);

  assert.equal(requests.filter((url) => url.includes('unread=1')).length, 1,
    'повтор со старым объектом фильтров не отправляет неподдерживаемые параметры');
});

test('FILTER-STORE-400: обычный отказ нового сервера не выключает фильтры', async (t) => {
  const { network, chat } = await filterWorld(t, [sampleChat('bad-1', { unread: true })]);

  const filters = { ...EMPTY_CHAT_FILTERS, unread: true };

  await chat.ensureChatPage('', false, filters);

  const get = network.api.get;

  let probes = 0;

  let probeFails = false;

  network.api.get = async (url, options) => {
    if (url.includes('unread=1')) {
      throw Object.assign(new Error('bad_chat_page'), { status: 400 });
    }

    probes += 1;

    if (probeFails) {
      throw new Error('offline');
    }

    return get(url, options);
  };

  await chat.refreshChatPage('', false, filters);

  assert.equal(chat.filtersProtocol, 1);

  assert.ok(chat.pageFor('', false, filters).error);

  assert.equal(probes, 1);

  probeFails = true;

  await chat.refreshChatPage('', false, filters);

  assert.equal(chat.filtersProtocol, 1);

  assert.ok(chat.pageFor('', false, filters).error);

  assert.equal(probes, 2, 'не более одной пробы на явный повтор');
});

test('FILTER-STORE-SEARCH: поиск хранит фильтры и совмещает их с запросом', async (t) => {
  const { chat } = await filterWorld(t, [
    sampleChat('s-1', {
      title: 'Уникальный заголовок',
      unread: true,
      updatedAt: 300
    }),
    sampleChat('s-2', { title: 'Уникальный заголовок', updatedAt: 200 }),
  ]);

  const filters = { ...EMPTY_CHAT_FILTERS, unread: true };

  chat.beginChatSearch('Уникальный', false, filters);

  assert.deepEqual(chat.search.filters, filters);

  await chat.searchChats('Уникальный', false, filters);

  await drain();

  assert.deepEqual(Object.keys(chat.search.matches), ['s-1']);
});

test('FILTER-STORE-REFRESH: серверное прочтение удаляет строку и сохраняет глубину', async (t) => {
  const records = Array.from({ length: 45 }, (_, index) => sampleChat(`r-${index}`, {
    unread: true,
    updatedAt: 10000 - index,
  }));

  const { world, network, chat } = await filterWorld(t, records);

  const filters = { ...EMPTY_CHAT_FILTERS, unread: true };

  await chat.searchChats('', false, filters);

  await chat.loadChatPage('', false, false, filters);

  assert.equal(chat.pageFor('', false, filters).ids.length, 45);

  await writeChat(world, {
    ...records[0],
    unread: false,
    updatedAt: 20000
  });

  const before = network.calls.length;

  await chat._refreshChatSearch();

  const page = chat.pageFor('', false, filters);

  const requests = network.calls.slice(before).filter((entry) => entry.url.includes('/list?'));

  assert.ok(requests.length >= 2, 'перечитаны первая страница и прежняя глубина');

  assert.ok(requests.every((entry) => entry.url.includes('unread=1')));

  assert.equal(page.ids.length, 44);

  assert.equal(page.ids.includes('r-0'), false);

  assert.equal(Object.hasOwn(chat.search.matches, 'r-0'), false);

  assert.equal(chat.list('', false, filters).some((row) => row.id === 'r-0'), false);

  chat.beginChatSearch('', false, EMPTY_CHAT_FILTERS);

  const idle = network.calls.length;

  await chat._refreshChatSearch();

  assert.equal(network.calls.length, idle, 'пустой scope не запускает обновление');
});

test('FILTER-STORE-REFRESH-RACE: изменение при летящем ответе не теряется', {
  timeout: 15000,
}, async (t) => {
  const records = [sampleChat('race-1', { unread: true }), sampleChat('race-2', { unread: true })];

  const { world, network, chat } = await filterWorld(t, records);

  const filters = { ...EMPTY_CHAT_FILTERS, unread: true };

  await chat.searchChats('', false, filters);

  const get = network.api.get;

  let captured = false;

  const release = Promise.withResolvers();

  let hold = true;

  t.after(() => release.resolve());

  network.api.get = async (url, options) => {
    const response = await get(url, options);

    if (hold && url.includes('unread=1')) {
      hold = false;

      captured = true;

      await release.promise;
    }

    return response;
  };

  const refreshing = chat._refreshChatSearch();

  await waitFor(() => captured, { timeoutMs: 2000, what: 'GET обновления с unread=1' });

  await writeChat(world, {
    ...records[0],
    unread: false,
    updatedAt: Date.now()
  });

  const repeated = chat._refreshChatSearch();

  release.resolve();

  await Promise.all([refreshing, repeated]);

  assert.deepEqual(chat.pageFor('', false, filters).ids, ['race-2']);

  assert.deepEqual(Object.keys(chat.search.matches), ['race-2']);
});

test('FILTER-STORE-RESYNC: top-сверка передаёт активные фильтры', async (t) => {
  const { network, chat } = await filterWorld(t, [
    sampleChat('rs-1', { unread: true, updatedAt: 300 }),
    sampleChat('rs-2', { updatedAt: 200 }),
  ]);

  const filters = { ...EMPTY_CHAT_FILTERS, unread: true };

  await chat.searchChats('', false, filters);

  await drain();

  const before = network.calls.length;

  await chat._resyncPagedStore();

  await drain();

  const change = network.calls.slice(before).find((entry) => entry.url === '/api/chat/store/changes');

  assert.ok(change, 'сверка после reconnect выполнена');

  assert.equal(change.body.top.unread, '1');

  assert.equal(change.body.top.archived, false);
});

test('FILTER-STORE-MEMBERSHIP: архив/возврат не заселяет фильтрованную страницу', async (t) => {
  const { chat } = await filterWorld(t, [
    sampleChat('m-1', { unread: true, updatedAt: 300 }),
    sampleChat('m-2', { unread: true, updatedAt: 200 }),
  ]);

  const filters = { ...EMPTY_CHAT_FILTERS, unread: true };

  await chat.ensureChatPage('', false, filters);

  await drain();

  const page = chat.pageFor('', false, filters);

  assert.deepEqual(page.ids, ['m-1', 'm-2']);

  chat.deleteChat('m-1');

  await chat._writeChat('m-1');

  await drain();

  assert.equal(page.ids.includes('m-1'), false);

  chat.restoreArchived('m-1');

  await chat._writeChat('m-1');

  await drain();

  assert.equal(page.ids.includes('m-1'), false);

  assert.equal(page.overlayIds.includes('m-1'), false);

  assert.ok(chat.pageFor('', false).overlayIds.includes('m-1'));
});

test('FILTER-STORE-HEAD-EVENT: full/dirty шапка обновляет членство через SSE', async (t) => {
  for (const mode of ['full', 'dirty']) {
    await t.test(mode, async (t) => {
      const record = sampleChat(`head-${mode}`, { unread: true });

      const { world, network, chat, sse } = await filterWorld(t, [record]);

      const filters = { ...EMPTY_CHAT_FILTERS, unread: true };

      if (mode === 'full') {
        await chat.ensureChatMessages(record.id);

        assert.equal(chat.isChatMessagesLoaded(record.id), true);
      } else {
        chat._find(record.id).title = 'Местный черновик названия';
      }

      await chat.searchChats('', false, filters);

      assert.deepEqual(chat.pageFor('', false, filters).ids, [record.id]);

      await writeChat(world, {
        ...record,
        unread: false,
        revision: 4
      });

      const { head } = await network.api.get(`/api/chat/store/head/${record.id}`);

      const before = network.calls.length;

      sse('chat-store', {
        id: record.id,
        archived: false,
        head,
        origin: 'другое-окно',
        at: 1
      });

      await waitFor(() => chat.pageFor('', false, filters).ids.length === 0, {
        what: 'SSE удалил прочитанный чат из фильтрованной страницы',
      });

      assert.ok(network.calls.slice(before).some((entry) => entry.url.includes('unread=1')));

      assert.equal(Object.hasOwn(chat.search.matches, record.id), false);

      assert.equal(chat.list('', false, filters).length, 0);

      if (mode === 'dirty') {
        assert.equal(chat._find(record.id).title, 'Местный черновик названия');
      }
    });
  }
});

test('FILTER-STORE-RUNTIME: waiting/working меняют выдачу без chat-store', async (t) => {
  for (const kind of ['waiting', 'working', 'ssh', 'db']) {
    await t.test(kind, async (t) => {
      const record = sampleChat(`runtime-${kind}`);

      const { network, chat, sse } = await filterWorld(t, [record]);

      const filter = kind === 'working' ? 'working' : 'waiting';

      const filters = { ...EMPTY_CHAT_FILTERS, [filter]: true };

      const get = network.api.get;

      let matches = false;

      let filterRequests = 0;

      // Этот тест проверяет клиентскую проводку SSE, а не серверный предикат.
      // Транспорт возвращает управляемую серверную страницу с неизменной шапкой.

      network.api.get = async (url, options) => {
        if (!url.includes(`${filter}=1`)) {
          return get(url, options);
        }

        filterRequests += 1;

        const plain = url.replace(`&${filter}=1`, '');

        const response = await get(plain, options);

        return { ...response, sessions: matches ? response.sessions : [] };
      };

      await chat.searchChats('', false, filters);

      assert.equal(chat.list('', false, filters).length, 0);

      const before = filterRequests;

      matches = true;

      if (kind === 'waiting') {
        sse('chat-question', {
          pid: 'filter-question',
          chatKey: record.id,
          questions: [{ question: 'Продолжить?', options: [] }],
          at: 1,
        });
      } else if (kind === 'ssh' || kind === 'db') {
        sse(`${kind}-permission`, { pid: 'filter-question' });
      } else {
        sse('chat-turn-start', { chatKey: record.id, at: 1 });
      }

      await waitFor(() => chat.pageFor('', false, filters).ids.includes(record.id), {
        what: `${kind}: строка вошла по runtime-событию`,
      });

      assert.ok(filterRequests > before);

      matches = false;

      sse(filter === 'waiting' ? 'chat-permission-done' : 'chat-done',
        filter === 'waiting' ? { pid: 'filter-question' } : { chatKey: record.id });

      await waitFor(() => chat.pageFor('', false, filters).ids.length === 0, {
        what: `${kind}: строка вышла по runtime-событию`,
      });

      assert.equal(Object.keys(chat.search.matches).length, 0);

      const after = filterRequests;

      sse('chat-progress', { chatKey: record.id, tokens: 10 });

      await drain();

      assert.equal(filterRequests, after, 'поток token/progress не перечитывает фильтр');
    });
  }
});

test(
  'FILTER-STORE-OWN-READ: window ACK удаляет прочитанный чат из unread',
  async (t) => {
    const record = sampleChat('own-read', { unread: true });

    const { world, network, chat } = await filterWorld(t, [record]);

    const filters = { ...EMPTY_CHAT_FILTERS, unread: true };

    await chat.ensureChatMessages(record.id);

    assert.ok(chat._find(record.id).historyWindow);

    await chat.searchChats('', false, filters);

    assert.deepEqual(chat.pageFor('', false, filters).ids, [record.id]);

    const before = network.calls.length;

    t.mock.method(chat, '_visible', () => true);

    chat.markRead(record.id);

    await chat._writeChat(record.id);

    await waitFor(() => !chat.pageFor('', false, filters).ids.includes(record.id), {
      what: 'успешное собственное прочтение обновило unread-выборку',
    });

    assert.ok(network.calls.slice(before).some((entry) => entry.url.includes('unread=1')));

    assert.equal(chat.list('', false, filters).length, 0);

    assert.equal(Object.hasOwn(chat.search.matches, record.id), false);

    const saved = await readChat(world, record);

    assert.equal(saved.unread, false);

    assert.deepEqual(saved.messages.map((entry) => entry.text), record.messages.map((entry) => entry.text));
  });

test(
  'FILTER-STORE-RECONNECT-ROLLBACK: POST top 400 не обрывает совместимое восстановление',
  async (t) => {
    const { network, chat } = await filterWorld(t, [
      sampleChat('top-unread', { unread: true }),
      sampleChat('top-read', { unread: false }),
    ]);

    const filters = { ...EMPTY_CHAT_FILTERS, unread: true };

    await chat.searchChats('', false, filters);

    localStorage.setItem('chat.list.filters', JSON.stringify(filters));

    const get = network.api.get;

    const post = network.api.post;

    const reconcileDeliveries = chat._reconcileDeliveries.bind(chat);

    const stages = [];

    let rejectedTop = 0;

    network.api.post = async (url, body, options) => {
      if (url === '/api/chat/store/changes' && body.top?.unread) {
        rejectedTop += 1;

        stages.push('top-400');

        throw Object.assign(new Error('bad_chat_page'), { status: 400 });
      }

      if (url === '/api/chat/store/reconcile') {
        stages.push('pending');
      }

      return post(url, body, options);
    };

    network.api.get = async (url, options) => {
      if (url.includes('/api/chat/store/list?')) {
        if (url.includes('unread=1')) {
          throw Object.assign(new Error('bad_chat_page'), { status: 400 });
        }

        stages.push('plain-page');

        const { filtersProtocol, ...oldPage } = await get(url, options);

        return oldPage;
      }

      if (url === '/api/chat/active') {
        stages.push('active');
      }

      return get(url, options);
    };

    t.mock.method(chat, '_reconcileDeliveries', async () => {
      stages.push('deliveries');

      return reconcileDeliveries();
    });

    await chat._afterReconnect();

    assert.equal(rejectedTop, 1);

    assert.equal(chat.filtersProtocol, 0);

    assert.deepEqual(chat.search.filters, EMPTY_CHAT_FILTERS);

    assert.deepEqual([...chat.pageFor('', false).ids].sort(), ['top-read', 'top-unread']);

    assert.equal(JSON.parse(localStorage.getItem('chat.list.filters')).unread, true);

    assert.ok(stages.indexOf('pending') > stages.indexOf('plain-page'));

    assert.ok(stages.indexOf('active') > stages.indexOf('pending'));

    assert.ok(stages.indexOf('deliveries') > stages.indexOf('active'));
  });

test('PROJECT-STORE-SCOPE: проект получает отдельную страницу и метку строки', async (t) => {
  const { chat } = await filterWorld(t, [
    sampleChat('alpha', { workdir: {
      kind: 'project',
      projectId: 'alpha',
      repoKey: null,
    } }),
    sampleChat('beta', { workdir: {
      kind: 'project',
      projectId: 'beta',
      repoKey: null,
    } }),
  ]);
  const filters = { ...EMPTY_CHAT_FILTERS, project: 'alpha' };

  assert.equal(chat.projectFiltersProtocol, 1);
  await chat.ensureChatPage('', false, filters);
  assert.deepEqual(chat.list('', false, filters).map((row) => [row.id, row.catalogProjectId]),
    [['alpha', 'alpha']]);
  assert.notEqual(chat.pageFor('', false, filters), chat.pageFor('', false));
});

test('PROJECT-STORE-ISOLATION: выбор project не меняет открытый чат и его папку', async (t) => {
  const { chat } = await filterWorld(t, [
    sampleChat('selected', { workdir: {
      kind: 'project',
      projectId: 'beta',
      repoKey: null,
    } }),
    sampleChat('other', { workdir: {
      kind: 'project',
      projectId: 'alpha',
      repoKey: null,
    } }),
  ]);

  chat.selectChat('selected');
  await chat.ensureChatMessages('selected');

  const selected = chat._find('selected');
  const folder = JSON.stringify(selected.workdir);
  const messages = selected.messages;

  selected.draft = 'Несохранённый текст';
  await chat.ensureChatPage('', false, { ...EMPTY_CHAT_FILTERS, project: 'alpha' });

  assert.equal(chat.activeId, 'selected');
  assert.equal(JSON.stringify(selected.workdir), folder);
  assert.equal(selected.messages === messages, true);
  assert.equal(selected.draft, 'Несохранённый текст');
  assert.equal(chat.list('', false).find((row) => row.id === 'selected').catalogProjectId, 'beta');
});

test('PROJECT-STORE-ROLLBACK: старый сервер снимает только project после доказанной пробы', async (t) => {
  const { network, chat } = await filterWorld(t, [
    sampleChat('unread-a', { unread: true,
      workdir: {
        kind: 'project',
        projectId: 'alpha',
        repoKey: null,
      } }),
    sampleChat('unread-b', { unread: true }), sampleChat('read', { unread: false }),
  ]);
  const filters = {
    ...EMPTY_CHAT_FILTERS,
    project: 'alpha',
    unread: true,
  };

  await chat.searchChats('', false, filters);

  const original = network.api.get;
  const urls = [];

  network.api.get = async (url, options) => {
    urls.push(url);

    if (new URL(url, 'http://fixture.test').searchParams.has('project')) {
      throw Object.assign(new Error('old_project_filter'), { status: 400 });
    }

    const data = await original(url, options);
    const { projectFiltersProtocol, ...legacy } = data;

    return legacy;
  };
  await chat.refreshChatPage('', false, filters);

  assert.equal(chat.filtersProtocol, 1);
  assert.equal(chat.projectFiltersProtocol, 0);
  assert.equal(chat.search.filters.unread, true);
  assert.equal(chat.search.filters.project ?? '', '');
  assert.deepEqual(chat.list('', false, { ...EMPTY_CHAT_FILTERS, unread: true }).map((row) => row.id).sort(),
    ['unread-a', 'unread-b']);
  assert.equal(urls.filter((url) => url.includes('project=')).length, 1);
});

test('PROJECT-STORE-ERROR: недоступная проба не выдаёт сетевой отказ за откат', async (t) => {
  const { network, chat } = await filterWorld(t, [sampleChat('one', {
    workdir: {
      kind: 'project',
      projectId: 'alpha',
      repoKey: null,
    },
  })]);
  const filters = { ...EMPTY_CHAT_FILTERS, project: 'alpha' };

  await chat.ensureChatPage('', false, filters);
  network.api.get = async () => {
    throw Object.assign(new Error('Сеть недоступна'), { status: 500 });
  };
  await chat.refreshChatPage('', false, filters);

  assert.equal(chat.projectFiltersProtocol, 1);
  assert.deepEqual(chat.pageFor('', false, filters).ids, ['one']);
  assert.notEqual(chat.pageFor('', false, filters).error, '');
});

test('PROJECT-STORE-410: пересбор истёкшего cursor сохраняет project и глубину', async (t) => {
  const records = Array.from({ length: 85 }, (_, index) => sampleChat(`project-exp-${index}`, {
    updatedAt: 10000 - index,
    workdir: {
      kind: 'project',
      projectId: 'alpha',
      repoKey: null,
    },
  }));

  records.push(sampleChat('foreign-exp', { updatedAt: 20000 }));

  const { network, chat } = await filterWorld(t, records);
  const filters = { ...EMPTY_CHAT_FILTERS, project: 'alpha' };
  const original = network.api.get;
  let expire = false;

  network.api.get = async (url, options) => {
    if (expire && url.includes('cursor=')) {
      expire = false;

      throw Object.assign(new Error('Истёк список'), { status: 410 });
    }

    return original(url, options);
  };
  await chat.ensureChatPage('', false, filters);
  await chat.loadChatPage('', false, false, filters);
  assert.equal(chat.pageFor('', false, filters).ids.length, 80);

  const start = network.calls.length;

  expire = true;
  await chat.loadChatPage('', false, false, filters);
  await waitFor(() => {
    const page = chat.pageFor('', false, filters);

    return !page.loading && !page.needsRefresh && page.ids.length === 80;
  }, { what: 'пересбор проекта с прежней глубиной' });

  assert.equal(chat.pageFor('', false, filters).ids.includes('foreign-exp'), false);
  assert.equal(network.calls.slice(start).filter((call) => call.url.includes('/store/list?'))
    .every((call) => call.url.includes('project=alpha')), true);
});

test('PROJECT-STORE-RACE: поздняя alpha не подменяет выбранную beta', async (t) => {
  const { network, chat } = await filterWorld(t, [
    sampleChat('scope-a', { workdir: {
      kind: 'project',
      projectId: 'alpha',
      repoKey: null,
    } }),
    sampleChat('scope-b', { workdir: {
      kind: 'project',
      projectId: 'beta',
      repoKey: null,
    } }),
  ]);
  const original = network.api.get;
  let release;

  network.api.get = async (url, options) => {
    const data = await original(url, options);

    if (url.includes('project=alpha')) {
      return new Promise((resolve) => {
        release = () => resolve(data);
      });
    }

    return data;
  };

  const first = chat.searchChats('', false, { ...EMPTY_CHAT_FILTERS, project: 'alpha' });

  await waitFor(() => typeof release === 'function', { what: 'удержанная страница alpha' });
  await chat.searchChats('', false, { ...EMPTY_CHAT_FILTERS, project: 'beta' });
  release();
  await first;

  assert.equal(chat.search.filters.project, 'beta');
  assert.deepEqual(chat.list('', false, chat.search.filters).map((row) => row.id), ['scope-b']);
});

test('PROJECT-STORE-LEGACY-DELTA: ресинк со старой дельтой сохраняет обычные фильтры', async (t) => {
  const { network, chat } = await filterWorld(t, [
    sampleChat('unread-a', { unread: true }),
    sampleChat('unread-b', { unread: true }),
    sampleChat('read', { unread: false }),
  ]);
  const originalGet = network.api.get;
  const originalPost = network.api.post;

  network.api.get = async (url, options) => {
    const data = await originalGet(url, options);
    const { projectFiltersProtocol, ...legacy } = data;

    return legacy;
  };
  network.api.post = async (url, body, options) => {
    const data = await originalPost(url, body, options);

    if (url === '/api/chat/store/changes') {
      const { filtersProtocol, projectFiltersProtocol, ...legacy } = data;

      return legacy;
    }

    return data;
  };

  const filters = { ...EMPTY_CHAT_FILTERS, unread: true };

  await chat.searchChats('', false, filters);

  assert.equal(chat.filtersProtocol, 1);
  assert.equal(chat.projectFiltersProtocol, 0);

  const { watch } = await import('../../web/node_modules/vue/index.mjs');
  const transitions = [];
  const stopFilters = watch(() => chat.filtersProtocol, (value) => transitions.push(['filters', value]),
    { flush: 'sync' });
  const stopProjects = watch(() => chat.projectFiltersProtocol,
    (value) => transitions.push(['project', value]), { flush: 'sync' });

  t.after(() => {
    stopFilters();
    stopProjects();
  });
  await chat._resyncPagedStore();

  assert.deepEqual(transitions, []);
  assert.equal(chat.filtersProtocol, 1);
  assert.equal(chat.projectFiltersProtocol, 0);
  assert.equal(chat.search.filters.unread, true);
  assert.deepEqual(chat.list('', false, chat.search.filters).map((row) => row.id).sort(),
    ['unread-a', 'unread-b']);
});

test('PROJECT-STORE-STALE-TOP: поздний changes не возвращает capability после отката', async (t) => {
  const { network, chat } = await filterWorld(t, [sampleChat('old-top', {
    unread: true,
    workdir: {
      kind: 'project',
      projectId: 'alpha',
      repoKey: null,
    },
  })]);
  const filters = {
    ...EMPTY_CHAT_FILTERS,
    unread: true,
    project: 'alpha',
  };

  await chat.searchChats('', false, filters);

  const originalPost = network.api.post;
  const originalGet = network.api.get;
  let release;

  network.api.post = async (url, body, options) => {
    const data = await originalPost(url, body, options);

    if (url === '/api/chat/store/changes') {
      return new Promise((resolve) => {
        release = () => resolve(data);
      });
    }

    return data;
  };

  const resync = chat._resyncPagedStore();

  await waitFor(() => typeof release === 'function', { what: 'удержанная top сверка' });
  network.api.get = async (url, options) => {
    if (url.includes('project=')) {
      throw Object.assign(new Error('old_project_filter'), { status: 400 });
    }

    const data = await originalGet(url, options);
    const { projectFiltersProtocol, ...legacy } = data;

    return legacy;
  };
  await chat.refreshChatPage('', false, filters);
  assert.equal(chat.projectFiltersProtocol, 0);

  const { watch } = await import('../../web/node_modules/vue/index.mjs');
  const transitions = [];
  const stop = watch(() => chat.projectFiltersProtocol, (value) => transitions.push(value),
    { flush: 'sync' });

  t.after(stop);
  release();
  await resync;

  assert.equal(transitions.includes(1), false);

  assert.equal(chat.projectFiltersProtocol, 0);
  assert.equal(chat.filtersProtocol, 1);
  assert.equal(chat.search.filters.project ?? '', '');
  assert.equal(chat.search.filters.unread, true);

  const start = network.calls.length;

  await chat.searchChats('', false, filters);
  assert.equal(network.calls.slice(start).some((call) => call.url.includes('project=')), false);
});

test('PROJECT-STORE-REACTIVE-HEAD: computed полной dirty строки замечает новую метку', async (t) => {
  const { chat, world } = await filterWorld(t, [sampleChat('reactive-project', {
    workdir: {
      kind: 'project',
      projectId: 'alpha',
      repoKey: null,
    },
  })]);

  await chat.ensureChatMessages('reactive-project');

  const session = chat._find('reactive-project');
  const { computed } = await import('../../web/node_modules/vue/index.mjs');

  session.draft = 'Несохранённый текст';

  const rows = computed(() => chat.list('', false));

  assert.equal(rows.value.find((row) => row.id === session.id).catalogProjectId, 'alpha');

  const response = await world.app.inject('/api/chat/store/head/reactive-project');

  assert.equal(response.statusCode, 200);
  chat._applyChatHead({ ...response.json().head, catalogProjectId: 'beta' }, false);

  assert.equal(rows.value.find((row) => row.id === session.id).catalogProjectId, 'beta');
  assert.equal(session.draft, 'Несохранённый текст');
  assert.equal(session.workdir.projectId, 'alpha');
});

test('PROJECT-STORE-CREATE: новый свободный черновик сразу виден в своём project scope', async (t) => {
  const { chat } = await filterWorld(t, []);
  const filters = { ...EMPTY_CHAT_FILTERS, project: 'alpha' };

  await chat.searchChats('', false, filters);

  const id = chat.newSession({ workdir: {
    kind: 'project',
    projectId: 'alpha',
    repoKey: null,
  } });

  assert.notEqual(id, null);
  assert.equal(chat.list('', false, filters).some((row) => row.id === id), true);
  assert.equal(chat.list('', false, { ...EMPTY_CHAT_FILTERS, project: 'beta' })
    .some((row) => row.id === id), false);
  assert.equal(chat._find(id).workdir.projectId, 'alpha');
});

/**
 * Только временные каталоги и синтетический исполнитель: AI-ход не запускается.
 * Отсутствующий alpha проверяет штатный fallback, beta остаётся доступным проектом.
 */
function projectWorldOptions(missingAlpha = false) {
  const prefs = { projects: {} };
  const control = controlledExecutor();

  return {
    prefs,
    executor: { ...control.executor, workdir: { switch: 'resume', roots: 'multi' } },
    beforeChat: async (_app, { root, config }) => {
      config.profilesDir = path.join(root, 'profiles');
      await fs.mkdir(config.profilesDir, { recursive: true });

      for (const id of ['alpha', 'beta']) {
        const dir = path.join(root, id);

        if (id !== 'alpha' || !missingAlpha) {
          await fs.mkdir(dir, { recursive: true });
        }

        prefs.projects[id] = {
          title: id,
          repos: [{ key: 'code', dir }],
          defaultRepoKey: 'code',
        };
      }
    },
  };
}

test('PROJECT-STORE-CREATE-FALLBACK: implicit alpha после preview становится @none без утечки', async (t) => {
  const { chat, world } = await filterWorld(t, [], projectWorldOptions(true));
  const alpha = { ...EMPTY_CHAT_FILTERS, project: 'alpha' };
  const none = { ...EMPTY_CHAT_FILTERS, project: '@none' };

  chat.defModelRef = { ...TEST_MODEL_REF };
  chat.defModel = TEST_MODEL_REF.model;
  chat.defWorkdir = {
    kind: 'project',
    projectId: 'alpha',
    repoKey: null,
  };
  await chat.searchChats('', false, alpha);

  const id = chat.newSession();
  const session = chat._find(id);

  assert.equal(chat.list('', false, alpha).some((row) => row.id === id), true);
  await chat._initializeWorkdir(session);
  assert.deepEqual(session.workdir, { kind: 'grigdesk' });
  assert.equal(chat.list('', false, alpha).some((row) => row.id === id), false);
  await chat._saveChatNow(session);
  await chat._refreshChatSearch();
  await chat.refreshChatPage('', false, alpha);
  await chat.ensureChatPage('', false, none);

  const serverAlpha = await world.app.inject('/api/chat/store/list?page=1&archived=0&project=alpha');
  const serverNone = await world.app.inject('/api/chat/store/list?page=1&archived=0&project=%40none');

  assert.equal(serverAlpha.statusCode, 200);
  assert.equal(serverNone.statusCode, 200);
  assert.equal(serverAlpha.json().sessions.some((head) => head.id === id), false);
  assert.equal(serverNone.json().sessions.some((head) => head.id === id), true);
  assert.equal(chat.list('', false, alpha).some((row) => row.id === id), false);
  assert.equal(chat.list('', false, none).some((row) => row.id === id), true);
});

test('PROJECT-STORE-CREATE-MOVE: подтверждённый переход alpha → beta не оставляет draft в alpha',
  async (t) => {
  const { chat, world } = await filterWorld(t, [], projectWorldOptions());
  const alpha = { ...EMPTY_CHAT_FILTERS, project: 'alpha' };
  const beta = { ...EMPTY_CHAT_FILTERS, project: 'beta' };

  chat.defModelRef = { ...TEST_MODEL_REF };
  chat.defModel = TEST_MODEL_REF.model;
  await chat.searchChats('', false, alpha);

  const id = chat.newSession({ workdir: {
    kind: 'project',
    projectId: 'alpha',
    repoKey: null,
  } });
  const session = chat._find(id);

  assert.equal(chat.list('', false, alpha).some((row) => row.id === id), true);
  await chat._initializeWorkdir(session);
  await chat._saveChatNow(session);
  assert.equal(await chat.proposeWorkdir(id, {
    taskId: null,
    workdir: {
      kind: 'project',
      projectId: 'beta',
      repoKey: null,
    },
  }), true);
  await chat._refreshChatSearch();
  await chat.refreshChatPage('', false, alpha);
  await chat.ensureChatPage('', false, beta);

  const serverAlpha = await world.app.inject('/api/chat/store/list?page=1&archived=0&project=alpha');
  const serverBeta = await world.app.inject('/api/chat/store/list?page=1&archived=0&project=beta');

  assert.equal(serverAlpha.statusCode, 200);
  assert.equal(serverBeta.statusCode, 200);
  assert.equal(serverAlpha.json().sessions.some((head) => head.id === id), false);
  assert.equal(serverBeta.json().sessions.some((head) => head.id === id), true);
  assert.equal(chat.list('', false, alpha).some((row) => row.id === id), false);
  assert.equal(chat.list('', false, beta).some((row) => row.id === id), true);
});

test('PROJECT-STORE-CREATE-ACK-GAP: сохранённый черновик виден до прихода головы', async (t) => {
  const { chat } = await filterWorld(t, [], projectWorldOptions());
  const alpha = { ...EMPTY_CHAT_FILTERS, project: 'alpha' };

  chat.defModelRef = { ...TEST_MODEL_REF };
  chat.defModel = TEST_MODEL_REF.model;
  await chat.searchChats('', false, alpha);

  const id = chat.newSession({ workdir: {
    kind: 'project',
    projectId: 'alpha',
    repoKey: null,
  } });
  const session = chat._find(id);

  await chat._initializeWorkdir(session);
  session.title = 'Сохранённый разговор';
  await chat._saveChatNow(session);

  assert.equal(Number(session.revision) >= 1, true);
  assert.equal(chat.list('', false, alpha).some((row) => row.id === id), true);

  await chat._refreshChatSearch();
  await chat.refreshChatPage('', false, alpha);

  assert.equal(chat.list('', false, alpha).some((row) => row.id === id), true);
});

test('PROJECT-STORE-NONE-HEADONLY: head-only проектных чатов нет в «Без проекта»', async (t) => {
  const { chat } = await filterWorld(t, [
    sampleChat('alpha-head', { workdir: {
      kind: 'project',
      projectId: 'alpha',
      repoKey: null,
    } }),
    sampleChat('plain-head'),
  ]);
  const alpha = { ...EMPTY_CHAT_FILTERS, project: 'alpha' };
  const none = { ...EMPTY_CHAT_FILTERS, project: '@none' };

  await chat.searchChats('', false, alpha);
  await chat.ensureChatPage('', false, none);

  assert.deepEqual(chat.list('', false, none).map((row) => row.id), ['plain-head']);
  assert.deepEqual(chat.list('', false, alpha).map((row) => row.id), ['alpha-head']);
});
