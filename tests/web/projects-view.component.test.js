// Страница «Проекты»: каркас раздела — список, поиск и переход к паспорту.
//
// Сети страница не касается: подменяется слой операций раздела, а проверяется то,
// что страница показывает человеку и какие действия она зовёт. Ширина окна задаётся
// через `matchMedia`: от неё зависит, показывать список и форму рядом или по одной.
import assert from 'node:assert/strict';
import test from 'node:test';

import { installUiBrowser } from './helpers/ui-components.js';
import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';

const VIEW = webFile('src/views/ProjectsView.vue');
const draftModule = await compileModule(webFile('src/views/projects/projectDraft.ts'));

// Элементы управления настоящие: подменяются только диалоги, чтобы проверялось
// поведение самой страницы, а не её заглушек.
const UI_STUB = `
export { default as UiLoadingState } from './src/components/feedback/UiLoadingState.vue';
export const { t, resolveUiText, messageRef } = globalThis.__projectsViewLocale;
export { default as UiPaneHeader } from '${webFile('src/components/composites/UiPaneHeader.vue')}';
export { default as UiButton } from '${webFile('src/components/primitives/UiButton.vue')}';
export { default as UiIconButton } from '${webFile('src/components/primitives/UiIconButton.vue')}';
export { default as UiInput } from '${webFile('src/components/primitives/UiInput.vue')}';
export { default as UiSelect } from '${webFile('src/components/primitives/UiSelect.vue')}';
export { default as UiRadio } from '${webFile('src/components/primitives/UiRadio.vue')}';
export { default as UiTextarea } from '${webFile('src/components/primitives/UiTextarea.vue')}';
export { default as UiPressable } from '${webFile('src/components/primitives/UiPressable.vue')}';
export { default as UiSearchInput } from '${webFile('src/components/composites/UiSearchInput.vue')}';
export { default as UiField } from '${webFile('src/components/composites/UiField.vue')}';
export { default as UiFormActions } from '${webFile('src/components/composites/UiFormActions.vue')}';
export { default as UiInlineMessage } from '${webFile('src/components/feedback/UiInlineMessage.vue')}';
export { default as UiSpinner } from '${webFile('src/components/primitives/UiSpinner.vue')}';
export { default as UiTooltip } from '${webFile('src/components/overlays/UiTooltip.vue')}';
export const alertDialog = async (text) => {
  globalThis.__projectsViewHarness.alerts.push(text);
  return true;
};
export const confirmDialog = async (text, options) => {
  globalThis.__projectsViewHarness.confirmations.push({ text, options });
  return globalThis.__projectsViewHarness.confirmed;
};
export const promptDialog = async () => null;
`;

// Публикация UI-контекста — тоже граница страницы: проверяется, что уходит в чат.
const CONTEXT_STUB = `
export const useUiContextSource = (id, initial) => {
  globalThis.__projectsViewHarness.context.push(['create', id, initial]);
  return {
    update: (patch) => globalThis.__projectsViewHarness.context.push(['update', id, patch]),
    focus: (patch) => globalThis.__projectsViewHarness.context.push(['focus', id, patch]),
    blur: () => globalThis.__projectsViewHarness.context.push(['blur', id]),
  };
};
`;

// Операции раздела — двойники: страница обязана звать их, а не ходить в сеть сама.
const ACTIONS_STUB = `
export const useProjectsStore = () => globalThis.__projectsViewHarness.store;
export const watchProjects = () => {
  globalThis.__projectsViewHarness.calls.push(['watch']);
};
export const loadProjects = async () => {
  globalThis.__projectsViewHarness.calls.push(['load']);
};
export const loadProject = async (id, options) => {
  const harness = globalThis.__projectsViewHarness;

  harness.calls.push(['open', id, options]);
  if (harness.detail) {
    harness.store.opened = harness.detail;
    harness.store.draft = harness.draftOf(harness.detail);
    harness.store.conflict = null;
  }
};
export const saveProject = async (id, draft, options) => {
  const harness = globalThis.__projectsViewHarness;

  harness.calls.push(['save', id, options]);
  if (harness.saveResult.error === 'revision_conflict') {
    harness.store.conflict = harness.saveResult.conflict;
  } else if (harness.saveResult.ok) {
    const detail = {
      ...harness.detail,
      id: draft.id,
      title: draft.title,
      description: draft.description,
      tags: [...draft.tags],
      repos: draft.repos.map((repo) => ({ ...repo, exists: true })),
      defaultRepoKey: draft.defaultRepoKey,
      revision: (harness.detail?.revision ?? 0) + 1,
    };

    harness.store.opened = detail;
    harness.store.draft = harness.draftOf(detail);
    harness.store.conflict = null;
  }
  return harness.saveResult;
};
export const checkRepositories = async (dirs, options) => {
  globalThis.__projectsViewHarness.calls.push(['check', dirs, options]);
};
export const loadDependencies = async (id) => {
  globalThis.__projectsViewHarness.calls.push(['dependencies', id]);
};
export const archiveProject = async (id, options) => {
  globalThis.__projectsViewHarness.calls.push(['archive', id, options]);
  return globalThis.__projectsViewHarness.lifecycleResult;
};
export const removeProject = async (id, options) => {
  const h = globalThis.__projectsViewHarness;
  h.calls.push(['remove', id, options]);
  const result = await (h.removeResult ?? h.lifecycleResult);
  if (result.ok) {
    if (h.store.opened?.id === id) {
      const dirty = h.store.draft && h.isDirty(h.store.draft, h.draftOf(h.store.opened));

      h.store.opened = null;
      h.store.draft = dirty ? h.store.draft : null;
    }
    h.store.items = h.store.items.filter((item) => item.id !== id);
  }
  return result;
};
export const restoreProject = async (id, options) => {
  globalThis.__projectsViewHarness.calls.push(['restore', id, options]);
  return globalThis.__projectsViewHarness.lifecycleResult;
};
`;

// Роутер — двойник с реактивным маршрутом и накопителем переходов. Колбэки защиты
// ухода сохраняются: их вызывает тест шага A4.4.
const ROUTER_STUB = `
export const useRoute = () => globalThis.__projectsViewHarness.route;
export const useRouter = () => globalThis.__projectsViewHarness.router;
export const onBeforeRouteLeave = (guard) => {
  globalThis.__projectsViewHarness.leaveGuards.push(guard);
};
export const onBeforeRouteUpdate = (guard) => {
  globalThis.__projectsViewHarness.updateGuards.push(guard);
};
`;

const DETAIL = {
  ...{
    id: 'demo',
    title: 'Демо-проект',
    tags: [],
    repos: [{ key: 'be', dir: '/srv/demo/be', exists: true }],
    defaultRepoKey: 'be',
    archivedAt: null,
    revision: 3,
    updatedAt: '2026-09-22T10:00:00.000Z',
    profile: { present: false, pathsSource: 'passport' },
    importStatus: 'none',
    routes: [],
    warnings: [],
  },
  description: 'Описание проекта',
  createdAt: '2026-09-22T09:00:00.000Z',
  import: { status: 'none', fingerprint: null, at: null, error: null, candidates: null },
  profile: {
    present: false,
    pathsSource: 'passport',
    readable: null,
    repos: [],
    capabilities: [],
    mismatch: [],
  },
};

function summary(overrides = {}) {
  return {
    id: 'demo',
    title: 'Демо-проект',
    tags: [],
    repos: [{ key: 'be', dir: '/srv/demo/be', exists: true }],
    defaultRepoKey: 'be',
    archivedAt: null,
    revision: 3,
    updatedAt: '2026-09-22T10:00:00.000Z',
    profile: { present: false, pathsSource: 'passport' },
    importStatus: 'none',
    routes: [],
    warnings: [],
    ...overrides,
  };
}

/**
 * Страница монтируется на двойнике стора и двойнике роутера. Маршрут реактивный:
 * переход по строке списка меняет его так же, как настоящий роутер, и страница
 * обязана на это отреагировать.
 */
async function mountView(t, {
  items = [summary()],
  error = '',
  opened = null,
  draft = undefined,
  params = {},
  query = {},
  dockCapable = true,
  chatState = {},
  confirmed = true,
  saveResult = { ok: true, error: '', fieldErrors: [] },
} = {}) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/projects');
  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const locale = await import('../../web/src/services/locale.ts');

  locale.setUiLocale('ru');
  globalThis.__projectsViewLocale = locale;
  t.after(() => locale.setUiLocale('ru'));

  const route = reactive({ path: '/projects', params: {}, query: {} });

  for (const [key, value] of Object.entries(params)) {
    route.params[key] = value;
  }
  for (const [key, value] of Object.entries(query)) {
    route.query[key] = value;
  }

  const pushes = [];
  const beforeUnload = { added: [], removed: [] };
  const originalAdd = browser.window.addEventListener.bind(browser.window);
  const originalRemove = browser.window.removeEventListener.bind(browser.window);

  browser.window.addEventListener = (type, handler, options) => {
    if (type === 'beforeunload') beforeUnload.added.push(handler);

    return originalAdd(type, handler, options);
  };
  browser.window.removeEventListener = (type, handler, options) => {
    if (type === 'beforeunload') beforeUnload.removed.push(handler);

    return originalRemove(type, handler, options);
  };

  const draftOf = (detail) => draftModule.createDraft(detail);
  const store = reactive({
    items,
    opened,
    draft: draft === undefined ? (opened ? draftOf(opened) : null) : draft,
    conflict: null,
    loading: false,
    loaded: true,
    dependencies: {
      items: [],
      archivable: true,
      deletable: true,
      reasons: []
    },
    error,
    checks: {},
    setItems(value) {
      this.items = value;
    },
    setOpened(value) {
      this.opened = value;
    },
    setDraft(value) {
      this.draft = value;
    },
    setConflict(value) {
      this.conflict = value;
    },
    setLoading(value) {
      this.loading = value;
    },
    setError(value) {
      this.error = value;
    },
    setCheck(dir, value) {
      this.checks = { ...this.checks, [dir]: value };
    },
    clearChecks() {
      this.checks = {};
    },
  });
  const harness = {
    confirmed,
    alerts: [],
    beforeUnload,
    confirmations: [],
    calls: [],
    context: [],
    detail: opened,
    draftOf,
    isDirty: draftModule.isDirty,
    lifecycleResult: {
      ok: true,
      error: '',
      message: ''
    },
    leaveGuards: [],
    saveResult,
    updateGuards: [],
    pushes,
    store,
    route,
    router: {
      /**
       * Замена адреса очищает параметры выбранного проекта без новой записи истории.
       * Переход сохраняется в журнале, чтобы проверить возврат к каталогу.
       */
      async replace(target) {
        pushes.push(target);
        route.path = typeof target === 'string' ? target : target.path;
        route.params = {};
        route.query = {};
      },
      async push(target) {
        pushes.push(target);
        const path = typeof target === 'string' ? target : target?.path;
        route.path = path;
        if (typeof target === 'object') {
          route.params = { ...target.params };
          route.query = { ...target.query };
        } else {
          route.params = {};
          route.query = {};
        }
      },
    },
  };

  harness.chatId = 'chat-id';
  harness.chat = reactive({
    loaded: true,
    loading: false,
    loadError: null,
    ...chatState,
    get loadErrorMessage() {
      const keys = {
        network: 'core.chatListLoadNetwork',
        timeout: 'core.chatListLoadTimeout',
        server: 'core.chatListLoadServer',
      };

      return this.loadError ? locale.messageRef(keys[this.loadError]) : null;
    },
    async _load() {
      harness.calls.push(['chat-load']);
      await harness.chatLoad;
    },
    retryLoad() {
      harness.calls.push(['chat-retry']);
      this.loading = true;
    },
    newSession(options) {
      harness.calls.push(['chat', options]);

      return harness.chatId;
    },
  });
  globalThis.__projectsViewHarness = harness;
  Object.defineProperty(browser.window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({
      matches: dockCapable,
      addEventListener() {},
      removeEventListener() {},
    }),
  });

  const component = await compileVue(VIEW, {
    stubs: {
      '../stores/chat.ts': `
        export const useChatStore = () => globalThis.__projectsViewHarness.chat;
      `,
      '../actions/projects': ACTIONS_STUB,
      '../../actions/projects': ACTIONS_STUB,
      '../ui': (UI_STUB) +
        "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
      '../../ui': (UI_STUB) +
        "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
      '../composables/useUiContextSource.ts': CONTEXT_STUB,
      'vue-router': ROUTER_STUB,
    },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, { attachTo: browser.document.querySelector('#mount') });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__projectsViewHarness;
  });

  await flushPromises();

  return { wrapper, harness };
}

test('строки списка показывают название, число репозиториев и предупреждения', async (t) => {
  const items = [summary({
    repos: [
      { key: 'be', dir: '/srv/demo/be', exists: true },
      { key: 'fe', dir: '/srv/demo/fe', exists: false },
    ],
    warnings: ['Ключи be, fe указывают на один каталог /srv/demo.'],
  })];
  const { wrapper } = await mountView(t, { items });
  const row = wrapper.find('[data-role="project-row"]');

  assert.ok(row.exists());
  assert.match(row.text(), /Демо-проект/);
  assert.equal(row.attributes('data-project-id'), 'demo');
  assert.match(row.text(), /Репозитории:\s+2/);
  assert.match(row.text(), /один каталог/);
});

test('ошибка загрузки показывает Повторить и не стирает прежний список', async (t) => {
  const { wrapper, harness } = await mountView(t, {
    items: [summary()],
    error: 'Не удалось прочитать список проектов.',
  });

  assert.match(wrapper.text(), /Не удалось прочитать список проектов/);
  assert.equal(wrapper.findAll('[data-role="project-row"]').length, 1);

  harness.calls.length = 0;
  await wrapper.find('[data-role="project-retry"]').trigger('click');

  assert.deepEqual(harness.calls, [['load']]);
});

test('отказ первой загрузки не выдаётся за пустой каталог', async (t) => {
  const { wrapper } = await mountView(t, { items: [], error: 'Каталог временно недоступен.' });

  assert.match(wrapper.find('[role="alert"]').text(), /Каталог временно недоступен/);
  assert.equal(wrapper.text().includes('Проектов пока нет'), false);
  assert.equal(wrapper.text().includes('Создайте первый проект'), false);
  assert.equal(wrapper.find('[data-role="project-retry"]').isVisible(), true);
});

test('поиск фильтрует по названию, ID, меткам и путям, фильтр Архив скрывает активные', async (t) => {
  const active = summary({ id: 'demo', title: 'Демо-проект', tags: ['конвейер'] });
  const archived = summary({
    id: 'old',
    title: 'Старый проект',
    archivedAt: '2026-09-01T00:00:00.000Z',
  });
  const { wrapper } = await mountView(t, { items: [active, archived] });
  const search = wrapper.find('[data-role="project-search"] input');
  const filter = (value) => wrapper.find(`[data-role="project-filter"] [data-value="${value}"]`);
  const rows = () => wrapper.findAll('[data-role="project-row"]');

  assert.deepEqual(rows().map((row) => row.attributes('data-project-id')), ['demo']);

  for (const [query, expected] of [
    ['Старый', []],
    ['old', []],
    ['метка-которой-нет', []],
  ]) {
    await search.setValue(query);
    assert.deepEqual(rows().map((row) => row.attributes('data-project-id')), expected, query);
  }

  await search.setValue('');

  for (const query of ['Демо', 'demo', 'конвейер', '/srv/demo/be']) {
    await search.setValue(query);
    assert.deepEqual(rows().map((row) => row.attributes('data-project-id')), ['demo'], query);
  }

  await search.setValue('нет-такого-проекта');
  assert.equal(rows().length, 0);
  assert.match(wrapper.text(), /Ничего не найдено/);

  await search.setValue('');
  await filter('archive').trigger('click');

  assert.deepEqual(rows().map((row) => row.attributes('data-project-id')), ['old']);

  await filter('active').trigger('click');

  assert.deepEqual(rows().map((row) => row.attributes('data-project-id')), ['demo']);
});

test('?create=1 показывает форму создания, клик по строке ведёт на паспорт проекта', async (t) => {
  const { wrapper, harness } = await mountView(t, { query: { create: '1' } });
  const form = wrapper.find('[data-role="project-form"]');

  assert.ok(form.exists());
  assert.match(form.text(), /Новый проект/);
  assert.equal(harness.calls.some(([name]) => name === 'open'), false);

  await wrapper.find('[data-role="project-row"]').trigger('click');

  assert.deepEqual(harness.pushes, ['/projects/demo']);
});

test('создание открывает сохранённый проект без повторного подтверждения ухода', async (t) => {
  const { wrapper, harness } = await mountView(t, { query: { create: '1' }, opened: DETAIL });
  const { flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );

  assert.equal(harness.store.opened, null, 'новый проект не наследует снимок предыдущего');
  await wrapper.find('[data-role="project-id"]').setValue('new-project');
  await wrapper.find('[data-role="project-title"]').setValue('Новый продукт');
  await wrapper.find('[data-role="project-save"]').trigger('click');
  await flushPromises();

  assert.equal(harness.calls.filter(([name]) => name === 'save').length, 1);
  assert.deepEqual(harness.pushes, ['/projects/new-project']);
  assert.equal(await harness.updateGuards[0](), true);
  assert.equal(harness.confirmations.length, 0, 'успешно сохранённая форма не считается изменённой');
});

test('узкий экран показывает одну область с возвратом в «Проекты», широкий — обе', async (t) => {
  const narrow = await mountView(t, { dockCapable: false, params: { id: 'demo' } });

  assert.equal(narrow.wrapper.find('[data-role="project-list"]').isVisible(), false);
  assert.ok(narrow.wrapper.find('[data-role="project-form"]').exists());
  assert.deepEqual(
    narrow.harness.calls.filter(([name]) => name === 'open').map(([, id]) => id),
    ['demo'],
  );

  const back = narrow.wrapper.find('[data-role="project-back"]');

  assert.match(back.text(), /Проекты/);
  await back.trigger('click');

  assert.deepEqual(narrow.harness.pushes, ['/projects']);

  const wide = await mountView(t, { dockCapable: true, params: { id: 'demo' } });

  assert.ok(wide.wrapper.find('[data-role="project-list"]').exists());
  assert.ok(wide.wrapper.find('[data-role="project-form"]').exists());
  assert.equal(wide.wrapper.find('[data-role="project-back"]').exists(), false);
});

test('возврат к каталогу на телефоне сохраняет поиск, архив и сортировку', async (t) => {
  const { wrapper, harness } = await mountView(t, {
    dockCapable: false,
    items: [summary(), summary({
      id: 'old',
      title: 'Архивный проект',
      archivedAt: '2026-09-01T00:00:00Z',
    })],
  });
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');

  await wrapper.find('[data-role="project-filter"] [data-value="archive"]').trigger('click');
  await wrapper.find('[data-role="project-sort"] button').trigger('click');
  await wrapper.find('[data-role="project-search"] input').setValue('Архивный');
  harness.route.params = { id: 'old' };
  await nextTick();

  assert.equal(wrapper.find('[data-role="project-list"]').isVisible(), false);
  await wrapper.find('[data-role="project-back"]').trigger('click');

  assert.equal(wrapper.find('[data-role="project-list"]').isVisible(), true);
  assert.equal(wrapper.find('[data-role="project-search"] input').element.value, 'Архивный');
  assert.equal(wrapper.find('[data-value="archive"]').attributes('aria-pressed'), 'true');
  assert.equal(wrapper.find('[data-role="project-sort"]').attributes('data-sort'), 'updated');
  assert.deepEqual(wrapper.findAll('[data-role="project-row"]')
    .map((row) => row.attributes('data-project-id')), ['old']);
});

test('новый проект не предлагает архив и маршруты до первого сохранения', async (t) => {
  const { wrapper } = await mountView(t, { query: { create: '1' } });

  assert.equal(wrapper.find('[data-role="project-manage"]').exists(), false);
  assert.equal(wrapper.find('[data-role="project-routes"]').exists(), false);
  assert.equal(wrapper.find('[data-role="project-save"]').text(), 'Создать проект');
});

test('ошибка карточки видна на телефоне и не открывает форму предыдущего проекта', async (t) => {
  const { wrapper, harness } = await mountView(t, {
    dockCapable: false,
    params: { id: 'missing' },
    opened: DETAIL,
    error: 'Проект не найден.',
  });

  assert.equal(wrapper.find('[data-role="project-list"]').isVisible(), false);
  assert.match(wrapper.find('[data-role="project-form"]').text(), /Проект не найден/);
  assert.equal(wrapper.find('[data-role="project-title"]').exists(), false);
  assert.equal(wrapper.find('[data-role="project-save"]').exists(), false);
  harness.calls.length = 0;
  await wrapper.find('[data-role="project-detail-retry"]').trigger('click');

  assert.deepEqual(harness.calls.map(([name, id]) => [name, id]), [
    ['open', 'missing'],
    ['dependencies', 'missing'],
  ]);
});

test('открытый паспорт публикует в UI-контекст только project, без путей', async (t) => {
  const { harness } = await mountView(t, {
    params: { id: 'demo' },
    opened: { ...DETAIL, description: 'Описание' },
  });
  const focused = harness.context.filter(([name]) => name === 'focus').at(-1);

  assert.equal(focused[1], 'projects');
  assert.equal(focused[2].details.project, 'demo');
  assert.equal(JSON.stringify(harness.context).includes('dir'), false);
});

test('уход при dirty спрашивает подтверждение, отказ оставляет на странице', async (t) => {
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const refused = await mountView(t, { opened: DETAIL, confirmed: false });

  refused.harness.store.draft.title = 'Правка человека';
  await nextTick();

  assert.equal(await refused.harness.leaveGuards[0](), false);
  assert.deepEqual(refused.harness.confirmations.at(-1), {
    text: 'Есть несохранённые изменения — бросить?',
    options: { okText: 'Бросить' },
  });

  const allowed = await mountView(t, { opened: DETAIL, confirmed: true });

  allowed.harness.store.draft.title = 'Правка человека';
  await nextTick();

  assert.equal(await allowed.harness.leaveGuards[0](), true);

  // Без правок вопроса нет вовсе: уходить с чистой формы можно молча.
  const clean = await mountView(t, { opened: DETAIL });

  assert.equal(await clean.harness.leaveGuards[0](), true);
  assert.deepEqual(clean.harness.confirmations, []);
});

test('смена :id при dirty спрашивает так же', async (t) => {
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const { harness } = await mountView(t, { opened: DETAIL, confirmed: false });

  harness.store.draft.title = 'Правка человека';
  await nextTick();

  assert.equal(await harness.updateGuards[0](), false);
  assert.equal(harness.confirmations.length, 1);
});

test('beforeunload ставится при dirty и снимается после сохранения', async (t) => {
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const { wrapper, harness } = await mountView(t, { opened: DETAIL, params: { id: 'demo' } });

  assert.equal(harness.beforeUnload.added.length, 0);

  harness.store.draft.title = 'Правка человека';
  await nextTick();

  assert.equal(harness.beforeUnload.added.length, 1);

  await wrapper.find('[data-role="project-save"]').trigger('click');
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  await nextTick();

  assert.equal(harness.beforeUnload.removed.length, 1);
  assert.equal(harness.store.opened.title, 'Правка человека', 'снимок обновлён ответом сервера');
  assert.equal(harness.store.draft.title, 'Правка человека', 'правки сохранены, а не отброшены');
});

test('409 revision_conflict показывает изменённые поля и два действия', async (t) => {
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const { wrapper, harness } = await mountView(t, {
    opened: DETAIL,
    params: { id: 'demo' },
    confirmed: true,
    saveResult: {
      ok: false,
      error: 'revision_conflict',
      fieldErrors: [],
      conflict: { currentRevision: 5, changedFields: ['title'] },
    },
  });

  harness.store.draft.title = 'Правка человека';
  await nextTick();
  await wrapper.find('[data-role="project-save"]').trigger('click');

  const conflict = wrapper.find('[data-role="project-conflict"]');

  assert.ok(conflict.exists());
  assert.match(conflict.text(), /изменён/i);
  assert.match(conflict.text(), /Название/);

  await wrapper.find('[data-role="project-conflict-reload"]').trigger('click');
  await nextTick();

  assert.equal(wrapper.find('[data-role="project-conflict"]').exists(), false);
  assert.equal(harness.store.draft.title, 'Демо-проект', 'перечитать — значит взять серверную версию');

  harness.store.draft.title = 'Правка поверх';
  await nextTick();
  await wrapper.find('[data-role="project-save"]').trigger('click');
  await wrapper.find('[data-role="project-conflict-overwrite"]').trigger('click');

  assert.deepEqual(harness.calls.at(-1), ['save', 'demo', { expectedRevision: 5 }]);
});

test('409 exists при создании показывает «Открыть найденный проект» и сохраняет черновик', async (t) => {
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const { wrapper, harness } = await mountView(t, {
    query: { create: '1' },
    saveResult: { ok: false, error: 'exists', fieldErrors: [] },
  });

  await wrapper.find('[data-role="project-id"]').setValue('demo');
  await wrapper.find('[data-role="project-title"]').setValue('Мой проект');
  await nextTick();
  await wrapper.find('[data-role="project-save"]').trigger('click');

  const failure = wrapper.find('[data-role="project-save-failure"]');

  assert.ok(failure.exists());
  assert.match(failure.text(), /Открыть найденный проект/);
  assert.equal(harness.store.draft.id, 'demo');
  assert.equal(harness.store.draft.title, 'Мой проект');

  await wrapper.find('[data-role="project-open-found"]').trigger('click');

  assert.deepEqual(harness.pushes, ['/projects/demo']);
});


test('отмена восстанавливает общий черновик и убирает предупреждение об уходе', async (t) => {
  const { wrapper, harness } = await mountView(t, { params: { id: 'demo' }, opened: DETAIL });

  await wrapper.find('[data-role="project-title"]').setValue('Несохранённое название');
  await wrapper.find('[data-role="project-repo-dir"]').setValue('/srv/new');
  assert.equal(wrapper.find('[data-role="project-save"]').element.disabled, false);
  await wrapper.find('[data-role="project-cancel"]').trigger('click');
  assert.equal(harness.store.draft.title, DETAIL.title);
  assert.equal(harness.store.draft.repos[0].dir, DETAIL.repos[0].dir);
  assert.equal(wrapper.find('[data-role="project-save"]').element.disabled, true);
  assert.equal(wrapper.find('[data-role="project-cancel"]').exists(), false);
  assert.equal(await harness.leaveGuards[0](), true);
  assert.deepEqual(harness.confirmations, []);
});

for (const dockCapable of [false, true]) {
  test(`PD-UI: удаление архивного проекта с общим подтверждением (${dockCapable ? 1280 : 390}px)`,
    async (t) => {
      const archived = { ...DETAIL, archivedAt: '2026-10-20T10:00:00.000Z' };
      const { wrapper, harness } = await mountView(t, {

        opened: archived,
        params: { id: 'demo' },
        dockCapable,
        confirmed: false,

      });
      const { flushPromises, nextTick } = await import(
        '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
      );
      const remove = () => wrapper.findAll('button').find((item) => item.text() === 'Удалить регистрацию');

      assert.equal(Boolean(remove()), true, 'архивная регистрация доступна для удаления');
      await remove().trigger('click');
      await flushPromises();
      assert.deepEqual(harness.calls.filter(([kind]) => kind === 'remove'), []);
      assert.equal(harness.confirmations[0].text,
        'Удалить регистрацию «Демо-проект»? Файлы проекта останутся на диске.');
      assert.equal(harness.confirmations[0].options.okText, 'Удалить регистрацию');
      harness.confirmed = true;
      harness.removeResult = {
        ok: false,
        error: 'deletion_incomplete',
        message: 'Настройки чатов не записаны'
      };
      await remove().trigger('click');
      await flushPromises();
      assert.match(wrapper.text(), /Настройки чатов не записаны/);
      assert.equal(harness.store.opened.id, 'demo');
      harness.removeResult = {
        ok: true,
        error: '',
        message: ''
      };
      await remove().trigger('click');
      await flushPromises();
      assert.equal(harness.store.opened, null);
      assert.equal(harness.pushes.at(-1), '/projects');
    });
}

test('PD-UI: удаление недоступно активному и dirty паспорту', async (t) => {
  const { wrapper, harness } = await mountView(t, { opened: DETAIL, params: { id: 'demo' } });

  assert.equal(wrapper.findAll('button').some((item) => item.text() === 'Удалить регистрацию'), false);
  harness.detail = { ...DETAIL, archivedAt: '2026-10-20T10:00:00.000Z' };
  harness.store.opened = harness.detail;
  harness.store.draft.title = 'Несохранённая правка';

  const { flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );

  await flushPromises();

  const remove = wrapper.findAll('button').find((item) => item.text() === 'Удалить регистрацию');

  assert.equal(Boolean(remove?.element.disabled ?? !remove), true);
});

for (const dirty of [false, true]) {
  test(`PD-external-delete: ${dirty ? 'dirty остаётся для чтения' : 'адрес сбрасывается'}`,
    async (t) => {
      const { wrapper, harness } = await mountView(t, { opened: DETAIL, params: { id: 'demo' } });
      const { flushPromises } = await import(
        '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
      );

      if (dirty) {
        harness.store.draft.title = 'Локальный текст';
        await flushPromises();
      }

      harness.store.items = [];
      harness.store.opened = null;
      await flushPromises();
      assert.match(wrapper.text(), /Регистрация проекта удалена\./);

      if (dirty) {
        assert.equal(wrapper.find('[data-role="project-title"]').element.value, 'Локальный текст');
        assert.equal(wrapper.find('[data-role="project-save"]').element.disabled, true);
      } else {
        assert.equal(harness.pushes.at(-1), '/projects');
      }
    });
}

test('PD-UI: ожидание DELETE блокирует повтор и другие записи', async (t) => {
  const archived = { ...DETAIL, archivedAt: '2026-10-20T10:00:00.000Z' };
  const { wrapper, harness } = await mountView(t, { opened: archived, params: { id: 'demo' } });
  const { flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const pending = Promise.withResolvers();
  const remove = wrapper.findAll('button').find((item) => item.text() === 'Удалить регистрацию');

  assert.equal(Boolean(remove), true);
  harness.removeResult = pending.promise;

  try {
    await remove.trigger('click');
    await flushPromises();
    await remove.trigger('click');
    await flushPromises();
    assert.equal(harness.calls.filter(([kind]) => kind === 'remove').length, 1);
    assert.equal(wrapper.get('[data-role="project-save"]').element.disabled, true);
  } finally {
    pending.resolve({
      ok: true,
      error: '',
      message: '',
    });
    await flushPromises();
  }
});


test('Поздний DELETE проекта A должен сохранять правки открытого проекта B', async (t) => {
  const a = { ...DETAIL, archivedAt: '2026-10-20T10:00:00.000Z' };
  const b = {
    ...DETAIL,
    id: 'neighbor',
    title: 'Соседний проект',
  };
  const { wrapper, harness } = await mountView(t, {
    opened: a,
    params: { id: 'demo' },
    items: [summary(), summary(b)],
  });
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const { flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  let release;

  harness.removeResult = new Promise((resolve) => {
    release = resolve;
  });
  await wrapper.find('[data-role="project-remove"]').trigger('click');
  await flushPromises();
  assert.equal(harness.calls.some(([kind]) => kind === 'remove'), true);
  assert.equal(await harness.updateGuards[0](), true, 'уход во время DELETE разрешён');
  harness.detail = b;
  harness.route.path = '/projects/neighbor';
  harness.route.params = { id: 'neighbor' };
  await nextTick();
  await flushPromises();
  await wrapper.find('[data-role="project-title"]').setValue('Несохранённая правка соседа');
  assert.equal(harness.store.draft.title, 'Несохранённая правка соседа');
  release({
    ok: true,
    error: '',
    message: '',
  });
  await flushPromises();
  assert.equal(harness.store.draft?.title, 'Несохранённая правка соседа');
});

test('Правка удаляемого паспорта во время DELETE остаётся для чтения', async (t) => {
  const detail = { ...DETAIL, archivedAt: '2026-10-20T10:00:00.000Z' };
  const { wrapper, harness } = await mountView(t, { opened: detail, params: { id: 'demo' } });
  const { flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  let release;

  harness.removeResult = new Promise((resolve) => {
    release = resolve;
  });
  await wrapper.find('[data-role="project-remove"]').trigger('click');
  await flushPromises();
  await wrapper.find('[data-role="project-title"]').setValue('Правка во время удаления');
  release({
    ok: true,
    error: '',
    message: '',
  });
  await flushPromises();
  assert.equal(harness.store.draft?.title, 'Правка во время удаления');
  assert.equal(harness.route.params.id, 'demo');
  assert.equal(wrapper.find('[data-role="project-title"]').attributes('readonly'), '');
  assert.match(wrapper.text(), /Регистрация проекта удалена/u);
});


const CHAT_LOAD_TEXT = {
  ru: {
    loading: 'Загружаем чаты…',
    failed: 'Чаты не загрузились',
    network: 'Нет связи с сервером',
    timeout: 'Сервер не ответил вовремя',
    server: 'Ошибка сервера',
    retry: 'Повторить',
    blocked: 'Создать чат можно после загрузки списка',
  },
  en: {
    loading: 'Loading chats…',
    failed: 'Chats could not be loaded',
    network: 'No connection to the server',
    timeout: 'The server did not respond in time',
    server: 'Server error',
    retry: 'Retry',
    blocked: 'You can create a chat after the list loads',
  },
};

test('PROJECT-CHAT-LOAD-01', async (t) => {
  for (const dockCapable of [false, true]) {
    for (const reason of [null, 'network', 'timeout', 'server']) {
      await t.test(`${dockCapable ? 'широкий' : 'телефон'} ${reason ?? 'loading'}`, async (sub) => {
        const { wrapper, harness } = await mountView(sub, {
          dockCapable,
          opened: DETAIL,
          params: { id: 'demo' },
          chatState: {
            loaded: false,
            loading: !reason,
            loadError: reason,
          },
        });
        const locale = await import('../../web/src/services/locale.ts');
        const { nextTick } = await import('../../web/node_modules/vue/index.mjs');
        const button = wrapper.find('[aria-label="Чат с проектом"]');

        assert.equal(button.element.disabled, true);
        assert.ok(wrapper.find('[data-role="project-form"]').isVisible());

        for (const language of ['ru', 'en']) {
          locale.setUiLocale(language);
          await nextTick();

          const text = CHAT_LOAD_TEXT[language];

          assert.ok(wrapper.text().includes(text.blocked), 'объяснение видно рядом с действием');
          assert.ok(wrapper.text().includes(reason ? text.failed : text.loading));

          if (reason) {
            assert.ok(wrapper.text().includes(text[reason]));
            assert.equal(wrapper.findAll('button').some((item) => item.text() === text.retry), true);
          }
        }

        assert.equal(harness.calls.some(([kind]) => kind === 'chat'), false);
        assert.equal(harness.calls.some(([kind]) => kind === 'chat-load'), false);

        if (reason) {
          const retry = wrapper.findAll('button').find((item) => item.text() === CHAT_LOAD_TEXT.en.retry);

          await retry.trigger('click');
          assert.equal(harness.calls.filter(([kind]) => kind === 'chat-retry').length, 1);
          await nextTick();
          assert.equal(retry.element.disabled, true);
        }
      });
    }
  }
});

test('PROJECT-CHAT-LOAD-02', async (t) => {
  await t.test('готовность потеряна во время await', async (sub) => {
    const { wrapper, harness } = await mountView(sub, { opened: DETAIL, params: { id: 'demo' } });
    const { flushPromises } = await import(
      '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    );
    const gate = Promise.withResolvers();

    sub.after(() => gate.resolve());
    harness.chatLoad = gate.promise;
    await wrapper.find('[aria-label="Чат с проектом"]').trigger('click');
    harness.chat.loaded = false;
    gate.resolve();
    await flushPromises();
    assert.equal(harness.calls.some(([kind]) => kind === 'chat'), false);
    assert.deepEqual(harness.pushes, []);
  });

  await t.test('готовый стор сохраняет project/repo', async (sub) => {
    const detail = {
      ...DETAIL,
      repos: [...DETAIL.repos, {
        key: 'ui',
        dir: '/srv/demo/ui',
        exists: true,
      }],
    };
    const selectedKey = detail.repos[1].key;
    const { wrapper, harness } = await mountView(sub, { opened: detail, params: { id: 'demo' } });
    const { flushPromises } = await import(
      '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    );

    await wrapper.find(`[data-role="project-repo-default"][data-repo-key="${selectedKey}"]`)
      .trigger('change');
    await wrapper.find('[aria-label="Чат с проектом"]').trigger('click');
    await flushPromises();
    assert.deepEqual(harness.calls.filter(([kind]) => kind === 'chat'), [[
      'chat',
      {
        workdir: {
          kind: 'project',
          projectId: DETAIL.id,
          repoKey: selectedKey,
        },
        title: `Проект · ${DETAIL.title}`,
      },
    ]]);
    assert.deepEqual(harness.pushes, ['/chats']);
  });

  await t.test('null id не открывает чаты', async (sub) => {
    const { wrapper, harness } = await mountView(sub, { opened: DETAIL, params: { id: 'demo' } });
    const { flushPromises } = await import(
      '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    );

    harness.chatId = null;
    await wrapper.find('[aria-label="Чат с проектом"]').trigger('click');
    await flushPromises();
    assert.equal(harness.calls.filter(([kind]) => kind === 'chat').length, 1);
    assert.deepEqual(harness.pushes, []);
  });
});
