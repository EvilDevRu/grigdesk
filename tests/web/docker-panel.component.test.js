import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

/**
 * Настоящие списки и просмотрщик работают с управляемым реестром без Docker.
 * Отдельный сокет логов позволяет проверить освобождение потока при навигации.
 */
async function mountPanel(t, props = {}) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/docker');
  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const sockets = [];
  const loads = [];
  const originalSocket = globalThis.WebSocket;
  const store = reactive({
    health: { available: true, version: 'fixture' },
    containers: [{
      id: 'web',
      name: 'demo-web-1',
      image: 'nginx:stable',
      state: 'running',
      status: 'Up',
      health: 'healthy',
      ports: [],
      compose: null,
    }],
    counts: {
      containers: 1,
      running: 1,
      images: 0,
    },
    projects: [],
    images: [],
    volumes: [],
    networks: [],
    stats: {},
    loading: false,
    usage: null,
    usageLoading: false,
    error: '',
    isBusy: () => false,
    async load() {
      loads.push('overview');
    },
    async loadUsage(options) {
      loads.push(options?.force ? 'usage-force' : 'usage');
    },
    watchStats() {},
    stopStats() {},
  });

  globalThis.__dockerPanelStore = store;
  globalThis.WebSocket = class {
    constructor() {
      this.closed = false;
      sockets.push(this);
    }

    close() {
      this.closed = true;
    }
  };

  const component = await compileVue(webFile('src/views/docker/DockerPanel.vue'), {
    stubs: {
      '../../stores/docker': 'export const useDockerStore = () => globalThis.__dockerPanelStore;',
      '../../stores/plugins.ts': 'export const usePluginsStore = () => ({ byId: () => ({}) });',
    },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, {
    props,
    attachTo: browser.document.querySelector('#mount'),
  });

  t.after(() => {
    wrapper.unmount();
    globalThis.WebSocket = originalSocket;
    delete globalThis.__dockerPanelStore;
  });
  await flushPromises();

  return {
    wrapper,
    store,
    sockets,
    loads,
    flushPromises,
  };
}

test('закрытие логов сохраняет список, фильтр и фокус исходного действия', async (t) => {
  const { wrapper, sockets, flushPromises } = await mountPanel(t);
  const search = wrapper.get('[aria-label="Поиск контейнера"]');

  await search.setValue('nginx');

  const list = wrapper.get('.docker-containers').element;
  const logs = wrapper.get('[aria-label="Логи demo-web-1"]');

  logs.element.focus();
  await logs.trigger('click');
  await flushPromises();

  const close = wrapper.get('[aria-label="Закрыть просмотр контейнера"]');

  assert.equal(wrapper.classes().includes('has-viewer'), true);
  assert.equal(wrapper.element.ownerDocument.activeElement === close.element, true);
  assert.equal(wrapper.get('.docker-containers').element === list, true);

  await close.trigger('click');
  await flushPromises();

  assert.equal(wrapper.find('.docker-viewer').exists(), false);
  assert.equal(search.element.value, 'nginx');
  assert.equal(wrapper.element.ownerDocument.activeElement === logs.element, true);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].closed, true);
});

test('смена раздела закрывает поток, а расчёт места запускается только в уборке', async (t) => {
  const { wrapper, sockets, loads, flushPromises } = await mountPanel(t);

  await wrapper.get('[aria-label="Логи demo-web-1"]').trigger('click');
  await flushPromises();
  await wrapper.get('#docker-tab-images').trigger('click');
  await flushPromises();

  assert.equal(wrapper.find('.docker-viewer').exists(), false);
  assert.equal(sockets[0].closed, true);
  assert.deepEqual(loads, ['overview']);

  await wrapper.get('#docker-tab-cleanup').trigger('click');
  await flushPromises();
  await wrapper.get('[aria-label="Обновить состояние Docker"]').trigger('click');
  await flushPromises();

  assert.deepEqual(loads, ['overview', 'usage', 'overview', 'usage-force']);
});

test('скрытая панель восстанавливает просмотрщик один раз после активации', async (t) => {
  const { wrapper, sockets, flushPromises } = await mountPanel(t, { active: false });

  await wrapper.vm.importState({
    tab: 'containers',
    viewer: { kind: 'logs', containerId: 'web' },
  });
  await flushPromises();

  assert.equal(sockets.length, 0);

  await wrapper.setProps({ active: true });
  await flushPromises();

  assert.equal(sockets.length, 1);
  assert.deepEqual(wrapper.vm.exportState(), {
    tab: 'containers',
    viewer: { kind: 'logs', containerId: 'web' },
  });
});
