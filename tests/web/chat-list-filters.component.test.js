import assert from 'node:assert/strict';

import { after, before, test } from 'node:test';

import { EMPTY_CHAT_FILTERS } from '../../shared/chat/chatPaging.ts';

import { api } from '../../web/src/shared/apiClient.ts';

import { readChat, sampleChat, writeChat } from '../server/helpers/chat-list.js';

import { waitFor } from '../server/helpers/chat-turns.js';

import { serverWorld, windowApi } from './helpers/chat-lazy.js';

import { chatStoreFixture } from './helpers/chat-store.js';

import { compileVue, webFile } from './helpers/compile-vue.js';

import { installUiBrowser } from './helpers/ui-components.js';

import { drain } from './helpers/chat-load.js';

let vue;

let locale;

let mount;

let ChatList;

before(
  async () => {
    await installUiBrowser({ after: (cleanup) => after(cleanup) });

    vue = await import('../../web/node_modules/vue/index.mjs');

    locale = await import('../../web/src/services/locale.ts');

    ({ mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'));

    globalThis.__filtersConnected = vue.ref(true);

    globalThis.__filtersLocale = locale;

    // Locale-стаб образца: бандл компонента делит тот же инстанс переводчика,
    // иначе setUiLocale('ru') не управлял бы языком внутри compileVue.

    const localeStub = `export const {
    t, messageRef, resolveUiText, uiLocale, setUiLocale, snapshotText, locales,
  } = globalThis.__filtersLocale;`;

    const sseStub = `
    export const useSse = () => ({ connected: globalThis.__filtersConnected });
    export const sseSubscribe = () => () => {};
  `;

    ChatList = await compileVue(
      webFile('src/views/chat/ChatList.vue'),
      {
        stubs: {
          '../../stores/chat.ts': 'export const useChatStore = () => globalThis.__filtersChat;',
          '../../stores/providers.ts':
            'export const useProvidersStore = () => globalThis.__filtersProviders;',
          './useSse.ts': sseStub,
          './useSse': sseStub,
          '../../composables/useSse.ts': sseStub,
          './services/locale.ts': localeStub,
          '../services/locale.ts': localeStub,
          '../../shared/ProviderIcon.vue': 'export default { template: "<i />" };',
        },
      });
  });

/**
 * Компонент получает реактивную копию стора: фильтры и scope записываются
 * в журнал вызовов, строки фильтруются так же, как их отдаёт сервер.
 */

async function fixture(t, initial = {}, liveChat = null) {
  locale.setUiLocale('ru');

  // Как у соседних тестов ChatList: без мока useChatSleeping при каждом mount
  // гоняет настоящий retry-путь apiClient (побочный сетевой эффект).

  t.mock.method(api, 'get', async () => ({ sessions: [] }));

  const calls = { search: [], page: [] };

  const rows = [
    {
      id: 'c-1',
      title: 'Первый',
      snippet: 'сниппет',
      ts: 300,
      model: '',
      unread: true,
      waiting: false,
      archived: false,
      draft: false,
      sending: false,
      compacting: false,
      taskId: 4920
    },
    {
      id: 'c-2',
      title: 'Второй',
      snippet: 'сниппет',
      ts: 200,
      model: '',
      unread: false,
      waiting: false,
      archived: false,
      draft: false,
      sending: false,
      compacting: false,
      taskId: null
    },
    {
      id: 'c-3',
      title: 'Архивный',
      snippet: 'сниппет',
      ts: 100,
      model: '',
      unread: false,
      waiting: false,
      archived: true,
      draft: false,
      sending: false,
      compacting: false,
      taskId: null
    },
  ];

  const page = vue.reactive({
    ids: [],
    overlayIds: [],
    nextCursor: null,
    hasMore: false,
    loaded: true,
    loading: false,
    error: '',
    needsRefresh: false,
    scrollTop: 0,
  });

  const state = vue.reactive({
    loaded: true,
    loading: false,
    loadError: null,
    activeId: '',
    pagingEnabled: true,
    filtersProtocol: 1,
    archived: rows.filter((row) => row.archived),
    search: {
      query: '',
      archived: false,
      filters: { ...EMPTY_CHAT_FILTERS },
      loading: false,
      error: '',
      matches: {}
    },
    get archivedChatCount() {
      return this.archived.length;
    },
    pageFor(query = '', archived = false, filters = EMPTY_CHAT_FILTERS) {
      calls.page.push([query, archived, filters]);

      return page;
    },
    beginChatSearch(query, archived = false, filters = EMPTY_CHAT_FILTERS) {
      this.search = {
        query: query.trim(),
        archived,
        filters,
        loading: false,
        error: '',
        matches: {}
      };
    },
    async searchChats(query, archived = false, filters = EMPTY_CHAT_FILTERS) {
      calls.search.push([query, archived, filters]);

      this.search = {
        query: query.trim(),
        archived,
        filters,
        loading: false,
        error: '',
        matches: {}
      };
    },
    ensureChatPage() { },
    loadChatPage() { },
    refreshChatPage() { },
    retryChatPage() { },
    list(query = '', archived = false, filters = EMPTY_CHAT_FILTERS) {
      return rows.filter((row) => row.archived === archived
        && (!filters.unread || row.unread)
        && (!filters.waiting || row.waiting)
        && (!filters.task || (filters.task === 'any' ? row.taskId != null
          : filters.task === 'none' ? row.taskId == null : String(row.taskId) === filters.task)));
    },
    retryLoad() { },
    newSession() {
      rows.push({
        ...rows[0],
        id: 'new-chat',
        title: 'Новый чат',
        unread: false,
        archived: false
      });

      return 'new-chat';
    },
    selectChat() { },
    renameChat() { },
    deleteChat() { },
    restoreArchived() { },
    ...initial,
  });

  globalThis.__filtersChat = liveChat || state;

  globalThis.__filtersProviders = {
    load() { },
    modelOf() {
      return { model: null, provider: null };
    },
    providers: [{ id: 'qwen', name: 'Qwen' }, { id: 'claude', name: 'Claude' }],
  };

  const wrapper = mount(ChatList, { attachTo: document.body });

  t.after(() => {
    wrapper.unmount();

    delete globalThis.__filtersChat;

    delete globalThis.__filtersProviders;

    localStorage.removeItem('chat.list.filters');

    localStorage.removeItem('chat.list.scope');
  });

  await drain();

  return {
    wrapper,
    state: liveChat || state,
    calls,
    page
  };
}

test('FILTER-UI-CONTROLS: тумблера нет, сегмент и кнопка фильтров на месте', async (t) => {
  const { wrapper } = await fixture(t);

  assert.equal(wrapper.find('.archive-toggle').exists(), false);

  assert.equal(wrapper.find('[data-option-value="active"]').exists(), true);

  assert.equal(wrapper.find('[data-option-value="archived"]').exists(), true);

  const toggle = wrapper.find('[data-chat-filter-toggle]');

  assert.equal(toggle.exists(), true);

  assert.equal(toggle.attributes('aria-expanded'), 'false');

  await toggle.trigger('click');

  await drain();

  assert.equal(toggle.attributes('aria-expanded'), 'true');

  assert.ok(wrapper.find('#chat-list-filters').classes().includes('expanded'));
});

test('FILTER-UI-UNREAD: кнопка включает и снимает серверный фильтр и счётчик', async (t) => {
  const { wrapper, calls } = await fixture(t);

  await wrapper.find('[data-chat-filter-toggle]').trigger('click');

  await wrapper.find('button[data-chat-filter="unread"]').trigger('click');

  await drain();

  const last = calls.search.at(-1);

  assert.equal(last[2].unread, true);

  assert.equal(wrapper.find('.filter-count').text(), '1');

  assert.deepEqual(wrapper.findAll('.row').map((row) => row.attributes('data-chat-id')), ['c-1']);

  const unread = wrapper.find('button[data-chat-filter="unread"]');

  assert.equal(unread.attributes('aria-pressed'), 'true');

  await unread.trigger('click');

  await drain();

  assert.equal(unread.attributes('aria-pressed'), 'false');

  assert.equal(calls.search.at(-1)[2].unread, false);

  assert.equal(wrapper.find('.filter-count').exists(), false);

  assert.equal(wrapper.find('[data-chat-filter-reset]').attributes('disabled'), '');
});

test('FILTER-UI-SCOPE: сегмент переключает архив и показывает счётчик', async (t) => {
  const { wrapper, calls } = await fixture(t);

  assert.ok(wrapper.find('[data-option-value="archived"]').text().includes('1'));

  await wrapper.find('[data-option-value="archived"]').trigger('click');

  await drain();

  const last = calls.search.at(-1);

  assert.equal(last[1], true);

  assert.deepEqual(wrapper.findAll('.row').map((row) => row.attributes('data-chat-id')), ['c-3']);
});

test('FILTER-UI-SCOPE-PERSIST: область восстанавливается и запоминается', async (t) => {
  localStorage.setItem('chat.list.scope', 'archived');

  const { wrapper, calls } = await fixture(t);

  assert.equal(calls.search[0][1], true, 'область восстановлена из localStorage');

  assert.deepEqual(wrapper.findAll('.row').map((row) => row.attributes('data-chat-id')), ['c-3']);

  await wrapper.find('[data-option-value="active"]').trigger('click');

  await drain();

  assert.equal(localStorage.getItem('chat.list.scope'), 'active');

  t.mock.method(localStorage, 'setItem', () => {
    throw new Error('приватный режим');
  });

  await wrapper.find('[data-option-value="archived"]').trigger('click');

  await drain();

  assert.deepEqual(wrapper.findAll('.row').map((row) => row.attributes('data-chat-id')), ['c-3'],
    'сбой записи не ломает переключение области');
});

test('FILTER-UI-TASK: номер приоритетнее режима, ввод с debounce и очисткой', async (t) => {
  const { wrapper, calls } = await fixture(t);

  t.mock.timers.enable({ apis: ['setTimeout'] });

  await wrapper.find('[data-chat-filter-toggle]').trigger('click');

  await wrapper.find('select[data-chat-filter="task-mode"]').setValue('none');

  t.mock.timers.tick(250);

  await drain();

  assert.equal(calls.search.at(-1)[2].task, 'none');

  await wrapper.find('input[data-chat-filter="task-number"]').setValue('49a20');

  t.mock.timers.tick(250);

  await drain();

  assert.equal(calls.search.at(-1)[2].task, '4920');

  assert.deepEqual(wrapper.findAll('.row').map((row) => row.attributes('data-chat-id')), ['c-1']);
});

test('FILTER-UI-SELECTS: исполнитель и свежесть уходят в фильтры', async (t) => {
  const { wrapper, calls } = await fixture(t);

  await wrapper.find('[data-chat-filter-toggle]').trigger('click');

  await wrapper.find('select[data-chat-filter="provider"]').setValue('qwen');

  await drain();

  assert.equal(calls.search.at(-1)[2].provider, 'qwen');

  await wrapper.find('select[data-chat-filter="fresh"]').setValue('week');

  await drain();

  const last = calls.search.at(-1)[2];

  assert.equal(last.provider, 'qwen');

  assert.equal(last.fresh, 'week');

  assert.equal(wrapper.find('.filter-count').text(), '2');
});

test('FILTER-UI-CHIPS-RESET: чипы убирают по одному, сброс очищает всё', async (t) => {
  const { wrapper, calls } = await fixture(t);

  await wrapper.find('[data-chat-filter-toggle]').trigger('click');

  await wrapper.find('button[data-chat-filter="unread"]').trigger('click');

  await wrapper.find('select[data-chat-filter="fresh"]').setValue('day');

  await drain();

  assert.equal(wrapper.findAll('[data-chat-chip]').length, 0, 'открытая панель не дублирует выбор чипами');

  await wrapper.find('[data-chat-filter-toggle]').trigger('click');

  await drain();

  assert.equal(wrapper.findAll('[data-chat-chip]').length, 2);

  await wrapper.findAll('[data-chat-chip] .chip-x')[0].trigger('click');

  await drain();

  assert.equal(calls.search.at(-1)[2].unread, false);

  assert.equal(wrapper.findAll('[data-chat-chip]').length, 1);

  await wrapper.find('[data-chat-filter-toggle]').trigger('click');

  await wrapper.find('[data-chat-filter-reset]').trigger('click');

  await drain();

  assert.deepEqual(calls.search.at(-1)[2], { ...EMPTY_CHAT_FILTERS });

  assert.equal(wrapper.findAll('[data-chat-chip]').length, 0);
});

test('FILTER-UI-EMPTY: пустая выдача предлагает сброс', async (t) => {
  const { wrapper } = await fixture(t, { list: () => [] });

  await wrapper.find('[data-chat-filter-toggle]').trigger('click');

  await wrapper.find('button[data-chat-filter="unread"]').trigger('click');

  await drain();

  assert.ok(wrapper.text().includes('Ничего не найдено по фильтрам'));

  await wrapper.find('.none [data-chat-filter-reset]').trigger('click');

  await drain();

  assert.equal(wrapper.find('.filter-chips').exists(), false);
});

test('FILTER-UI-PERSIST: выбор восстанавливается и переживает сбой записи', async (t) => {
  localStorage.setItem('chat.list.filters', JSON.stringify({ unread: true, task: '4920' }));

  const { wrapper, calls } = await fixture(t);

  assert.equal(calls.search[0][2].unread, true);

  assert.equal(calls.search[0][2].task, '4920');

  assert.equal(wrapper.find('.filter-count').text(), '2');

  await wrapper.find('button[data-chat-filter="waiting"]').trigger('click');

  await drain();

  assert.equal(JSON.parse(localStorage.getItem('chat.list.filters')).waiting, true);

  t.mock.method(localStorage, 'setItem', () => {
    throw new Error('приватный режим');
  });

  await wrapper.find('button[data-chat-filter="working"]').trigger('click');

  await drain();

  assert.equal(calls.search.at(-1)[2].working, true);
});

test('FILTER-UI-PERSIST-BROKEN: повреждённый JSON откатывается к пустым фильтрам', async (t) => {
  localStorage.setItem('chat.list.filters', '{сломанный json');

  const { calls } = await fixture(t);

  assert.deepEqual(calls.search[0][2], { ...EMPTY_CHAT_FILTERS });
});

test('FILTER-UI-NEW-CHAT: создание чата сбрасывает фильтры', async (t) => {
  const { wrapper, calls } = await fixture(t);

  await wrapper.find('[data-chat-filter-toggle]').trigger('click');

  await wrapper.find('button[data-chat-filter="unread"]').trigger('click');

  await drain();

  await wrapper.find('.new').trigger('click');

  await drain();

  assert.deepEqual(calls.search.at(-1)[2], { ...EMPTY_CHAT_FILTERS });

  assert.equal(wrapper.find('[data-chat-id="new-chat"]').exists(), true);
});

test(
  'FILTER-UI-OLD-SERVER: без filtersProtocol кнопка скрыта, сохранённые фильтры не применяются',
  async (t) => {
    localStorage.setItem('chat.list.filters', JSON.stringify({ unread: true }));

    const { wrapper, calls } = await fixture(t, { filtersProtocol: 0 });

    assert.equal(wrapper.find('[data-chat-filter-toggle]').exists(), false);

    assert.equal(wrapper.find('[data-option-value="archived"]').exists(), true);

    assert.ok(calls.search.length >= 1);

    assert.ok(calls.search.every(([, , filters]) => !filters.unread),
      'старый сервер не получает фильтры: список работает как прежде');

    assert.deepEqual(wrapper.findAll('.row').map((row) => row.attributes('data-chat-id')), ['c-1', 'c-2']);
  });

test(
  'FILTER-UI-PROTOCOL-GATE: фильтры применяются после подтверждения протокола и снимаются при потере',
  async (t) => {
    localStorage.setItem('chat.list.filters', JSON.stringify({ unread: true }));

    const { wrapper, state, calls } = await fixture(t, { filtersProtocol: 0 });

    assert.ok(calls.search.every(([, , filters]) => !filters.unread),
      'до подтверждения протокола фильтры не отправляются');

    state.filtersProtocol = 1;

    await drain();

    assert.equal(calls.search.at(-1)[2].unread, true,
      'после подтверждения восстановленный фильтр применён');

    assert.equal(wrapper.find('.filter-count').text(), '1');

    state.filtersProtocol = 0;

    await drain();

    assert.deepEqual(calls.search.at(-1)[2], { ...EMPTY_CHAT_FILTERS },
      'при потере протокола фильтры сброшены, список работает как прежде');

    assert.equal(wrapper.find('[data-chat-filter-toggle]').exists(), false);

    assert.equal(JSON.parse(localStorage.getItem('chat.list.filters')).unread, true,
      'сохранённый набор не затёрт сбросом на старом сервере');
  });

test(
  'FILTER-UI-COLD-RESTORE: поздний ensure не стирает восстановленный scope',
  {
    timeout: 15000,
  },
  async (t) => {
    const cleanup = [];

    const world = await serverWorld({ after: (fn) => cleanup.push(fn) }, [
      sampleChat('cold-unread', { unread: true }),
      sampleChat('cold-read', { unread: false }),
    ]);

    const network = windowApi(world.app);

    const post = network.api.post;

    const release = Promise.withResolvers();

    let held = false;

    let wrapper;

    let chat;

    t.after(async () => {
      release.resolve();

      wrapper?.unmount();

      if (chat) {
        chat.loaded = false;

        chat.$dispose();
      }

      for (const close of cleanup) {
        await close();
      }
    });

    network.api.post = async (url, body, options) => {
      if (!held && url === '/api/chat/store/reconcile') {
        held = true;

        await release.promise;
      }

      return post(url, body, options);
    };

    chat = await chatStoreFixture({}, { api: network.api, unloaded: true });

    localStorage.setItem('chat.list.filters', JSON.stringify({ unread: true }));

    ({ wrapper } = await fixture(t, {}, chat));

    await waitFor(() => held && chat.search.filters.unread
      && chat.pageFor('', false, { ...EMPTY_CHAT_FILTERS, unread: true }).loaded, {
      what: 'сохранённый scope применён, пока начальный ensure ждёт recover',
    });

    release.resolve();

    await chat.ensure();

    await drain();

    assert.equal(chat.search.filters.unread, true);

    assert.deepEqual(wrapper.findAll('.row').map((row) => row.attributes('data-chat-id')), ['cold-unread']);

    await chat._refreshChatSearch();

    await chat._resyncPagedStore();

    const top = network.calls.filter((entry) => entry.body?.top).at(-1);

    assert.equal(top.body.top.unread, '1');

    assert.equal(chat.search.filters.unread, true);
  });

test('FILTER-UI-REFRESH-RETRY: повтор обновления возвращает актуальную выдачу и глубину', {
  timeout: 30000,
}, async (t) => {
  for (const count of [2, 85]) {
    await t.test(String(count), async (t) => {
      const records = Array.from({ length: count }, (_, index) => sampleChat(`retry-${index}`, {
        unread: true,
        updatedAt: 10000 - index,
      }));

      const world = await serverWorld(t, records);

      const network = windowApi(world.app);

      const { chat } = await world.open(network);

      const { wrapper } = await fixture(t, {}, chat);

      const filters = { ...EMPTY_CHAT_FILTERS, unread: true };

      await wrapper.find('[data-chat-filter-toggle]').trigger('click');

      await wrapper.find('button[data-chat-filter="unread"]').trigger('click');

      await waitFor(() => chat.pageFor('', false, filters).loaded, { what: 'фильтр загружен' });

      if (count > 40) {
        await chat.loadChatPage('', false, false, filters);
      }

      const depth = Math.min(count, 80);

      const get = network.api.get;

      let offline = true;

      assert.equal(chat.pageFor('', false, filters).ids.length, depth);

      network.api.get = async (url, options) => {
        if (offline && url.includes('unread=1')) {
          throw new Error('offline');
        }

        return get(url, options);
      };

      await chat._refreshChatSearch();

      await drain();

      assert.ok(chat.pageFor('', false, filters).error);

      assert.equal(chat.pageFor('', false, filters).ids.length, depth);

      offline = false;

      await writeChat(world, {
        ...records[0],
        unread: false,
        updatedAt: 20000
      });

      const before = network.calls.length;

      await wrapper.find('.load-state button').trigger('click');

      await waitFor(() => {
        const page = chat.pageFor('', false, filters);

        return !page.loading && !page.error && !page.needsRefresh
          && !page.ids.includes('retry-0') && page.ids.length >= Math.min(depth, count - 1);
      }, { what: 'кнопка повторила первую страницу и вернула прежнюю глубину' });

      const requests = network.calls.slice(before).filter((entry) => entry.url.includes('/list?'));

      assert.ok(requests.length >= 1);

      assert.equal(requests[0].url.includes('cursor='), false);

      assert.ok(requests.every((entry) => entry.url.includes('unread=1')));

      assert.equal(chat.pageFor('', false, filters).ids.length, Math.min(depth, count - 1));

      assert.equal(wrapper.find('[data-chat-id="retry-0"]').exists(), false);
    });
  }
});
