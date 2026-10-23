import assert from 'node:assert/strict';
import test from 'node:test';

import { makeCatalogInput, makeDraft } from '../fixtures/routes-editor.mjs';
import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const VIEW = webFile('src/views/RoutesView.vue');
const UI_STUB = `
import { defineComponent, h } from 'vue';
export { default as UiIconButton } from './src/components/primitives/UiIconButton.vue';
export const UiButton = defineComponent({
  props: ['disabled', 'loading'], emits: ['click'],
  setup(props, { slots, emit }) {
    return () => h('button', { disabled: props.disabled, onClick: () => emit('click') }, slots.default?.());
  },
});
export const UiSelectableRow = defineComponent({
  props: ['selected'], emits: ['select'], setup(props, { slots, emit }) {
    return () => h('button', {
      'data-selected': String(Boolean(props.selected)), onClick: () => emit('select'),
    }, slots.default?.());
  },
});
export { default as UiPaneHeader } from './src/components/composites/UiPaneHeader.vue';
export { default as UiTabs } from './src/components/composites/UiTabs.vue';
export { default as UiTab } from './src/components/composites/UiTab.vue';
export { default as UiInlineMessage } from './src/components/feedback/UiInlineMessage.vue';
export const UiSpinner = defineComponent({ setup: () => () => h('span', '…') });
export const UiTooltip = defineComponent({ setup: () => () => h('span') });
export const confirmDialog = async () => true;
`;
const SWITCHER_STUB = `
import { defineComponent, h } from 'vue';
export default defineComponent({
  props: ['profiles', 'modelValue'], emits: ['update:modelValue', 'create', 'manage'],
  setup(props, { emit }) {
    return () => h('div', [
      h('select', {
        'data-test': 'project-switcher', value: props.modelValue,
        onChange: (event) => emit('update:modelValue', event.target.value),
      }, props.profiles.map((profile) => h('option', { value: profile }, profile))),
      h('button', { 'data-test': 'manage-project',
        onClick: () => emit('manage', props.modelValue) }, 'Управление'),
      h('button', { 'data-test': 'create-project', onClick: () => emit('create') }, '+'),
    ]);
  },
});
`;

async function fixture(t, {
  query = {}, drafts = [], currentCatalogHash = null, createResponse = null,
  publishSupported = false, revisions = [], catalogInput = null, rebasePreview = null,
  editorGate = null,
  profiles = () => ['sample', 'other'],
} = {}) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/routes');
  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const { createPinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  const route = reactive({ path: '/routes', query: { profile: 'sample', ...query } });
  const pushes = [];
  const router = {
    async push(target) {
      pushes.push(target);
      if (target?.query) route.query = { ...target.query };
    },
    async replace(target) {
      pushes.push(target);
      if (target?.query) route.query = { ...target.query };
    },
  };
  const draft = createResponse ?? makeDraft();
  const calls = [];
  const api = {
    get: async (url) => {
      calls.push(['get', url]);

      if (url === '/api/profiles') {
        return { profiles: await profiles() };
      }
      if (url.endsWith('/revisions')) return {
        profile: url.includes('/other/') ? 'other' : 'sample',
        publishSupported, currentCatalogHash,
        revisions,
      };
      if (url.endsWith('/editor')) await editorGate;
      if (url.endsWith('/editor')) return {
        profile: url.includes('/other/') ? 'other' : 'sample',
        source: { mode: 'editor', revision: 1 },
        currentCatalogHash, capabilitiesHash: null,
        capabilities: {
          schema: 1, commands: [], contextSections: [],
          filesystem: [], timeoutClasses: [], retryStrategies: [],
        }, issues: [],
      };
      if (url.endsWith(`/drafts/${draft.id}`)) return draft;
      if (url.endsWith('/drafts')) return { drafts };
      if (rebasePreview && url.endsWith(`/drafts/${draft.id}/rebase/preview`)) {
        return rebasePreview;
      }
      if (url.includes('/drafts/')) throw new Error('Черновик не найден');
      if (catalogInput && url.includes('/catalog/') && url.includes('/graph?route=')) {
        return { graph: { nodes: { build: ['agent', 'Сборка', ''] },
          pos: { build: [140, 55] }, edges: [['_start', 'build', '', 'plain', 'h']] } };
      }
      if (catalogInput && url.includes('/catalog/')) {
        const catalogHash = url.split('/').at(-1);
        return { catalogHash, catalog: { schema: 2, profile: 'sample',
          routes: { quick: 'c'.repeat(64) }, bootstrap: { file: 'bootstrap/scout.json' } },
        bootstrap: catalogInput.bootstrap, prompts: catalogInput.bootstrapPrompts,
        manifest: { schema: 2, kind: 'catalog', profile: 'sample', algorithm: 'sha256', files: [] } };
      }
      if (catalogInput && url.includes('/routes/quick/')) {
        return { routeHash: 'c'.repeat(64), route: catalogInput.routes.quick.route,
          prompts: catalogInput.routes.quick.prompts,
          manifest: { schema: 2, kind: 'route', profile: 'sample', id: 'quick',
            algorithm: 'sha256', files: [] } };
      }
      throw new Error(`Неожиданный GET: ${url}`);
    },
    post: async (url, body) => {
      calls.push(['post', url, body]);
      return draft;
    },
    put: async (url, body) => {
      calls.push(['put', url, body]);
      return { changed: true, catalogHash: body.desiredCatalogHash };
    },
  };

  globalThis.__routesViewHarness = {
    route,
    router,
    api,
    listeners: []
  };
  setActivePinia(createPinia());

  const component = await compileVue(VIEW, { stubs: {
    '../ui': (UI_STUB) +
      "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
    '../shared/apiClient.ts': 'export const api = globalThis.__routesViewHarness.api;'
      + ' export const failureText = (error) => error.message;',
    './apiClient.ts': 'export const api = globalThis.__routesViewHarness.api;'
      + ' export const failureText = (error) => error.message;',
    'vue-router': 'export const useRoute = () => globalThis.__routesViewHarness.route;'
      + ' export const useRouter = () => globalThis.__routesViewHarness.router;'
      + ' export const onBeforeRouteLeave = () => {};'
      + ' export const onBeforeRouteUpdate = () => {};',
    '../composables/useUiContextSource.ts':
      'export const useUiContextSource = () => ({ focus() {}, update() {}, blur() {} });',
      '../../composables/useSse.ts': 'export const sseSubscribe = (fn) => {'
        + ' globalThis.__routesViewHarness.listeners.push(fn); return () => {}; };',
    '../features/projects/ProjectSwitcher.vue': SWITCHER_STUB,
    './pipeline/FactoryGraph.vue': 'export default { template: "<div />" };',
    './routes/RoutePromptEditor.vue': 'export default { template: "<div />" };',
    './routes/RouteJsonEditor.vue': `export default { template: '<div data-test="json-editor" />' };`,
    './routes/RouteBootstrapEditor.vue': `
      import { defineComponent, h } from 'vue';
      export default defineComponent({ emits: ['select-node'],
        setup(_, { emit }) { return () => h('button', {
          'data-test': 'bootstrap-choose-scout', onClick: () => emit('select-node',
            { scope: { kind: 'bootstrap' }, nodeId: 'scout' }),
        }, 'Начальная разведка'); } });`,
    './routes/RouteCanvas.vue': `
      import { defineComponent, h } from 'vue';
      export default defineComponent({ props: ['scope'], emits: ['select-node'],
        setup(props, { emit }) { return () => h('button', {
          'data-test': 'choose-check', onClick: () => emit('select-node',
            { scope: props.scope, nodeId: 'check' }),
        }, 'Схема маршрута'); } });`,
    './routes/RouteStageList.vue': `
      import { defineComponent, h } from 'vue';
      export default defineComponent({ props: ['scope'], emits: ['select-node'],
        setup(props, { emit }) { return () => h('button', {
          'data-test': 'stage-choose-build', onClick: () => emit('select-node',
            { scope: props.scope, nodeId: 'build' }),
        }, 'Список этапов'); } });`,
    './routes/RouteNodeInspector.vue': `
      export default { props: ['nodeId'], template: '<div data-test="node-inspector">{{ nodeId }}</div>' };`,
    './routes/RouteTransitionInspector.vue':
      `export default { template: '<div data-test="transition-inspector"></div>' };`,
  } });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, { attachTo: browser.document.querySelector('#mount') });
  t.after(() => { wrapper.unmount(); delete globalThis.__routesViewHarness; });
  await flushPromises();

  return {
    wrapper,
    route,
    pushes,
    calls,
    draft,
    flushPromises,

    emit: (name, data) => globalThis.__routesViewHarness.listeners.forEach((fn) => fn(name, data)),

  };
}

test('RE-E2-01: URL открывает адресованный draft и маршрут после mount/reload', async (t) => {
  const draft = makeDraft();
  const { wrapper, calls } = await fixture(t, {
    query: {
      draft: draft.id,
      route: 'quick',
      tab: 'graph'
    },
    drafts: [{
      id: draft.id, profile: 'sample', title: draft.title, revision: 1,
      baseCatalogHash: null, state: 'editing', updatedAt: draft.updatedAt,
    }],
  });
  assert.equal(calls.some((call) => call[1] === `/api/routes/sample/drafts/${draft.id}`), true);
  assert.match(wrapper.text(), /Черновик быстрого маршрута/);
  assert.match(wrapper.text(), /build/);
  assert.match(wrapper.text(), /Сохранено/);
  assert.equal(wrapper.findAll('.route-catalog [aria-selected="true"]').some((row) =>
    row.text().includes(draft.title)), true);
});

test('RE-G4-01: открытый черновик предлагает переносимый JSON export/import', async (t) => {
  const draft = makeDraft();
  const { wrapper } = await fixture(t, {
    query: {
      draft: draft.id,
      route: 'quick',
      tab: 'graph'
    },
  });
  assert.match(wrapper.text(), /Экспорт и импорт JSON/);
});

test('RE-G5-01: черновик открывает отдельный JSON-режим полного авторского документа',
  async (t) => {
    const draft = makeDraft();
    const { wrapper } = await fixture(t, {
      query: {
        draft: draft.id,
        route: 'quick',
        tab: 'graph'
      },
    });
    assert.equal(wrapper.find('[data-test="route-json-tab"]').exists(), true);
  });

test('RE-F5-01: выбор узла схемы меняет query и открывает инспектор этого узла',
  async (t) => {
    const draft = makeDraft();
    const { wrapper, route, flushPromises } = await fixture(t, {
      query: {
        draft: draft.id,
        route: 'quick',
        tab: 'graph'
      },
    });
    await wrapper.find('[data-test="choose-check"]').trigger('click');
    await flushPromises();
    assert.equal(route.query.route, 'quick');
    assert.equal(route.query.node, 'check');
    assert.equal(route.query.tab, 'graph');
    assert.equal(wrapper.find('[data-test="node-inspector"]').text(), 'check');
  });

test('RE-F5-05: выбор из списка этапов открывает тот же инспектор и query', async (t) => {
  const draft = makeDraft();
  const { wrapper, route, flushPromises } = await fixture(t, {
    query: {
      draft: draft.id,
      route: 'quick',
      tab: 'graph'
    },
  });
  await wrapper.find('[data-test="stage-choose-build"]').trigger('click');
  await flushPromises();
  assert.equal(route.query.node, 'build');
  assert.equal(wrapper.find('[data-test="node-inspector"]').text(), 'build');
});

test('RE-F7-04: bootstrap выбирается отдельным scope без резервирования route ID',
  async (t) => {
    const draft = makeDraft();
    const { wrapper, route, flushPromises } = await fixture(t, {
      query: {
        draft: draft.id,
        route: 'quick',
        tab: 'graph'
      },
    });
    await wrapper.find('[data-test="catalog-bootstrap"]').trigger('click');
    await flushPromises();
    assert.equal(route.query.scope, 'bootstrap');
    assert.equal(route.query.route, undefined);
    assert.equal(route.query.node, 'scout');
    assert.ok(wrapper.find('[data-test="bootstrap-choose-scout"]').exists());
    await wrapper.find('[data-test="bootstrap-choose-scout"]').trigger('click');
    await flushPromises();
    assert.equal(route.query.scope, 'bootstrap');
    assert.equal(route.query.node, 'scout');
  });

test('RE-E2-02: создание из current передаёт точный hash и открывает отдельный draft',
  async (t) => {
    const catalogHash = 'a'.repeat(64);
    const { wrapper, calls, route, draft, flushPromises } = await fixture(t,
      { currentCatalogHash: catalogHash });
    const create = wrapper.findAll('button').find((button) =>
      button.attributes('aria-label') === 'Создать черновик из current');
    assert.ok(create);
    await create.trigger('click');
    await flushPromises();
    assert.deepEqual(calls.find((call) => call[0] === 'post'), [
      'post', '/api/routes/sample/drafts',
      { kind: 'catalog', title: 'Новый черновик', catalogHash },
    ]);
    assert.equal(route.query.draft, draft.id);
    assert.equal(route.query.profile, 'sample');
    assert.equal(calls.some((call) => call[0] === 'put' || call[0] === 'patch'), false);
  });

test('RE-E2-06: создание ждёт начальной загрузки, иначе она закрыла бы новый черновик',
  async (t) => {
    let releaseEditor;
    const editorGate = new Promise((resolve) => { releaseEditor = resolve; });
    const { wrapper, calls, route, draft, flushPromises } = await fixture(t,
      { currentCatalogHash: 'a'.repeat(64), editorGate });
    const create = () => wrapper.findAll('button').find((button) =>
      button.attributes('aria-label') === 'Создать черновик из current');

    assert.equal(create().attributes('disabled'), '');
    await create().trigger('click');
    await flushPromises();
    assert.equal(calls.some((call) => call[0] === 'post'), false);

    releaseEditor();
    await flushPromises();
    assert.equal(create().attributes('disabled'), undefined);
    await create().trigger('click');
    await flushPromises();
    assert.equal(route.query.draft, draft.id);
  });

test('RE-E2-03: без current создаётся пустой draft с объяснением недоступной публикации',
  async (t) => {
    const empty = makeDraft();
    empty.routes = {};
    const { wrapper, calls, route, flushPromises } = await fixture(t,
      { createResponse: empty });
    const create = wrapper.findAll('button').find((button) =>
      button.attributes('aria-label') === 'Создать черновик');
    assert.ok(create);
    await create.trigger('click');
    await flushPromises();
    assert.deepEqual(calls.find((call) => call[0] === 'post'), [
      'post', '/api/routes/sample/drafts', { kind: 'empty', title: 'Новый черновик' },
    ]);
    assert.equal(route.query.draft, empty.id);
    assert.match(wrapper.text(), /Публикация недоступна.*добавьте маршрут/i);
  });

test('RE-E2-04: неизвестный route и неверный draft query дают ошибку без подмены выбора',
  async (t) => {
    const draft = makeDraft();
    const { wrapper, route, calls, flushPromises } = await fixture(t, {
      query: { draft: draft.id, route: 'missing' },
    });
    assert.match(wrapper.find('[role="alert"]').text(), /Маршрут «missing» отсутствует/);
    assert.equal(wrapper.find('.route-draft-panel').exists(), false);

    route.query = {
      profile: 'sample', draft: '22222222-2222-4222-8222-222222222222', route: 'quick',
    };
    await flushPromises();
    assert.match(wrapper.find('[role="alert"]').text(), /Черновик не найден/);
    assert.equal(wrapper.find('.route-editor-header').exists(), false);

    route.query = { profile: 'sample', draft: 'not-uuid', route: 'quick' };
    await flushPromises();
    assert.match(wrapper.find('[role="alert"]').text(), /Некорректный ID черновика/);
    assert.equal(calls.some((call) => call[1]?.includes('/drafts/not-uuid')), false);
  });

test('RE-E2-05: ProjectSwitcher меняет адрес и данные, создание ведёт в паспорт проекта',
  async (t) => {
    const { wrapper, route, calls, pushes, flushPromises } = await fixture(t);
    await wrapper.find('[data-test="project-switcher"]').setValue('other');
    await flushPromises();
    assert.equal(route.query.profile, 'other');
    assert.equal(calls.some((call) => call[1] === '/api/routes/other/revisions'), true);
    assert.equal(calls.some((call) => call[1] === '/api/routes/other/editor'), true);
    assert.equal(calls.some((call) => call[1] === '/api/routes/other/drafts'), true);

    await wrapper.find('[data-test="create-project"]').trigger('click');
    assert.deepEqual(pushes.at(-1), { path: '/projects', query: { create: '1' } });
    assert.equal(calls.some((call) => call[1] === '/api/profiles' && call[0] === 'post'), false);
  });

test('RE-E6-06: в режиме editor старая кнопка профильной публикации недоступна',
  async (t) => {
    const { wrapper } = await fixture(t, { publishSupported: true });
    assert.equal(wrapper.findAll('button').some((button) =>
      button.text().trim() === 'Опубликовать'), false);
  });

test('RE-E6-06: опубликованный catalog показывает состав и доступный откат', async (t) => {
  const current = 'a'.repeat(64);
  const previous = 'b'.repeat(64);
  const revisions = [current, previous].map((catalogHash, index) => ({
    catalogHash, createdAt: '2026-01-01T00:00:00.000Z', isCurrent: index === 0,
    routes: { quick: 'c'.repeat(64) }, integrity: 'ok',
  }));
  const { wrapper, calls, route, flushPromises } = await fixture(t, {
    query: { catalog: current, route: 'quick' }, currentCatalogHash: current,
    revisions, catalogInput: makeCatalogInput(),
  });

  assert.match(wrapper.text(), /Опубликован/);
  assert.match(wrapper.text(), /Создай проверяемый результат/);
  assert.equal(wrapper.find('.revs').exists(), true);
  const rollback = wrapper.findAll('button').find((button) => button.text().trim() === 'Откатить');
  assert.ok(rollback);
  await rollback.trigger('click');
  await flushPromises();
  assert.equal(calls.some((call) => call[0] === 'put'
    && call[1] === '/api/routes/sample/current'
    && call[2].desiredCatalogHash === previous), true);
  assert.equal(route.query.catalog, previous);
  assert.match(wrapper.text(), /источник маршрутов — редактор/);
});

test('RE-H1-02: просмотр исторической ревизии запрашивает граф её точного каталога',
  async (t) => {
    const current = 'a'.repeat(64);
    const historical = 'b'.repeat(64);
    const { wrapper, calls } = await fixture(t, {
      query: { catalog: historical, route: 'quick' },
      currentCatalogHash: current,
      revisions: [
        { catalogHash: current, createdAt: '2026-01-02T00:00:00.000Z', isCurrent: true,
          routes: { quick: 'd'.repeat(64) }, integrity: 'ok' },
        { catalogHash: historical, createdAt: '2026-01-01T00:00:00.000Z', isCurrent: false,
          routes: { quick: 'c'.repeat(64) }, integrity: 'ok' },
      ],
      catalogInput: makeCatalogInput(),
    });
    assert.equal(calls.some((call) => call[1]
      === `/api/routes/sample/catalog/${historical}/graph?route=quick`), true);
    assert.equal(calls.some((call) => call[1]
      === `/api/routes/sample/catalog/${current}/graph?route=quick`), false);
    assert.equal(wrapper.find('[data-test="json-editor"]').exists(), false);
  });

test('RE-G2-01: устаревшее основание открывает preview переноса полного черновика',
  async (t) => {
    const draft = makeDraft();
    const currentCatalogHash = 'b'.repeat(64);
    draft.baseCatalogHash = 'a'.repeat(64);
    const rebasePreview = { draftId: draft.id, draftRevision: draft.revision,
      baseCatalogHash: draft.baseCatalogHash, currentCatalogHash, conflicts: [] };
    const { wrapper, calls, flushPromises } = await fixture(t, {
      query: { draft: draft.id }, createResponse: draft, currentCatalogHash,
      rebasePreview,
    });
    const button = wrapper.findAll('button').find((item) =>
      item.text().trim() === 'Обновить основу черновика');
    assert.ok(button);
    await button.trigger('click');
    await flushPromises();
    assert.equal(calls.some((call) => call[0] === 'get'
      && call[1] === `/api/routes/sample/drafts/${draft.id}/rebase/preview`), true);
    assert.match(wrapper.text(), /Независимые правки объединятся/);
  });

test('RET-LOAD: инструкции обоих scope не загружают библиотеку', async (t) => {
  for (const scope of ['route', 'bootstrap']) {
    await t.test(scope, async (t) => {
      const draft = makeDraft();
      const query = scope === 'route'
        ? {
          draft: draft.id,
          route: 'quick',
          node: 'build',
          tab: 'prompt',
        }
        : {
          draft: draft.id,
          scope: 'bootstrap',
          node: 'scout',
          tab: 'prompt',
        };
      const { wrapper, calls, route, flushPromises } = await fixture(t, { query, createResponse: draft });

      await flushPromises();
      assert.equal(calls.some(([method, url]) => method === 'get'
        && url === `/api/routes/sample/drafts/${draft.id}`), true);
      assert.ok(wrapper.text().includes(`Черновик · r${draft.revision}`));
      assert.equal(wrapper.find('[role="alert"]').exists(), false);
      assert.equal(route.query.tab, 'prompt');
      assert.equal(route.query.node, query.node);

      const retiredApi = ['', 'api', 'agents'].join('/');

      assert.deepEqual(calls.filter(([method, url]) => method === 'get' && url === retiredApi), []);
    });
  }
});

test('PD-entry: управление из черновиков ведёт в паспорт выбранного проекта', async (t) => {
  const { wrapper, pushes, flushPromises } = await fixture(t);

  await wrapper.get('[data-test="manage-project"]').trigger('click');
  await flushPromises();

  const target = pushes.at(-1);

  assert.equal(typeof target === 'string' ? target : target?.path, '/projects/sample');
});

for (const event of ['projects-changed', 'hello']) {
  test(`PD-routes: ${event} сбрасывает исчезнувший профиль без подстановки соседа`, async (t) => {
    let deleted = false;
    const { wrapper, route, calls, flushPromises, emit } = await fixture(t, {
      profiles: () => deleted ? ['other'] : ['sample', 'other'],
    });

    deleted = true;
    emit(event, {
      id: 'sample',
      revision: 3,
      kind: 'deleted'
    });
    await flushPromises();
    assert.equal(calls.filter((call) => call[1] === '/api/profiles').length >= 2, true);
    assert.equal(route.query.profile ?? '', '');
    assert.equal(wrapper.get('[data-test="project-switcher"]').element.value, '');
  });
}

test('PD-routes: dirty удалённого проекта остаётся для чтения без серверного export', async (t) => {
  let deleted = false;
  const draft = makeDraft();
  const { wrapper, calls, emit, flushPromises } = await fixture(t, {
    query: {
      draft: draft.id,
      route: 'quick',
      tab: 'graph'
    },
    profiles: () => deleted ? ['other'] : ['sample', 'other'],
  });
  const { useRoutesStore } = await compileModule(webFile('src/stores/routes.ts'));
  const store = useRoutesStore();

  assert.equal(store.opened.profile, 'sample', 'fixture открыла настоящий draft');
  store.localDocument.title = 'Несохранённый текст';
  store.dirty = true;
  deleted = true;
  emit('projects-changed', {
    id: 'sample',
    revision: 3,
    kind: 'deleted'
  });
  await flushPromises();
  assert.equal(store.localDocument.title, 'Несохранённый текст');
  assert.equal(store.opened.readOnly, true);
  assert.match(wrapper.text(), /Регистрация проекта удалена.*Несохранённые изменения сохранить нельзя/su);
  assert.equal(calls.some((call) => call[1]?.includes('/export')), false);
});

test('PD-routes: поздний draft не возвращает документ удалённого профиля', async (t) => {
  let deleted = false;
  const slow = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const { route, emit, flushPromises } = await fixture(t, {
    profiles: () => deleted ? ['other'] : ['sample', 'other'],
  });
  const api = globalThis.__routesViewHarness.api;
  const get = api.get.bind(api);
  const draft = { ...makeDraft(), id: '22222222-2222-4222-8222-222222222222' };

  api.get = async (url) => {
    if (url.endsWith(`/drafts/${draft.id}`)) {
      entered.resolve();

      return slow.promise;
    }

    return get(url);
  };
  route.query = {
    profile: 'sample',
    draft: draft.id,
    route: 'quick'
  };
  await entered.promise;
  deleted = true;
  emit('projects-changed', {
    id: 'sample',
    revision: 3,
    kind: 'deleted'
  });
  await flushPromises();
  slow.resolve(draft);
  await flushPromises();

  const { useRoutesStore } = await compileModule(webFile('src/stores/routes.ts'));
  const store = useRoutesStore();

  assert.equal(route.query.profile ?? '', '');
  assert.equal(store.opened, null);
  assert.equal(store.localDocument, null);
});
