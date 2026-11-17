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
let RealCatalogChatList;

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

    const listStubs = {
      '../../stores/chat.ts': 'export const useChatStore = () => globalThis.__filtersChat;',
      '../../stores/providers.ts':
        'export const useProvidersStore = () => globalThis.__filtersProviders;',
      './useSse.ts': sseStub,
      './useSse': sseStub,
      '../../composables/useSse.ts': sseStub,
      './services/locale.ts': localeStub,
      '../services/locale.ts': localeStub,
      '../../shared/ProviderIcon.vue': 'export default { template: "<i />" };',
      '../../actions/projects/index.ts': `
        export const useProjectsStore = () => globalThis.__filtersProjects;
        export const loadProjects = async () => {};
        export const watchProjects = () => {};
      `,
      '../../stores/auth.ts': 'export const useAuthStore = () => ({ clientScope: "fixture" });',
      '../../stores/shell.ts': 'export const useShellStore = () => ({ profile: { id: "fixture" } });',
    };

    ChatList = await compileVue(webFile('src/views/chat/ChatList.vue'), { stubs: listStubs });

    const realCatalogStub = `
      import { useProjectsStore as actual } from '${webFile('src/stores/projects.ts')}';
      export * from '${webFile('src/actions/projects/index.ts')}';
      export function useProjectsStore() {
        const store = actual();
        globalThis.__filtersRealProjectStore = store;
        return store;
      }
    `;
    const catalogBusStub = `
      export const useSse = () => ({ connected: globalThis.__filtersConnected });
      export const sseSubscribe = (callback) => {
        globalThis.__filtersCatalogListeners.add(callback);
        return () => globalThis.__filtersCatalogListeners.delete(callback);
      };
    `;

    RealCatalogChatList = await compileVue(webFile('src/views/chat/ChatList.vue'), {
      stubs: {
        ...listStubs,
        '../../actions/projects/index.ts': realCatalogStub,
        '../../composables/useSse': catalogBusStub,
        '../../composables/useSse.ts': catalogBusStub,
      },
    });
  });

/**
 * Компонент получает реактивную копию стора: фильтры и scope записываются
 * в журнал вызовов, строки фильтруются так же, как их отдаёт сервер.
 */

async function fixture(t, initial = {}, liveChat = null, storedProject = null, catalogRead = null) {
  locale.setUiLocale('ru');

  // Как у соседних тестов ChatList: без мока useChatSleeping при каждом mount
  // гоняет настоящий retry-путь apiClient (побочный сетевой эффект).


  t.mock.method(api, 'get', async (url) => {
    if (catalogRead && url === '/api/projects') {
      return catalogRead();
    }

    return { sessions: [] };
  });

  const calls = {
    search: [],
    page: [],
    created: [],
  };

  const rows = [
    {
      id: 'c-1',
      catalogProjectId: 'alpha',
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
      catalogProjectId: 'beta',
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
      catalogProjectId: 'alpha',
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
    projectFiltersProtocol: 1,
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
          : filters.task === 'none' ? row.taskId == null : String(row.taskId) === filters.task))
        && (!filters.project || (filters.project === '@none'
          ? row.catalogProjectId == null : row.catalogProjectId === filters.project)));
    },
    retryLoad() { },
    newSession(options = {}) {
      calls.created.push(options);
      rows.push({
        ...rows[0],
        id: 'new-chat',
        title: 'Новый чат',
        unread: false,
        archived: false,
        catalogProjectId: options.workdir?.kind === 'project' ? options.workdir.projectId : null,
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

  globalThis.__filtersProjects = vue.reactive({
    items: CATALOG_SUMMARIES.map((item) => ({ ...item })),
    loaded: true,
    loading: false,
    error: '',
    deletedIds: new Set(),
  });

  if (storedProject !== null) {
    localStorage.setItem('chat.list.project:["fixture","fixture"]', storedProject);
  }

  if (catalogRead) {
    const { createPinia, setActivePinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');

    setActivePinia(createPinia());
    globalThis.__filtersCatalogListeners = new Set();
  }

  const wrapper = mount(catalogRead ? RealCatalogChatList : ChatList, { attachTo: document.body });

  t.after(() => {
    wrapper.unmount();

    delete globalThis.__filtersChat;

    delete globalThis.__filtersProviders;

    localStorage.removeItem('chat.list.filters');

    localStorage.removeItem('chat.list.scope');
    localStorage.removeItem('chat.list.project:["fixture","fixture"]');

    delete globalThis.__filtersProjects;
    delete globalThis.__filtersRealProjectStore;
    delete globalThis.__filtersCatalogListeners;
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

test('PROJECT-UI-SELECT: полоса выбирает проект, открытый чат остаётся', async (t) => {
  const { wrapper, state, calls } = await fixture(t, { activeId: 'c-2' });

  assert.equal(wrapper.find('[data-chat-project="alpha"]').exists(), true);
  await wrapper.find('[data-chat-project="alpha"]').trigger('click');
  await drain();

  assert.equal(calls.search.at(-1)[2].project, 'alpha');
  assert.equal(state.activeId, 'c-2');
  assert.equal(wrapper.findAll('[data-chat-id]').length, 1);
  assert.equal(wrapper.find('[data-chat-project-current]').text().includes('Альфа'), true);

  await wrapper.find('[data-chat-project-clear]').trigger('click');
  await drain();

  assert.equal(calls.search.at(-1)[2].project ?? '', '');
});

test('PROJECT-UI-CHIP: клик чипа меняет scope, не выбирая строку', async (t) => {
  const { wrapper, state } = await fixture(t, { activeId: 'c-2' });
  const chip = wrapper.find('[data-chat-project-chip="alpha"]');

  assert.equal(chip.exists(), true);
  assert.equal(chip.element.parentElement.closest('button') === null, true);
  await chip.trigger('click');
  await drain();

  assert.equal(state.activeId, 'c-2');
  assert.equal(wrapper.find('[data-chat-project-chip="alpha"]').exists(), false);
});

test('PROJECT-UI-ARCHIVE: архив и остальные фильтры пересекаются с project', async (t) => {
  const { wrapper, calls } = await fixture(t);

  await wrapper.find('[data-chat-project="alpha"]').trigger('click');
  await wrapper.find('[data-option-value="archived"]').trigger('click');
  await drain();

  assert.equal(calls.search.at(-1)[1], true);
  assert.equal(calls.search.at(-1)[2].project, 'alpha');
  assert.deepEqual(wrapper.findAll('[data-chat-id]').map((row) => row.attributes('data-chat-id')), ['c-3']);
});

test('PROJECT-UI-ERROR-DELETE: ошибка сохраняет выбор, tombstone снимает', async (t) => {
  const { wrapper, calls } = await fixture(t);

  await wrapper.find('[data-chat-project="alpha"]').trigger('click');
  globalThis.__filtersProjects.error = 'Каталог недоступен';
  await drain();

  assert.equal(calls.search.at(-1)[2].project, 'alpha');
  assert.equal(wrapper.find('[data-chat-project-error]').text().includes('Каталог недоступен'), true);
  assert.equal(wrapper.find('[data-chat-project-retry]').exists(), true);

  globalThis.__filtersProjects.deletedIds.add('alpha');
  globalThis.__filtersProjects.items = globalThis.__filtersProjects.items
    .filter((item) => item.id !== 'alpha');
  await drain();

  assert.equal(calls.search.at(-1)[2].project ?? '', '');
});

test('PROJECT-UI-SELECT-COMPACT: компактный выбор использует тот же project', async (t) => {
  const { wrapper, calls } = await fixture(t);
  const picker = wrapper.find('[data-chat-project-picker="compact"]');
  const selector = picker.findComponent({ name: 'UiSelect' });

  assert.equal(picker.exists(), true);
  assert.equal(selector.exists(), true);
  selector.vm.$emit('update:modelValue', 'beta');
  await drain();

  assert.equal(calls.search.at(-1)[2].project, 'beta');
  assert.equal(wrapper.find('[data-chat-project="beta"]').attributes('aria-pressed'), 'true');
});

test('PROJECT-UI-LEGACY: старый сервер скрывает project-навигацию', async (t) => {
  const { wrapper, calls } = await fixture(t, { projectFiltersProtocol: 0 });

  assert.equal(wrapper.find('[data-chat-project-picker]').exists(), false);
  assert.equal(calls.search.at(-1)[2].project ?? '', '');
});

test('PROJECT-UI-RESTORE: сохранённый project восстанавливается после каталога', async (t) => {
  const { wrapper, calls } = await fixture(t, {}, null, 'beta');

  assert.equal(calls.search.at(-1)[2].project, 'beta');
  assert.equal(wrapper.find('[data-chat-project="beta"]').attributes('aria-pressed'), 'true');
});

test('PROJECT-UI-RESTORE-UNKNOWN: отсутствующий ID даёт все чаты', async (t) => {
  const { calls } = await fixture(t, {}, null, 'missing-project');

  assert.equal(calls.search.at(-1)[2].project ?? '', '');
});

test('PROJECT-UI-STORAGE-ERROR: ошибка записи не мешает выбору', async (t) => {
  const { wrapper, calls } = await fixture(t);

  t.mock.method(localStorage, 'setItem', () => {
    throw new Error('denied');
  });
  await wrapper.find('[data-chat-project="alpha"]').trigger('click');
  await drain();

  assert.equal(calls.search.at(-1)[2].project, 'alpha');
});

const CATALOG_SUMMARIES = ['alpha', 'beta'].map((id) => ({
  id,
  title: id === 'alpha' ? 'Альфа' : 'Бета',
  tags: [],
  repos: [],
  defaultRepoKey: null,
  archivedAt: null,
  revision: 1,
  updatedAt: null,
  profile: { present: false, pathsSource: 'passport' },
  importStatus: 'none',
  routes: [],
  warnings: [],
}));

function emitCatalogHello() {
  for (const callback of globalThis.__filtersCatalogListeners) {
    callback('hello', {});
  }
}

test('PROJECT-UI-SSE-RECOVERY: успешный hello восстанавливает каталог после первого отказа', async (t) => {
  let reads = 0;
  const catalogRead = async () => {
    reads += 1;

    if (reads === 1) {
      throw new Error('Каталог недоступен');
    }

    return { projects: CATALOG_SUMMARIES };
  };
  const { wrapper, calls } = await fixture(t, {}, null, 'beta', catalogRead);

  assert.equal(wrapper.find('[data-chat-project-picker="rail"]').exists(), true);
  assert.equal(wrapper.find('[data-chat-project-error]').exists(), true);
  emitCatalogHello();
  await drain();

  assert.equal(wrapper.find('[data-chat-project="beta"]').attributes('disabled'), undefined);
  assert.equal(wrapper.find('[data-chat-project-error]').exists(), false);
  assert.equal(calls.search.at(-1)[2].project, 'beta');
});

test('PROJECT-UI-LATEST-WINS: вытесненный запрос не блокирует принятый каталог', async (t) => {
  const requests = [];
  const catalogRead = () => new Promise((resolve) => {
    requests.push(resolve);
  });
  const { wrapper, calls } = await fixture(t, {}, null, 'beta', catalogRead);

  assert.equal(wrapper.find('[data-chat-project-picker="rail"]').exists(), true);
  assert.equal(requests.length, 1);
  emitCatalogHello();
  await drain();
  assert.equal(requests.length, 2);
  requests[0]({ projects: [] });
  await drain();
  assert.equal(globalThis.__filtersRealProjectStore.loaded, false);
  requests[1]({ projects: CATALOG_SUMMARIES });
  await drain();

  assert.equal(wrapper.find('[data-chat-project="beta"]').attributes('disabled'), undefined);
  assert.equal(calls.search.at(-1)[2].project, 'beta');
});

test('PROJECT-UI-ARCHIVE-LABEL: desktop раскрывает причину недоступного создания', async (t) => {
  const { wrapper } = await fixture(t);

  globalThis.__filtersProjects.items[0].archivedAt = '2026-11-17T00:00:00Z';
  await drain();

  assert.equal(wrapper.find('[data-chat-project="alpha"]').attributes('aria-label'), 'Альфа · Архив');
  await wrapper.find('[data-chat-project="alpha"]').trigger('click');
  await drain();
  assert.equal(wrapper.find('[data-chat-project-current]').text().includes('Архив'), true);
});

test('PROJECT-UI-FULL-DIRTY-HEAD: метка скрытой полной dirty ленты обновляет прогретый chip', async (t) => {
  const world = await serverWorld(t, [
    sampleChat('dirty-project', {
      workdir: {
        kind: 'project',
        projectId: 'alpha',
        repoKey: null,
      },
    }),
    sampleChat('other-project'),
  ]);
  const { chat } = await world.open();

  await chat.ensureChatMessages('dirty-project');
  chat.activeId = 'other-project';

  const session = chat._find('dirty-project');
  const folder = JSON.stringify(session.workdir);
  const messages = session.messages;

  session.draft = 'Локальный черновик';

  const { wrapper } = await fixture(t, {}, chat);

  assert.equal(wrapper.find('[data-chat-project-chip="alpha"]').text(), 'Альфа');

  const response = await world.app.inject('/api/chat/store/head/dirty-project');

  assert.equal(response.statusCode, 200);

  // Серверная метка задачи может меняться без переписывания файла/черновика чата.
  // Изменяется только проекция события на входе настоящего SSE consumer.
  const head = { ...response.json().head, catalogProjectId: 'beta' };

  await chat._pullChat('dirty-project', false, head);
  await drain();

  assert.equal(wrapper.find('[data-chat-project-chip="alpha"]').exists(), false);
  assert.equal(wrapper.find('[data-chat-project-chip="beta"]').text(), 'Бета');
  assert.equal(session.draft, 'Локальный черновик');
  assert.equal(JSON.stringify(session.workdir), folder);
  assert.equal(session.messages === messages, true);
  await wrapper.find('[data-chat-project-chip="beta"]').trigger('click');
  await drain();

  assert.equal(chat.search.filters.project, 'beta');
  assert.equal(chat.activeId, 'other-project');
});

test('PROJECT-UI-CREATE: новый чат получает явный проект, project остаётся выбранным', async (t) => {
  const { wrapper, calls } = await fixture(t);

  await wrapper.find('[data-chat-project="alpha"]').trigger('click');
  await wrapper.find('[data-chat-filter-toggle]').trigger('click');
  await wrapper.find('button[data-chat-filter="unread"]').trigger('click');
  await wrapper.find('.new').trigger('click');
  await drain();

  assert.deepEqual(calls.created.at(-1), {
    workdir: {
      kind: 'project',
      projectId: 'alpha',
      repoKey: null,
    },
  });
  assert.equal(calls.search.at(-1)[2].project, 'alpha');
  assert.equal(calls.search.at(-1)[2].unread, false);
  assert.equal(calls.search.at(-1)[1], false);
});

test('PROJECT-UI-CREATE-NONE: без проекта не наследует проект из defaults', async (t) => {
  const { wrapper, calls } = await fixture(t);

  await wrapper.find('[data-chat-project="@none"]').trigger('click');
  await wrapper.find('.new').trigger('click');

  assert.deepEqual(calls.created.at(-1), { workdir: { kind: 'grigdesk' } });
});

test('PROJECT-UI-CREATE-ARCHIVED: архивный проект читается, но новый чат не создаётся', async (t) => {
  const { wrapper, calls } = await fixture(t);

  globalThis.__filtersProjects.items[0].archivedAt = '2026-11-17T00:00:00Z';
  await wrapper.find('[data-chat-project="alpha"]').trigger('click');
  await drain();

  assert.equal(wrapper.find('.new').attributes('disabled') !== undefined, true);
  await wrapper.find('.new').trigger('click');

  assert.equal(calls.created.length, 0);
});
