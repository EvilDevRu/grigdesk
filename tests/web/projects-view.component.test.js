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
  confirmed = true,
  saveResult = { ok: true, error: '', fieldErrors: [] },
} = {}) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/projects');
  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
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
    lifecycleResult: { ok: true, error: '', message: '' },
    leaveGuards: [],
    saveResult,
    updateGuards: [],
    pushes,
    store,
    route,
    router: {
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
      '../stores/chat.js': `export const useChatStore = () => ({
        async _load() {},
        newSession: (options) => globalThis.__projectsViewHarness.calls.push(['chat', options]),
      });`,
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
