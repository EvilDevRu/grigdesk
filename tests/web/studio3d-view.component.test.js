process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile, singletonUrl } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { stateDto, detailDto } from './helpers/studio3d-fixtures.js';

const CREATE_STUB = 'export default {template: "<div class=\'stub-create\' />"};';
const LIBRARY_STUB = 'export default {template: "<div class=\'stub-library\' />"};';
const TASKS_STUB = 'export default {template: "<div class=\'stub-tasks\' />"};';
const TREE_STUB = 'export default {props: ["versions", "selected", "main"], emits: ["select"],'
  + ' template: "<div class=\'stub-tree\' />"};';
const MODEL_PAGE_STUB = 'export default {'
  + ' props: { active: { type: Boolean, default: true }, section: { type: String, default: "viewer" },'
  + ' compareVersionId: { type: String, default: "" } }, emits: ["created", "tasks", "compare"],'
  + ' template: "<div class=\'stub-model-page\' :data-active=\'String(active)\''
  + ' :data-section=\'section\' />"};';

const PANEL_MOUNT = '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.cjs.js';

/**
 * Замкнутый стенд панели: сторы, плагин и док подменяются целиком,
 * а панель тестируется на настоящих primitives из ui.ts.
 */
function harness(patch = {}) {
  const h = {
    enabled: true,
    consumed: [],
    openCalls: [],
    viewing: [],
    dock: { isExpanded: false, activeTool: 'studio3d' },
    store: {
      state: stateDto(),
      active: 2,
      error: null,
      detail: null,
      selectedVersion: '',
      openModel: async (model, version) => {
        h.openCalls.push([model, version]);
      },
      setViewingModel: (id) => {
        h.viewing.push(id);
      }
    },
    ...patch
  };

  return h;
}

function panelStubs(h) {
  return {
    '../../shared/settingsNavigation.ts': `
      export const openSettings = (request) => globalThis.__studioPanel.openCalls.push(['settings', request]);
    `,
    './CreatePanel.vue': CREATE_STUB,
    './LibraryPanel.vue': LIBRARY_STUB,
    './TasksPanel.vue': TASKS_STUB,
    './VersionTree.vue': TREE_STUB,
    './ModelPage.vue': MODEL_PAGE_STUB,
    '../../stores/studio3d.ts': 'export const useStudio3dStore = () => globalThis.__studioPanel.store;',
    '../../stores/plugins.js': 'export const usePluginsStore = () => ({'
      + ' loaded: true, enabled: (id) => globalThis.__studioPanel.enabledRef.value });',
    '../../stores/dock.js': 'export const useDockStore = () => globalThis.__studioPanel.dock;'
  };
}

/**
 * Панель использует реактивные подмены только из текущего стенда.
 * Размонтирование зарегистрировано до проверок и освобождает watcher-ы.
 */
async function mountPanel(t, h, props = {}) {
  globalThis.__studioPanel = h;

  const vue = await import(singletonUrl('vue'));

  h.enabledRef = vue.ref(h.enabled);
  h.dock = vue.reactive(h.dock);
  h.store = vue.reactive(h.store);

  const { mount } = await import(PANEL_MOUNT);
  const component = await compileVue(webFile('src/views/studio3d/Studio3dPanel.vue'), {
    stubs: panelStubs(h)
  });
  const wrapper = mount(component, { props });

  t.after(() => wrapper.unmount());

  return wrapper;
}

test('Панель 3D: выключенный плагин — заглушка, включённый — вкладки и честная шапка', async (t) => {
  await installUiBrowser(t);

  const { nextTick } = await import(singletonUrl('vue'));
  const h = harness({ enabled: false });
  const wrapper = await mountPanel(t, h, { presentation: 'page' });

  assert.equal(wrapper.text().includes('Плагин «3D» выключен'), true);

  h.enabledRef.value = true;
  await nextTick();
  assert.equal(wrapper.findAll('[role="tab"]').length, 3);
  assert.equal(wrapper.get('[role="tab"][aria-selected="true"]').text(), 'Создать');
  assert.equal(wrapper.text().includes('215 кредитов'), true);
  assert.equal(wrapper.text().includes('100 в резерве'), true);
  assert.equal(wrapper.text().includes('3,2 ГБ'), true);
  assert.equal(wrapper.text().includes('53 ГБ'), true);

  h.store.state.library.lowDisk = true;
  await nextTick();
  assert.equal(wrapper.find('.studio-disk-warning').exists(), true);
});

test('Панель 3D: команда open открывает вкладку, модель, версию и подтверждается', async (t) => {
  await installUiBrowser(t);

  const { nextTick } = await import(singletonUrl('vue'));
  const h = harness();
  const wrapper = await mountPanel(t, h, { presentation: 'dock', intents: [] });

  await wrapper.setProps({ intents: [{
    id: 7,
    type: 'open',
    tab: 'models',
    model: 'm1',
    version: 'v2'
  }] });
  await nextTick();

  assert.deepEqual(wrapper.emitted('consume-intent'), [[7]]);
  assert.equal(wrapper.find('.stub-model-page').exists(), true);
  assert.equal(wrapper.find('.stub-model-page').attributes('data-section'), 'viewer');
  assert.equal(wrapper.find('.stub-model-page').attributes('data-active'), 'true');
  assert.deepEqual(h.openCalls.at(-1), ['m1', 'v2']);
  assert.deepEqual(h.viewing.at(-1), 'm1');
});

test('Панель 3D: active: false убирает просмотрщик и снимает viewing-модель', async (t) => {
  await installUiBrowser(t);

  const { nextTick } = await import(singletonUrl('vue'));
  const h = harness();
  const wrapper = await mountPanel(t, h, {
    presentation: 'dock',
    active: false,
    intents: []
  });

  await wrapper.setProps({ intents: [{
    id: 3,
    type: 'open',
    model: 'm1'
  }] });
  await nextTick();

  assert.deepEqual(wrapper.emitted('consume-intent'), [[3]]);
  assert.equal(wrapper.find('.stub-model-page').attributes('data-active'), 'false');
  assert.deepEqual(h.viewing.at(-1), '');

  await wrapper.setProps({ active: true });
  await nextTick();
  assert.equal(wrapper.find('.stub-model-page').attributes('data-active'), 'true');
  assert.deepEqual(h.openCalls.at(-1), ['m1', '']);
  assert.deepEqual(h.viewing.at(-1), 'm1');
});

test('Панель 3D: разворачивание меняет раскладку без перемонтирования модели', async (t) => {
  await installUiBrowser(t);

  const { nextTick, reactive } = await import(singletonUrl('vue'));

  const h = harness();

  h.dock = reactive({ isExpanded: false, activeTool: 'studio3d' });
  h.store.detail = detailDto();

  const wrapper = await mountPanel(t, h, {
    presentation: 'dock',
    compact: true,
    intents: []
  });

  await wrapper.setProps({ intents: [{
    id: 5,
    type: 'open',
    model: 'fixture-model'
  }] });
  await nextTick();

  assert.equal(wrapper.find('.studio-compact-column').exists(), true);
  assert.equal(wrapper.find('[role="separator"]').exists(), false);
  assert.equal(wrapper.find('.stub-tree').exists(), true);
  assert.equal(wrapper.text().includes('Поиск работает'), false);

  const viewer = wrapper.get('.stub-model-page').element;
  const tree = wrapper.get('.stub-tree').element;

  h.dock.isExpanded = true;
  await nextTick();

  assert.equal(wrapper.find('.studio-navigator').exists(), true);
  assert.equal(wrapper.find('.studio-compact-column').exists(), false);
  assert.equal(wrapper.find('.studio-side').exists(), true);
  assert.equal(wrapper.get('.stub-model-page').element === viewer, true);
  assert.equal(wrapper.get('.stub-tree').element === tree, true);

  const separator = wrapper.get('[role="separator"]');

  await separator.trigger('keydown', { key: 'End' });
  assert.equal(separator.attributes('aria-valuenow'), '420');
  assert.equal(wrapper.get('.studio-layout').element.style.getPropertyValue('--studio-nav-width'), '420px');

  h.dock.isExpanded = false;
  await nextTick();
  assert.equal(wrapper.find('.studio-compact-column').exists(), true);
  assert.equal(wrapper.get('.stub-model-page').element === viewer, true);
});

test('Панель 3D: форма сохраняет экземпляр при разворачивании и возврате в док', async (t) => {
  await installUiBrowser(t);

  const { nextTick } = await import(singletonUrl('vue'));
  const h = harness();
  const wrapper = await mountPanel(t, h, { presentation: 'dock', compact: true });
  const form = wrapper.get('.stub-create').element;

  h.dock.isExpanded = true;
  await nextTick();
  assert.equal(wrapper.get('.stub-create').element === form, true);
  assert.equal(wrapper.find('.studio-navigator').exists(), false);

  h.dock.isExpanded = false;
  await nextTick();
  assert.equal(wrapper.get('.stub-create').element === form, true);
});

test('Панель 3D: вкладка и выбор модели — состояние панели, адрес не меняется', async (t) => {
  await installUiBrowser(t);

  const { nextTick } = await import(singletonUrl('vue'));
  const h = harness();
  const wrapper = await mountPanel(t, h, { presentation: 'page', intents: [] });

  await wrapper.get('[aria-label="Задачи · 2"]').trigger('click');
  await nextTick();

  assert.equal(wrapper.find('.stub-tasks').exists(), true);
  assert.deepEqual(h.viewing.at(-1), '');
});

test('Панель 3D: возврат из задач сохраняет форму и выбранную версию', async (t) => {
  await installUiBrowser(t);

  const h = harness();
  const wrapper = await mountPanel(t, h, { presentation: 'page', intents: [] });
  const form = wrapper.get('.stub-create').element;

  await wrapper.setProps({ intents: [{
    id: 12,
    type: 'open',
    model: 'fixture-model',
    version: 'v2'
  }] });
  h.store.selectedVersion = 'v2';
  await wrapper.get('[aria-label="Задачи · 2"]').trigger('click');
  await wrapper.get('[aria-label="Модели"]').trigger('click');
  assert.deepEqual(h.openCalls.at(-1), ['fixture-model', 'v2']);
  assert.equal(wrapper.find('.stub-model-page').exists(), true);

  await wrapper.get('[aria-label="Создать"]').trigger('click');
  assert.equal(wrapper.get('.stub-create').element === form, true);
  assert.deepEqual(h.viewing.at(-1), '');
  assert.deepEqual(wrapper.emitted('context').at(-1), [{ tab: 'create', model: '' }]);
});

test('ModelPage: active управляет монтажом ModelViewer', async (t) => {
  await installUiBrowser(t);

  const { mount } = await import(PANEL_MOUNT);
  const store = {
    state: stateDto(),
    libraryId: '00000000-0000-4000-8000-000000000099',
    detail: detailDto({
      versions: [{
        libraryId: '00000000-0000-4000-8000-000000000099',
        id: 'v01-model',
        seq: 1,
        parent: null,
        kind: 'model',
        operation: 'text-to-model',
        provider: 'tripo',
        label: 'Модель',
        status: 'ready',
        progress: 100,
        etaSeconds: null,
        params: {},
        files: [{
          id: 'f1',
          name: 'model.glb',
          url: '/files/model.glb',
          role: 'model'
        }],
        preview: null,
        stats: null,
        task: null,
        cost: {
          estimated: 0,
          actual: null,
          free: true,
          unit: {
            one: 'кредит',
            few: 'кредита',
            many: 'кредитов'
          },
          state: 'free'
        },
        error: null,
        origin: 'section',
        createdAt: '2026-10-11T10:00:00Z',
        updatedAt: '2026-10-11T10:00:00Z',
        savedTo: [],
        rigCheck: null,
        intentId: '00000000-0000-4000-8000-000000000001',
        childId: 'child-1',
        waitReason: null,
        retryAvailable: false,
        retryReason: null,
        views: [],
        mainFileId: 'f1'
      }]
    }),
    selectedVersion: 'v01-model',
    openModel: async () => {},
    redownload: async () => {},
    patchModel: async () => {},
    deleteVersion: async () => {},
    lighten: async () => {},
    retry: async () => ({ cancelled: true }),
    addFromFile: async () => {}
  };

  globalThis.__studioModelPage = { store };

  const component = await compileVue(webFile('src/views/studio3d/ModelPage.vue'), {
    stubs: {
      './NextSteps.vue': 'export default {template: "<div />"};',
      './SaveDialog.vue': 'export default {template: "<div />"};',
      './PriceButton.vue': 'export default {template: "<div />"};',
      '../../shared/viewer3d/ModelViewer.vue': 'export default {props: ["src", "ext", "name"],'
        + ' template: "<div class=\'stub-viewer\' />"};',
      '../../stores/studio3d.ts': 'export const useStudio3dStore = () => globalThis.__studioModelPage.store;',
      '../../stores/chat.js': 'export const useChatStore = () => ({});'
    }
  });
  const wrapper = mount(component, { props: { active: false } });

  assert.equal(wrapper.find('.stub-viewer').exists(), false);

  await wrapper.setProps({ active: true });
  assert.equal(wrapper.find('.stub-viewer').exists(), true);
});


test('IN05: ссылка ключа берёт исполнителя из DTO и открывает его параметры', async (t) => {
  await installUiBrowser(t);

  const h = harness();

  h.store.state.providers[0].id = 'synthetic-provider';
  h.store.state.providers[0].available = false;

  const wrapper = await mountPanel(t, h, { presentation: 'page' });

  await wrapper.findAll('a').find((entry) => entry.text() === 'нужен ключ').trigger('click');

  assert.deepEqual(h.openCalls.at(-1), ['settings', {
    pageId: 'agents.providers',
    entityId: 'synthetic-provider',
  }]);
});
