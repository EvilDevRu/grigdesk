import assert from 'node:assert/strict';
import test from 'node:test';

import { makeCatalogInput, makeDraft } from '../fixtures/routes-editor.mjs';
import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const VIEW = webFile('src/views/RoutesView.vue');
const UI_STUB = `
export * from './src/ui.ts';
export { default as UiLoadingState } from './src/components/feedback/UiLoadingState.vue';
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
export const confirmDialog = async (...args) => {
  globalThis.__routesViewHarness.confirmations.push(args);

  return globalThis.__routesViewHarness.confirmed;
};
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

const CANVAS_STUB = `
      import { defineComponent, h } from 'vue';
      export default defineComponent({ props: ['scope'], emits: ['select-node'],
        setup(props, { emit }) { return () => h('button', {
          'data-test': 'choose-check', onClick: () => emit('select-node',
            { scope: props.scope, nodeId: 'check' }),
        }, 'Схема маршрута'); } });`;
const STAGE_LIST_STUB = `
      import { defineComponent, h } from 'vue';
      export default defineComponent({ props: ['scope'], emits: ['select-node'],
        setup(props, { emit }) { return () => h('button', {
          'data-test': 'stage-choose-build', onClick: () => emit('select-node',
            { scope: props.scope, nodeId: 'build' }),
        }, 'Список этапов'); } });`;

function summaryOf(draft) {
  const { id, profile, title, revision, baseCatalogHash, state, updatedAt } = draft;

  return {
    id,
    profile,
    title,
    revision,
    baseCatalogHash,
    state,
    updatedAt,
  };
}

/**
 * Изолирует экран, сеть и диалоги от живых данных проекта.
 * Полные документы и список метаданных меняются только через тестовый API.
 */
async function fixture(t, {
  query = {}, drafts = [], currentCatalogHash = null, createResponse = null,
  publishSupported = false, revisions = [], catalogInput = null, rebasePreview = null,
  editorGate = null, graphGate = null, revisionsGate = null,
  sourceMode = 'editor', documents = [], realCanvas = false,
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
  const documentMap = new Map([draft, ...documents].map((item) => [item.id, item]));
  const summaries = [...drafts];
  const calls = [];
  const api = {
    get: async (url) => {
      calls.push(['get', url]);

      if (url === '/api/profiles') {
        return { profiles: await profiles() };
      }
      if (url.endsWith('/revisions')) {
        await revisionsGate;
      }
      if (url.endsWith('/revisions')) return {
        profile: url.includes('/other/') ? 'other' : 'sample',
        publishSupported, currentCatalogHash,
        revisions,
      };
      if (url.endsWith('/editor')) await editorGate;
      if (url.endsWith('/editor')) {
        return {
          profile: url.includes('/other/') ? 'other' : 'sample',
          source: { mode: sourceMode, revision: 1 },
          currentCatalogHash,
          capabilitiesHash: null,
          capabilities: {
            schema: 1,
            commands: [],
            contextSections: [],
            filesystem: [],
            timeoutClasses: [],
            retryStrategies: [],
          },
          issues: [],
        };
      }

      const documentId = url.match(/\/drafts\/([^/]+)$/)?.[1];

      if (documentId && documentMap.has(documentId)) {
        return documentMap.get(documentId);
      }
      if (url.endsWith('/drafts')) {
        return { drafts: summaries };
      }
      if (rebasePreview && url.endsWith(`/drafts/${draft.id}/rebase/preview`)) {
        return rebasePreview;
      }
      if (url.includes('/drafts/')) throw new Error('Черновик не найден');
      if (catalogInput && (url.includes('/graph?route=') || url.includes('/graph?c='))) {
        await graphGate;

        return { graph: { nodes: { build: ['agent', 'Сборка', ''] },
          pos: { build: [140, 55] }, edges: [['_start', 'build', '', 'plain', 'h']] } };
      }
      if (catalogInput && url.includes('/catalog/')) {
        const catalogHash = url.split('/').at(-1);

        return {
          catalogHash,
          catalog: {
            schema: 2,
            profile: 'sample',
            routes: Object.fromEntries(Object.keys(catalogInput.routes).map((id) => [id, 'c'.repeat(64)])),
            bootstrap: { file: 'bootstrap/scout.json' },
          },
          bootstrap: catalogInput.bootstrap,
          prompts: catalogInput.bootstrapPrompts,
          manifest: {
            schema: 2,
            kind: 'catalog',
            profile: 'sample',
            algorithm: 'sha256',
            files: [],
          },
        };
      }

      const routeId = url.match(/\/routes\/([^/]+)\/[a-f0-9]{64}$/)?.[1];

      if (catalogInput && routeId && catalogInput.routes[routeId]) {
        return {
          routeHash: 'c'.repeat(64),
          route: catalogInput.routes[routeId].route,
          prompts: catalogInput.routes[routeId].prompts,
          manifest: {
            schema: 2,
            kind: 'route',
            profile: 'sample',
            id: routeId,
            algorithm: 'sha256',
            files: [],
          },
        };
      }
      throw new Error(`Неожиданный GET: ${url}`);
    },
    post: async (url, body) => {
      calls.push(['post', url, body]);

      if (url.endsWith('/publish')) {
        return {
          profile: 'sample',
          mode: body.mode,
          currentCatalogHash,
          result: {
            catalogCreated: false,
            catalogHash: currentCatalogHash,
            произвольное: 'Отчёт профиля',
          },
        };
      }
      if (url.endsWith('/drafts')) {
        documentMap.set(draft.id, draft);
        summaries.push(summaryOf(draft));
      }

      return draft;
    },
    patch: async (url, body) => {
      calls.push(['patch', url, body]);

      const saved = structuredClone(documentMap.get(url.split('/').at(-1)));

      assert.equal(body.expectedRevision, saved.revision);

      for (const operation of body.operations) {
        if (operation.kind === 'putRoute') {
          saved.routes[operation.routeId] = { route: operation.route, prompts: operation.prompts };
        }
      }

      saved.revision += 1;
      documentMap.set(saved.id, saved);

      return saved;
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
    confirmed: true,
    confirmations: [],
    listeners: []
  };
  setActivePinia(createPinia());

  const component = await compileVue(VIEW, { expose: ['closeDraft', 'load', 'loadGraph'], stubs: {
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
    './routes/RoutePromptEditor.vue': `
      import { defineComponent, h } from 'vue';
      export default defineComponent({
        name: 'RoutePromptEditor', props: ['document', 'routeId', 'nodeId', 'focusPath'],
        emits: ['change', 'save', 'end-history-group'],
        setup(props) {
          return () => h('div', { 'data-test': 'prompt-editor', 'data-node': props.nodeId });
        },
      });`,
    './routes/RouteJsonEditor.vue': `export default { template: '<div data-test="json-editor" />' };`,
    './routes/RouteBootstrapEditor.vue': `
      import { defineComponent, h } from 'vue';
      export default defineComponent({ emits: ['select-node'],
        setup(_, { emit }) { return () => h('button', {
          'data-test': 'bootstrap-choose-scout', onClick: () => emit('select-node',
            { scope: { kind: 'bootstrap' }, nodeId: 'scout' }),
        }, 'Начальная разведка'); } });`,
    ...(!realCanvas ? {
      './routes/RouteCanvas.vue': CANVAS_STUB,
      './RouteCanvas.vue': CANVAS_STUB,
    } : {}),
    './routes/RouteStageList.vue': STAGE_LIST_STUB,
    './RouteStageList.vue': STAGE_LIST_STUB,
    './routes/RouteNodeInspector.vue': `
      export default { props: ['nodeId'], template: '<div data-test="node-inspector">{{ nodeId }}</div>' };`,
    './routes/RouteTransitionInspector.vue':
      `export default { template: '<div data-test="transition-inspector"></div>' };`,
  } });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, { attachTo: browser.document.querySelector('#mount') });

  t.after(() => {
    wrapper.vm.closeDraft();
    wrapper.unmount();
    delete globalThis.__routesViewHarness;
  });
  await flushPromises();

  return {
    wrapper,
    route,
    pushes,
    calls,
    draft,
    api,
    summaries,
    harness: globalThis.__routesViewHarness,
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

const CURRENT = 'a'.repeat(64);
const HISTORICAL = 'b'.repeat(64);

/**
 * Даёт две публикационные строки и документы из того же каталога.
 * Вторая строка нужна, чтобы вход в правку не мог незаметно выбрать первую.
 */
function publishedOptions(overrides = {}) {
  const catalogInput = makeCatalogInput();
  const second = structuredClone(catalogInput.routes.quick);

  second.route.id = 'second';
  second.route.title = 'Второй маршрут';
  catalogInput.routes.second = second;

  const createResponse = makeDraft();

  createResponse.routes = structuredClone(catalogInput.routes);
  createResponse.baseCatalogHash = CURRENT;

  return {
    currentCatalogHash: CURRENT,
    catalogInput,
    createResponse,
    revisions: [CURRENT, HISTORICAL].map((catalogHash, index) => ({
      catalogHash,
      createdAt: `2026-01-0${2 - index}T00:00:00.000Z`,
      isCurrent: index === 0,
      routes: { quick: 'c'.repeat(64), second: 'c'.repeat(64) },
      integrity: 'ok',
    })),
    ...overrides,
  };
}

function profileAction(wrapper, prefix) {
  return wrapper.findAll('button').find((button) => button.text().trim().startsWith(prefix));
}

/**
 * Выполняет прежний цикл пересборки без настоящего профильного скрипта.
 * Подтверждение и отчёт наблюдаются через публичный экран и журнал API.
 */
async function assertProfileRebuild(client, expectedCatalogHash) {
  const { wrapper, calls, flushPromises, harness } = client;
  const revisionReads = () => calls.filter((call) => call[1].endsWith('/revisions')).length;
  const posts = () => calls.filter((call) => call[0] === 'post');
  const before = revisionReads();

  assert.ok(profileAction(wrapper, 'Проверить'));
  assert.ok(profileAction(wrapper, 'Опубликовать'));
  await profileAction(wrapper, 'Проверить').trigger('click');
  await flushPromises();
  assert.deepEqual(posts(), [['post', '/api/routes/sample/publish', { mode: 'validate' }]]);
  assert.equal(revisionReads(), before, 'проверка не перечитывает current');
  assert.match(wrapper.get('.report').text(), /Отчёт профиля/);

  harness.confirmed = false;
  await profileAction(wrapper, 'Опубликовать').trigger('click');
  await flushPromises();
  assert.equal(posts().length, 1, 'отказ не отправляет публикацию');
  assert.equal(harness.confirmations.length, 1);

  harness.confirmed = true;
  await profileAction(wrapper, 'Опубликовать').trigger('click');
  await flushPromises();
  assert.deepEqual(posts().at(-1), [
    'post', '/api/routes/sample/publish', { mode: 'publish', expectedCatalogHash },
  ]);
  assert.equal(posts().length, 2);
  assert.equal(harness.confirmations.length, 2);
  assert.ok(revisionReads() > before, 'успешная публикация перечитывает current');
  assert.match(wrapper.get('.report').text(), /Отчёт профиля/);
}

test('RE93027-B1: профильная пересборка сохраняет подтверждение, payload и произвольный отчёт',
  async (t) => {
    const client = await fixture(t, publishedOptions({
      sourceMode: 'profile-script', publishSupported: true,
    }));

    await assertProfileRebuild(client, CURRENT);
  });

for (const [mode, options] of [
  ['editor', { sourceMode: 'editor', publishSupported: true }],
  ['unsupported', { sourceMode: 'profile-script', publishSupported: false }],
  ['history', {
    sourceMode: 'profile-script',
    publishSupported: true,
    query: { catalog: HISTORICAL, route: 'quick' },
  }],
]) {
  test(`RE93027-B1: ограничения пересборки ${mode} сохранены`, async (t) => {
    const { wrapper } = await fixture(t, publishedOptions(options));

    assert.equal(Boolean(profileAction(wrapper, 'Проверить')), false);
    assert.equal(Boolean(profileAction(wrapper, 'Опубликовать')), false);
  });
}

test('RE93027-B2: пересборка из файлов профиля доступна без публикации', async (t) => {
  const client = await fixture(t, { sourceMode: 'profile-script', publishSupported: true });

  assert.equal(client.wrapper.find('[data-test="edit-route"]').exists(), false);
  assert.ok(client.wrapper.find('[aria-label="Создать черновик"]').exists());
  await assertProfileRebuild(client, null);
});

/**
 * Проверяет публичную точку входа до запуска асинхронного сценария.
 * На исходной реализации отсутствие кнопки — ожидаемая причина RED.
 */
async function editPublished(client) {
  const button = client.wrapper.find('.panel > .ui-pane-header [data-test="edit-route"]');

  assert.ok(button.exists(), 'в шапке опубликованного маршрута нужна кнопка «Редактировать»');
  assert.equal(button.text(), 'Редактировать');
  await button.trigger('click');
  await client.flushPromises();
}

function mutations(client) {
  return client.calls.filter(([method]) => ['post', 'put', 'patch'].includes(method));
}

/**
 * Вход сохраняет проект и маршрут, а адрес просмотра заменяет адресом черновика.
 * Старые catalog и scope не должны влиять на последующее открытие.
 */
function assertOpened(client, id, routeId) {
  assert.equal(client.route.query.draft, id);
  assert.equal(client.route.query.route, routeId);
  assert.equal(client.route.query.profile, 'sample');
  assert.equal(client.route.query.tab, 'graph');
  assert.equal(client.route.query.catalog, undefined);
  assert.equal(client.route.query.scope, undefined);
}

for (const sourceMode of ['editor', 'profile-script']) {
  test(`RE93027-E1: Редактировать создаёт копию и сохраняет показанный маршрут (${sourceMode})`,
    async (t) => {
      const client = await fixture(t, publishedOptions({ sourceMode }));
      const second = client.wrapper.findAll('.item').find((row) => row.text().includes('second'));

      assert.ok(second, 'фикстура содержит второй опубликованный маршрут');
      await second.trigger('click');
      await client.flushPromises();
      await editPublished(client);
      assert.deepEqual(mutations(client), [[
        'post', '/api/routes/sample/drafts',
        {
          kind: 'catalog',
          title: 'Новый черновик',
          catalogHash: CURRENT,
        },
      ]]);
      assertOpened(client, client.draft.id, 'second');
    });
}

/**
 * Возвращает кандидата с управляемой датой и состоянием.
 * UUID различаются только суффиксом, поэтому равные даты имеют ясный порядок.
 */
function candidate(number, changes = {}) {
  const draft = makeDraft();

  draft.id = `22222222-2222-4222-8222-${String(number).padStart(12, '0')}`;
  draft.updatedAt = '2026-03-01T00:00:00.000Z';
  draft.baseCatalogHash = HISTORICAL;

  return { ...draft, ...changes };
}

test('RE93027-E2: открывается последний подходящий editing без создания', async (t) => {
  const withoutRoute = candidate(1, { routes: {}, updatedAt: '2026-04-01T00:00:00.000Z' });
  const winner = candidate(2);
  const tied = candidate(3);
  const older = candidate(4, { updatedAt: '2026-02-01T00:00:00.000Z' });
  const archived = candidate(5, { state: 'archived', updatedAt: '2026-05-01T00:00:00.000Z' });
  const published = candidate(6, { state: 'published', updatedAt: '2026-05-01T00:00:00.000Z' });
  const foreign = candidate(7, { profile: 'other', updatedAt: '2026-05-01T00:00:00.000Z' });
  const documents = [older, tied, foreign, published, archived, withoutRoute, winner];
  const snapshot = structuredClone(documents);
  const client = await fixture(t, publishedOptions({ documents, drafts: documents.map(summaryOf) }));

  await editPublished(client);
  assertOpened(client, winner.id, 'quick');
  assert.deepEqual(mutations(client), []);
  assert.deepEqual(documents, snapshot, 'повторное открытие не меняет документы');
  assert.ok(client.calls.some((call) => call[1].endsWith(`/drafts/${withoutRoute.id}`)));
  assert.ok(client.calls.filter((call) => call[1].endsWith('/drafts')).length >= 2,
    'вход читает свежий список, а не только список начальной загрузки');
});

test('RE93027-E2: отсутствие маршрута во всех черновиках создаёт отдельную копию', async (t) => {
  const document = candidate(8, { routes: {} });
  const snapshot = structuredClone(document);
  const client = await fixture(t, publishedOptions({
    documents: [document], drafts: [summaryOf(document)],
  }));

  await editPublished(client);
  assertOpened(client, client.draft.id, 'quick');
  assert.equal(mutations(client).length, 1);
  assert.equal(mutations(client)[0][0], 'post');
  assert.deepEqual(document, snapshot);
});

test('RE93027-E3: повторный вход и двойной клик не создают второй draft', async (t) => {
  const client = await fixture(t, publishedOptions());
  const pending = Promise.withResolvers();
  const post = client.api.post;

  client.api.post = async (...args) => {
    const result = await post(...args);

    await pending.promise;

    return result;
  };

  await editPublished(client);
  await client.wrapper.get('[data-test="edit-route"]').trigger('click');
  await client.flushPromises();
  assert.equal(mutations(client).length, 1, 'busy поставлен до первого await');
  pending.resolve();
  await client.flushPromises();
  assertOpened(client, client.draft.id, 'quick');

  client.route.query = { profile: 'sample', route: 'quick' };
  await client.flushPromises();
  await editPublished(client);
  assertOpened(client, client.draft.id, 'quick');
  assert.equal(mutations(client).length, 1, 'повторный вход открывает созданный документ');
});

test('RE93027-E4: исторический просмотр копирует свой hash', async (t) => {
  const client = await fixture(t, publishedOptions({ query: { catalog: HISTORICAL, route: 'second' } }));

  await editPublished(client);
  assert.deepEqual(mutations(client), [[
    'post', '/api/routes/sample/drafts',
    {
      kind: 'catalog',
      title: 'Новый черновик',
      catalogHash: HISTORICAL,
    },
  ]]);
  assertOpened(client, client.draft.id, 'second');
});

test('RE93027-E4b: просмотр старой ревизии при начатом черновике', async (t) => {
  const document = candidate(9, { baseCatalogHash: CURRENT });
  const client = await fixture(t, publishedOptions({
    query: { catalog: HISTORICAL, route: 'quick' },
    documents: [document],
    drafts: [summaryOf(document)],
  }));

  await editPublished(client);
  assertOpened(client, document.id, 'quick');
  assert.deepEqual(mutations(client), []);
});

test('RE93027-E5: ошибка свежего списка не считается отсутствием черновика', async (t) => {
  const client = await fixture(t, publishedOptions());
  const get = client.api.get;

  client.api.get = async (url) => {
    if (url.endsWith('/drafts')) {
      throw new Error('Список временно недоступен');
    }

    return get(url);
  };

  await editPublished(client);
  assert.deepEqual(mutations(client), []);
  assert.equal(client.route.query.draft, undefined);
  assert.match(client.wrapper.text(), /Список временно недоступен/);
});

for (const change of ['profile', 'route', 'post']) {
  test(`RE93027-E5: поздний ответ после смены контекста ${change} не меняет экран`, async (t) => {
    const client = await fixture(t, publishedOptions());
    const pending = Promise.withResolvers();
    const method = change === 'post' ? 'post' : 'get';
    const original = client.api[method];

    client.api[method] = async (...args) => {
      if (args[0] === '/api/routes/sample/drafts') {
        const response = await original(...args);

        await pending.promise;

        return response;
      }

      return original(...args);
    };

    await editPublished(client);
    client.route.query = change === 'route'
      ? { profile: 'sample', route: 'second' }
      : { profile: 'other' };
    await client.flushPromises();

    const address = { ...client.route.query };

    pending.resolve();
    await client.flushPromises();
    assert.deepEqual(client.route.query, address, 'поздний ответ не возвращает старый экран');
    assert.equal(mutations(client).length, change === 'post' ? 1 : 0);
  });
}

for (const [name, options] of [
  ['нет публикации', {}],
  ['ошибка URL', publishedOptions({ query: { catalog: 'invalid' } })],
]) {
  test(`RE93027-E5: вход недоступен — ${name}`, async (t) => {
    const client = await fixture(t, options);

    assert.equal(client.wrapper.find('[data-test="edit-route"]').exists(), false);
    assert.deepEqual(mutations(client), []);
  });
}

test('RE93027-P1: действия файлов профиля находятся в закрытой секции под схемой', async (t) => {
  const { wrapper } = await fixture(t, publishedOptions({
    sourceMode: 'profile-script', publishSupported: true,
  }));
  const section = wrapper.findAll('.panel-scroll details').find((item) =>
    item.find('summary').text() === 'Пересборка каталога из файлов профиля');

  assert.ok(section, 'нужна отдельная секция пересборки из файлов профиля');
  assert.equal(section.element.open, false);
  assert.ok(profileAction(section, 'Проверить каталог из файлов профиля'));
  assert.ok(profileAction(section, 'Опубликовать каталог из файлов профиля'));
  assert.equal(Boolean(profileAction(wrapper.get('.panel > .ui-pane-header'), 'Проверить')), false);
  assert.equal(Boolean(profileAction(wrapper.get('.panel > .ui-pane-header'), 'Опубликовать')), false);
  assert.ok(wrapper.get('.published-canvas').element.compareDocumentPosition(section.element) & 4);
  assert.ok(section.element.compareDocumentPosition(wrapper.get('.revs').element) & 4);
});

for (const nodeId of ['build', 'check', 'gate_accept', 'check_status']) {
  test(`RE93027-I1: tab=prompt открывается внутри панели без потери графа (${nodeId})`, async (t) => {
    const draft = makeDraft();
    const client = await fixture(t, {
      query: {
        draft: draft.id,
        route: 'quick',
        node: nodeId,
        tab: 'prompt',
      },
    });
    const prompt = client.wrapper.findComponent({ name: 'RoutePromptEditor' });

    assert.ok(client.wrapper.find('.route-editor-inspectors [data-test="prompt-editor"]').exists(),
      'инструкция открывается в общей панели этапа');
    assert.ok(client.wrapper.find('.route-editor-workspace [data-test="choose-check"]').exists(),
      'граф остаётся смонтирован при прямом tab=prompt');
    assert.equal(prompt.props('routeId'), 'quick');
    assert.equal(prompt.props('nodeId'), nodeId);

    if (nodeId !== 'build') {
      assert.equal(prompt.props('document').routes.quick.route.nodes.find((node) =>
        node.id === nodeId).prompt, undefined, 'пустой этап не получает искусственную инструкцию');

      return;
    }

    const { useRoutesStore } = await compileModule(webFile('src/stores/routes.ts'));
    const store = useRoutesStore();
    const bundle = structuredClone(draft.routes.quick);
    const file = bundle.route.nodes[0].prompt.blocks[0].file;

    bundle.prompts[file] = 'Новый текст выбранного блока.\n';
    prompt.vm.$emit('change', {
      routeId: 'quick',
      bundle,
      historyGroup: 'prompt:quick:test',
    });
    await client.flushPromises();
    assert.equal(store.localDocument.routes.quick.prompts[file], bundle.prompts[file]);
    assert.equal(store.historyGroup, 'prompt:quick:test');
    prompt.vm.$emit('end-history-group');
    await client.flushPromises();
    assert.equal(store.historyGroup, null);
    prompt.vm.$emit('save');
    await client.flushPromises();

    const patch = mutations(client).find(([method]) => method === 'patch');

    assert.ok(patch, 'событие save прошло в прежний action');
    assert.equal(patch[2].operations[0].routeId, 'quick');
    assert.deepEqual(patch[2].operations[0].prompts, bundle.prompts);

    const properties = client.wrapper.findAll('[role="tab"]').find((tab) =>
      tab.text() === 'Свойства и переходы');

    assert.ok(properties);
    await properties.trigger('click');
    await client.flushPromises();
    assert.equal(client.route.query.tab, 'graph');

    const instruction = client.wrapper.findAll('[role="tab"]').find((tab) => tab.text() === 'Инструкция');

    assert.ok(instruction);
    await instruction.trigger('click');
    await client.flushPromises();
    assert.equal(client.route.query.tab, 'prompt');
    assert.equal(client.route.query.node, 'build');
  });
}

test('RE93027-I3: переход к проблеме инструкции остаётся на tab=prompt с видимой схемой', async (t) => {
  const draft = makeDraft();
  const client = await fixture(t, {
    query: {
      draft: draft.id,
      route: 'quick',
      node: 'check',
      tab: 'graph',
    },
    realCanvas: true,
  });
  const { useRoutesStore } = await compileModule(webFile('src/stores/routes.ts'));
  const store = useRoutesStore();
  const path = '/routes/quick/nodes/build/prompt/blocks/1/file';

  store.validatedRevision = draft.revision;
  store.validatedGeneration = store.editGeneration;
  store.validationIssues = [{
    code: 'prompt',
    severity: 'error',
    scope: 'route',
    routeId: 'quick',
    nodeId: 'build',
    path,
    message: 'Проверить второй блок инструкции',
  }];
  await client.flushPromises();
  await client.wrapper.get('[data-test="focus-issue"]').trigger('click');
  await client.flushPromises();

  assert.equal(client.route.query.tab, 'prompt');
  assert.equal(client.route.query.node, 'build');
  assert.equal(client.route.query.route, 'quick');
  assert.ok(client.wrapper.find('.route-editor-workspace .route-canvas').exists(),
    'настоящий RouteCanvas остаётся рядом с инструкцией');

  const prompt = client.wrapper.findComponent({ name: 'RoutePromptEditor' });

  assert.equal(prompt.props('focusPath'), path);
  assert.equal(prompt.props('nodeId'), 'build');
});

for (const area of ['catalog', 'current-graph', 'snapshot-graph']) {
  test(`LOAD-SURFACE-routes-${area}: первое чтение объявлено и сменяется готовой областью`, async (t) => {
    const gate = Promise.withResolvers();
    const hash = 'a'.repeat(64);
    const h = await fixture(t, {
      query: area === 'snapshot-graph' ? { catalog: hash, route: 'quick' } : { route: 'quick' },
      sourceMode: 'files',
      currentCatalogHash: hash,
      revisions: [{
        catalogHash: hash,
        createdAt: '2026-01-01T00:00:00Z',
        isCurrent: true,
        routes: { quick: 'c'.repeat(64) },
        integrity: 'ok'
      }],
      catalogInput: makeCatalogInput(),
      revisionsGate: area === 'catalog' ? gate.promise : null,
      graphGate: area === 'catalog' ? null : gate.promise,
    });

    for (let cycle = 0; cycle < 8; cycle += 1) {
      await h.flushPromises();
    }

    const scope = h.wrapper.get(area === 'catalog' ? '.catalog-content' : '.panel-scroll');
    const bricks = scope.findAll('[data-ui-skeleton]').length;
    const announced = scope.find('[role="status"]').exists();

    gate.resolve();

    for (let cycle = 0; cycle < 8; cycle += 1) {
      await h.flushPromises();
    }

    assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
    assert.equal(h.wrapper.find('.published-canvas').exists(), true);
    assert.equal(h.wrapper.find('[role="alert"]').exists(), false);
    assert.ok(announced, 'статус чтения объявлен');
    assert.ok(bricks > 0, `${area}: используется каркас соответствующей области`);
  });
}

for (const area of ['catalog', 'current-graph', 'snapshot-graph']) {
  test(`LOAD-KEEP-routes-error-${area}: отказ чтения снимает каркас и сохраняет причину`, async (t) => {
    const gate = Promise.withResolvers();
    const hash = 'a'.repeat(64);
    const h = await fixture(t, {
      query: area === 'snapshot-graph' ? { catalog: hash, route: 'quick' } : { route: 'quick' },
      sourceMode: 'files',
      currentCatalogHash: hash,
      revisions: [{
        catalogHash: hash,
        createdAt: '2026-01-01T00:00:00Z',
        isCurrent: true,
        routes: { quick: 'c'.repeat(64) },
        integrity: 'ok',
      }],
      catalogInput: makeCatalogInput(),
      revisionsGate: area === 'catalog' ? gate.promise : null,
      graphGate: area === 'catalog' ? null : gate.promise,
    });

    for (let cycle = 0; cycle < 8; cycle += 1) {
      await h.flushPromises();
    }

    gate.reject(new Error('Синтетический отказ маршрута'));

    for (let cycle = 0; cycle < 8; cycle += 1) {
      await h.flushPromises();
    }

    assert.match(h.wrapper.text(), /Синтетический отказ маршрута/);
    assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
    assert.equal(h.wrapper.find('[data-ui-skeleton]').exists(), false);
  });
}
