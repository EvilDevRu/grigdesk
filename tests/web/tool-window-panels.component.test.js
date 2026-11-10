import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createUiBrowser, installUiBrowser } from './helpers/ui-components.js';
import { compileVue, compileModule, webFile } from './helpers/compile-vue.js';
import { mountSshPanel } from './helpers/tool-window-ssh.js';
import { mountDbPanel } from './helpers/tool-window-db.js';
import { featureModule, tick } from './helpers/tool-window-harness.js';

const runtimeBrowser = await createUiBrowser();

after(() => runtimeBrowser.close());

test('TW-P01/ssh: перенос сохраняет выбранную server-owned сессию и remotePath', async (t) => {
  const first = await mountSshPanel(t);

  await first.wrapper.findAll('.ssh-tabs [role="tab"]')[1].trigger('click');
  await first.flushPromises();
  assert.equal(first.store.activeId, 'session-b');
  await first.wrapper.get('details.ssh-sftp summary').trigger('click');
  await first.wrapper.get('input[aria-label="Путь на сервере"]').setValue('/fixture/path');
  assert.equal(typeof first.wrapper.vm.exportState, 'function', 'SSH не экспортирует выбор окна');

  const state = await first.wrapper.vm.exportState();

  first.wrapper.unmount();

  const second = await mountSshPanel(t);

  await second.wrapper.vm.importState(state);
  await second.flushPromises();
  assert.equal(second.store.activeId, 'session-b');
  assert.equal(second.wrapper.get('input[aria-label="Путь на сервере"]').element.value, '/fixture/path');
  assert.equal(second.wrapper.findAll('.ssh-tabs [role="tab"]')[1].attributes('aria-selected'), 'true');
});

test('TW-P01/db: перенос сохраняет session/profile и SQL draft без пароля и повторного query', async (t) => {
  const calls = [];
  const store = {

    profiles: [],

    projects: [],

    sshSessions: [],

    engines: [],

    queries: [],

    audit: [],

    schemas: {},

    sessions: [
      {

        id: 'a',

        profileId: 'pa',

        projectId: 'demo',

        label: 'Первая',

        engine: 'mysql',

        role: 'read'

      },
      {

        id: 'b',

        profileId: 'pb',

        projectId: 'demo',

        label: 'Вторая',

        engine: 'mysql',

        role: 'read'

      },
    ],

    load: async () => { },

    loadSchema: async () => { },

    runQuery: (...args) => calls.push(args),

  };
  const first = await mountDbPanel(t, store);

  await first.wrapper.findAll('.db-tabs [role="tab"]')[1].trigger('click');
  await first.wrapper.get('textarea').setValue('SELECT 7 AS answer');
  assert.equal(typeof first.wrapper.vm.exportState, 'function', 'БД не экспортирует query draft');

  const state = await first.wrapper.vm.exportState();

  assert.equal('password' in state, false);
  first.wrapper.unmount();

  const second = await mountDbPanel(t, store);

  await second.wrapper.vm.importState(state);
  await second.flushPromises();
  assert.equal(second.wrapper.get('textarea').element.value, 'SELECT 7 AS answer');
  assert.equal(second.wrapper.findAll('.db-tabs [role="tab"]')[1].attributes('aria-selected'), 'true');
  assert.deepEqual(calls, []);
});

test('TW-P01/shelf: перенос восстанавливает фильтр и поиск настоящей панели', async (t) => {
  await installUiBrowser(t);
  globalThis.__toolPanelShelf = {

    rows: [{

      taskId: '42',

      title: 'Задача',

      state: 'neutral',

      completed: false,

      reasonText: 'Ожидание',

      addedAt: '2026-08-26T08:00:00.000Z',

      message: '',

      source: null,

      details: { project: 'demo', activities: [] },

    }],

    get allRows() {
      return this.rows;
    },

    loaded: true,

    loading: false,

    error: null,

    isPending: () => false,

  };
  t.after(() => {
    delete globalThis.__toolPanelShelf;
  });

  const component = await compileVue(webFile('src/views/shelf/TaskShelfPanel.vue'), {
    stubs: {
      '../../stores/taskShelf.ts':
        'export const useTaskShelfStore = () => globalThis.__toolPanelShelf;',
      '../../stores/ui.ts':
        'export const useUiStore = () => ({ openTask() {} });',
    }
  });
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const { createPinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');
  const pinia = createPinia();
  const first = mount(component, { global: { plugins: [pinia] } });

  t.after(() => first.unmount());
  await first.get('input[type="search"]').setValue('длинное название');
  assert.equal(typeof first.vm.exportState, 'function', 'Полка не переносит поиск окна');

  const state = await first.vm.exportState();

  first.unmount();

  const second = mount(component, { global: { plugins: [pinia] } });

  t.after(() => second.unmount());
  await second.vm.importState(state);
  assert.equal(second.get('input[type="search"]').element.value, 'длинное название');
});

test('TW-P01/docker и plugin: снимок сохраняет viewer/tab; src берётся только из registry', async (t) => {
  const product = await featureModule('src/shared/tools/toolWindowState.ts');
  const docker = {
    tab: 'containers', viewer: { kind: 'logs', containerId: 'container-a' },
  };

  assert.deepEqual(product.parseToolWindowState('docker', docker), docker);
  assert.deepEqual(product.parseToolWindowState('example', { id: 'example' }), { id: 'example' });
  assert.equal(
    product.parseToolWindowState('example', { id: 'example', src: 'https://foreign.test' }),
    null
  );

  const registry = await compileModule(webFile('src/shared/tools/registry.ts'), {
    stubs: {
      '../asyncView.ts':
        'export const asyncView = () => ({});',
      ...Object.fromEntries([
        'code/CodePanel', 'shelf/TaskShelfPanel', 'terminal/TerminalPanel',
        'ssh/SshPanel', 'db/DbPanel', 'docker/DockerPanel', 'ext/PluginModulePanel',
      ].map((name) => [`../../views/${name}.vue`, 'export default {};'])),
    }
  });
  const page = registry.toolById({
    modulePages: [{

      id: 'example',


      label: 'Пример',

      icon: 'plugin',

      order: 1,

    }]
  }, 'example');

  assert.equal(page.panelProps.pluginId, 'example');
  assert.equal('src' in page.panelProps, false);
});

test('TW-P02: mirror события обновляют настоящие SSH/DB actions без второго EventSource', async (t) => {
  await installUiBrowser(t);

  const { createPinia, setActivePinia, disposePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  const sse = await import('../../web/src/composables/useSse.ts');
  const pinia = createPinia();
  const channels = [];
  const calls = [];
  const data = {
    ssh: [{ id: 'ssh-new', label: 'Новая SSH-сессия' }],
    db: [{ id: 'db-new', label: 'Новая БД-сессия' }],
  };

  setActivePinia(pinia);
  globalThis.__toolPanelEvents = {

    subscribe: sse.sseSubscribe,

    sshApi: {

      connections: async () => [],

      sessions: async () => {
        calls.push('ssh-sessions');

        return data.ssh;
      },

      audit: async () => ({ items: [] }),

    },

    dbApi: {

      engineSnapshot: async () => ({
        engines: [],
        errors: [],
        installs: {},
        installHealth: null,
      }),

      engines: async () => [],

      profiles: async () => [],

      queries: async () => [],

      sessions: async () => {
        calls.push('db-sessions');

        return data.db;
      },

      audit: async () => ({ items: [] }),

    },

  };
  sse.configureSseRelay('mirror', () => {
    const channel = {

      onmessage: null,

      postMessage() { },

      close() { }

    };

    channels.push(channel);

    return channel;
  });
  t.after(() => {
    sse.resetSseForTests();
    disposePinia(pinia);
    delete globalThis.__toolPanelEvents;
  });

  for(const id of ['ssh', 'db']) {
    const cap = id === 'ssh' ? 'Ssh' : 'Db';
    const module = await compileModule(webFile(`src/actions/${id}/watch${cap}.ts`), {
      stubs: {
        '../../composables/useSse.ts':
          'export const sseSubscribe = globalThis.__toolPanelEvents.subscribe;',
        [`../../shared/${id}Api.ts`]: `export const ${id}Api = globalThis.__toolPanelEvents.${id}Api;`,
      }
    });

    module[`watch${cap}`]();
    channels[0].onmessage({
      data: {

        version: 1,

        name: `${id}-sessions`,

        data: {}

      }
    });
    await tick();

    const storeModule = await compileModule(webFile(`src/stores/${id}.ts`));
    const store = storeModule[`use${cap}Store`](pinia);

    assert.deepEqual(store.sessions.map((session) => session.id), data[id].map((session) => session.id));
  }

  assert.deepEqual(calls, ['ssh-sessions', 'db-sessions']);
});

test(
  'TW-P01/P02/docker: настоящий viewer/tab переносится, stats WS один и снимается с панелью',
  async (t) => {
  await installUiBrowser(t);

  const { createPinia, setActivePinia, disposePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  const pinia = createPinia();
  const sockets = [];
  const originalSocket = globalThis.WebSocket;
  const container = {

    id: 'container-a',
    shortId: 'container-a',
    name: 'Контейнер',
    image: 'fixture',
    imageId: 'image-a',

    command: 'sh',
    createdAt: null,
    state: 'running',
    status: 'Up',
    health: '',
    ports: [],
    networks: [],

    mounts: [],
    sizeRw: null,
    compose: null,

  };

  globalThis.WebSocket = class {
    readyState = 1;
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    send() { }
    close() {
      this.readyState = 3;
    }
  };
  globalThis.__toolDockerApi = {

    health: async () => ({
      available: true,
      version: 'fixture',
      apiVersion: '1',
      socketPath: '/fixture'

    }),

    overview: async () => ({

      containers: [container],
      projects: [],
      images: [],
      volumes: [],
      networks: [],

      counts: {
        containers: 1,
        running: 1,
        images: 0,
        volumes: 0,
        networks: 0

      },

    }),

    wsUrl: (url) => 'ws://grigdesk.test' + url,

  };
  setActivePinia(pinia);

  const component = await compileVue(webFile('src/views/docker/DockerPanel.vue'), {
    stubs: {
      '../shared/dockerApi': `export const dockerApi = globalThis.__toolDockerApi;
      export const dockerErrorMessage = error => error.message;`,
    }
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const first = mount(component, { global: { plugins: [pinia] } });

  t.after(() => {
    first.unmount();
    disposePinia(pinia);
    globalThis.WebSocket = originalSocket;
    delete globalThis.__toolDockerApi;
  });
  await flushPromises();
  assert.match(first.text(), /Контейнер/);
  assert.equal(sockets.filter((socket) => socket.readyState === 1).length, 1);
  assert.equal(typeof first.vm.exportState, 'function', 'DockerPanel не переносит выбранный viewer/tab');
  await first.get('#docker-tab-images').trigger('click');

  const state = await first.vm.exportState();

  first.unmount();
  assert.equal(sockets.every((socket) => socket.readyState === 3), true);

  const second = mount(component, { global: { plugins: [pinia] } });

  t.after(() => second.unmount());
  await second.vm.importState(state);
  await flushPromises();
  assert.equal(second.get('#docker-tab-images').attributes('aria-selected'), 'true');
  assert.equal(sockets.filter((socket) => socket.readyState === 1).length, 0);
});
