import assert from 'node:assert/strict';

import test from 'node:test';

import { EMPTY_CHAT_FILTERS } from '../../shared/chat/chatPaging.ts';

import { readChat, sampleChat, writeChat } from '../server/helpers/chat-list.js';

import { waitFor } from '../server/helpers/chat-turns.js';

import { serverWorld, windowApi } from './helpers/chat-lazy.js';

import { chatStoreFixture } from './helpers/chat-store.js';

import { drain } from './helpers/chat-load.js';

/**
 * Окно стора подключается к настоящему временному серверу фикстуры.
 * Журнал windowApi доказывает, какие фильтры действительно ушли на сервер.
 */

async function filterWorld(t, records) {
  const world = await serverWorld(t, records);

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
