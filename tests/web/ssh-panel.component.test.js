import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const PANEL_PATH = webFile('src/views/ssh/SshPanel.vue');

async function mountPanel(t, { pending = {}, store: storeOverrides = {}, props = {} } = {}) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/ssh');
  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const savedConnections = [];
  const store = reactive({
    connections: [],
    projects: [
      { id: 'grigdesk', factory: false },
      { id: 'factory-project', factory: true },
    ],
    files: [],
    audit: [],
    remotePath: '.',
    sessions: [
      {
        id: 'session-a',
        projectId: 'grigdesk',
        label: 'Боевой код',
        role: 'code',
        agentAllowed: true,
      },
      {
        id: 'session-b',
        projectId: 'grigdesk',
        label: 'База',
        role: 'db',
        agentAllowed: false,
      },
    ],
    activeId: 'session-a',
    approvals: [],
    async load() {},
    async loadProjects() {},
    async saveConnection(connection) { savedConnections.push(connection); },
    async closeSession() {},
    async setAgentAccess() {},
    async listFiles() {},
    async uploadFile() {},
    downloadUrl: (path) => `/api/ssh/download?path=${path}`,
    activate(id) { this.activeId = id; },
    bindTerminal() {},
    sendInput() {},
    resize() {},
    detach() {},
    ...storeOverrides,
  });
  const answers = [];
  const chatStore = {
    pending,
    answerPerm(...args) {
      answers.push(args);
    },
  };
  globalThis.__sshPanelStore = store;
  globalThis.__sshPanelChatStore = chatStore;
  globalThis.__sshPanelTerminals = [];
  globalThis.__chatPermissionPrompt = async () => null;
  let component;
  try {
    component = await compileVue(PANEL_PATH, {
      stubs: {
        '../../actions/ssh': `
          const bridge = () => globalThis.__sshPanelStore;
          export const useSshStore = bridge;
          export const loadSsh = (...args) => bridge().load(...args);
          export const loadSshProjects = (...args) => bridge().loadProjects(...args);
          export const saveSshConnection = (...args) => bridge().saveConnection(...args);
          export const probeSshHostKey = (...args) => bridge().probeHostKey(...args);
          export const decideSshHostKey = (...args) => bridge().decideHostKey(...args);
          export const connectSshSession = (...args) => bridge().connect(...args);
          export const closeSshSession = (...args) => bridge().closeSession(...args);
          export const setSshAgentAccess = (...args) => bridge().setAgentAccess(...args);
          export const listSshFiles = (...args) => bridge().listFiles(...args);
          export const uploadSshFile = (...args) => bridge().uploadFile(...args);
          export const sshDownloadUrl = (...args) => bridge().downloadUrl(...args);
          export const activateSshSession = (...args) => bridge().activate(...args);
          export const bindSshTerminal = (...args) => bridge().bindTerminal(...args);
          export const sendSshInput = (...args) => bridge().sendInput(...args);
          export const resizeSshTerminal = (...args) => bridge().resize(...args);
          export const detachSshTerminal = (...args) => bridge().detach(...args);
          export const watchSsh = () => {};
        `,
        '../../shared/chatApprovals.ts': (
          'export const useChatApprovals = () => globalThis.__sshPanelChatStore;'
        ),
        './services/dialogs': `
          export const promptDialog = (options) => globalThis.__chatPermissionPrompt(options);
          export const confirmDialog = () => Promise.resolve(false);
          export const alertDialog = () => Promise.resolve();
        `,
        '@xterm/xterm': `
          export class Terminal {
            constructor() {
              this.cols = 100;
              this.rows = 30;
              globalThis.__sshPanelTerminals.push(this);
            }
            loadAddon() {}
            open() {}
            dispose() {}
            write() {}
            focus() {}
            onData() { return { dispose() {} }; }
          }
        `,
        '@xterm/addon-fit': 'export class FitAddon { fit() {} }',
      },
    });
  } catch (error) {
    assert.fail(`панель SSH ещё не реализована: ${error.message}`);
  }
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, {
    attachTo: browser.document.querySelector('#mount'),
    props,
  });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__sshPanelStore;
    delete globalThis.__sshPanelChatStore;
    delete globalThis.__sshPanelTerminals;
    delete globalThis.__chatPermissionPrompt;
  });
  await flushPromises();
  return { wrapper, store, chatStore, answers, savedConnections, flushPromises };
}

test('две server-owned сессии показаны вкладками при одном xterm', async (t) => {
  const { wrapper } = await mountPanel(t);

  assert.deepEqual({
    maturity: {
      heading: wrapper.get('#ssh-panel-title').text(),
      text: wrapper.get('[data-product-maturity="beta"]').text(),
      label: wrapper.get('[data-product-maturity="beta"]').attributes('aria-label'),
      role: wrapper.get('[data-product-maturity="beta"]').attributes('role'),
      inTitle: wrapper.get('.ssh-panel__title [data-product-maturity="beta"]').exists(),
      inSummary: wrapper.find('.ssh-panel__summary [data-product-maturity]').exists(),
    },
    tabs: wrapper.findAll('[role="tab"]').map((entry) => ({
      project: entry.get('[data-ssh-session-project]').text(),
      target: entry.get('[data-ssh-session-target]').text(),
    })),
    terminals: globalThis.__sshPanelTerminals.length,
    terminalHosts: wrapper.findAll('[data-ssh-terminal-host]').length,
  }, {
    maturity: {
      heading: 'SSH', text: 'бета', label: 'Бета-версия', role: undefined,
      inTitle: true, inSummary: false,
    },
    tabs: [
      { project: 'grigdesk', target: 'Боевой код · code' },
      { project: 'grigdesk', target: 'База · db' },
    ],
    terminals: 1,
    terminalHosts: 1,
  });
});

test('одноимённые сессии показывают проект и различаются ролью во вкладках', async (t) => {
  const { wrapper } = await mountPanel(t, {
    store: {
      sessions: [
        {
          id: 'session-backend',
          connectionId: 'connection-backend',
          projectId: 'arsenkin',
          label: 'production',
          role: 'backend',
          host: 'backend.internal',
          port: 22,
          user: 'root',
        },
        {
          id: 'session-db',
          connectionId: 'connection-db',
          projectId: 'arsenkin',
          label: 'production',
          role: 'db',
          host: 'db.internal',
          port: 22,
          user: 'root',
        },
      ],
      activeId: 'session-backend',
    },
  });

  assert.deepEqual(
    wrapper.findAll('[role="tab"]').map((tab) => ({
      project: tab.get('[data-ssh-session-project]').text(),
      target: tab.get('[data-ssh-session-target]').text(),
      ariaLabel: tab.attributes('aria-label'),
      title: tab.attributes('data-ui-tooltip'),
    })),
    [
      {
        project: 'arsenkin',
        target: 'production · backend',
        ariaLabel: 'Проект arsenkin, сессия production · backend, root@backend.internal:22',
        title: 'Проект arsenkin — production · backend — root@backend.internal:22',
      },
      {
        project: 'arsenkin',
        target: 'production · db',
        ariaLabel: 'Проект arsenkin, сессия production · db, root@db.internal:22',
        title: 'Проект arsenkin — production · db — root@db.internal:22',
      },
    ],
  );
});

test('повторные сессии одного сервера получают видимый порядковый номер', async (t) => {
  const { wrapper } = await mountPanel(t, {
    store: {
      sessions: [
        {
          id: 'session-first',
          projectId: 'grigdesk',
          label: 'production',
          role: 'backend',
        },
        {
          id: 'session-second',
          projectId: 'grigdesk',
          label: 'production',
          role: 'backend',
        },
      ],
      activeId: 'session-first',
    },
  });

  assert.deepEqual(
    wrapper.findAll('[data-ssh-session-target]').map((target) => target.text()),
    ['production · backend · 1', 'production · backend · 2'],
  );
});

test('переключение внутренней вкладки переиспользует тот же xterm', async (t) => {
  const { wrapper, store, flushPromises } = await mountPanel(t);
  await wrapper.findAll('[role="tab"]')[1].trigger('click');
  await flushPromises();

  assert.deepEqual({ activeId: store.activeId, terminals: globalThis.__sshPanelTerminals.length }, {
    activeId: 'session-b',
    terminals: 1,
  });
});

test('подключённый сервер открывает живую сессию без нового probe', async (t) => {
  let probes = 0;
  const connection = {
    id: 'connection-a',
    projectId: 'grigdesk',
    label: 'Production',
    role: 'backend',
    host: 'server.internal',
    port: 22,
    user: 'deploy',
  };
  const { wrapper, store, flushPromises } = await mountPanel(t, {
    store: {
      connections: [connection],
      sessions: [
        {
          id: 'session-a',
          connectionId: 'connection-a',
          label: 'Production',
          role: 'backend',
          host: 'server.internal',
          port: 22,
          user: 'deploy',
        },
        {
          id: 'session-b',
          connectionId: 'connection-b',
          label: 'Database',
          role: 'db',
        },
      ],
      activeId: 'session-b',
      async probeHostKey() {
        probes += 1;
      },
    },
  });
  const card = wrapper.get('.ssh-connection');
  const selected = wrapper.get('.ssh-selected');

  assert.deepEqual({
    button: selected.get('[aria-label="Открыть терминал Production"]').text(),
    loginOpen: selected.find('.ssh-connection__login').exists(),
  }, {
    button: 'Открыть терминал',
    loginOpen: false,
  });

  await card.trigger('click');
  await flushPromises();

  assert.deepEqual({
    activeId: store.activeId,
    current: card.classes().includes('is-current'),
    button: selected.get('[aria-label="Открыть терминал Production"]').text(),
    probes,
    terminals: globalThis.__sshPanelTerminals.length,
  }, {
    activeId: 'session-a',
    current: true,
    button: 'К терминалу',
    probes: 0,
    terminals: 1,
  });
});

test('без активной сессии панель показывает подсказку вместо пустого xterm', async (t) => {
  const { wrapper } = await mountPanel(t, {
    store: {
      sessions: [],
      activeId: '',
    },
  });

  assert.deepEqual({
    terminals: globalThis.__sshPanelTerminals.length,
    message: wrapper.find('.ssh-console__empty strong').text(),
    hint: wrapper.find('.ssh-console__empty > span:last-child').text(),
  }, {
    terminals: 0,
    message: 'Нет активной SSH-сессии',
    hint: 'Выберите сохранённый сервер — терминал появится после входа.',
  });
});

test('стрелки переключают сессии и фокус без второго xterm', async (t) => {
  const { wrapper, store, flushPromises } = await mountPanel(t);
  const tabs = wrapper.findAll('[role="tab"]');

  await tabs[0].trigger('keydown', { key: 'ArrowRight' });
  await flushPromises();

  assert.deepEqual({
    activeId: store.activeId,
    focused: wrapper.element.ownerDocument.activeElement?.getAttribute('aria-label'),
    terminals: globalThis.__sshPanelTerminals.length,
  }, {
    activeId: 'session-b',
    focused: 'Проект grigdesk, сессия База · db',
    terminals: 1,
  });
});

test('закрытие активной сессии выбирает соседнюю вкладку и возвращает фокус', async (t) => {
  const { wrapper, store, flushPromises } = await mountPanel(t, {
    store: {
      async closeSession(id) {
        this.activeId = '';
        this.sessions = this.sessions.filter((session) => session.id !== id);
      },
    },
  });
  const close = wrapper.find('[aria-label="Закрыть активную сессию Боевой код"]');
  close.element.focus();
  await close.trigger('click');
  await flushPromises();

  const tabs = wrapper.findAll('[role="tab"]');
  assert.deepEqual({
    activeId: store.activeId,
    labels: tabs.map((tab) => tab.text()),
    selected: tabs[0]?.attributes('aria-selected'),
    tabindex: tabs[0]?.attributes('tabindex'),
    focused: wrapper.element.ownerDocument.activeElement?.getAttribute('aria-label'),
  }, {
    activeId: 'session-b',
    labels: ['ПроектgrigdeskБаза · db'],
    selected: 'true',
    tabindex: '0',
    focused: 'Проект grigdesk, сессия База · db',
  });
});

test('FitAddon видит отступы xterm и не обрезает нижнюю строку', async () => {
  const source = await readFile(PANEL_PATH, 'utf8');
  const hostRule = source.match(/\.ssh-terminal\s*\{(?<body>[^}]*)\}/su)?.groups?.body || '';
  const xtermRule = source.match(
    /\.ssh-terminal :deep\(\.xterm\)\s*\{(?<body>[^}]*)\}/su,
  )?.groups?.body || '';

  assert.doesNotMatch(hostRule, /\bpadding\s*:/u);
  assert.match(xtermRule, /box-sizing:\s*border-box;/u);
  assert.match(xtermRule, /padding:\s*9px 10px;/u);
});

test('мобильная page-панель не резервирует место под кнопки дока', async (t) => {
  const { wrapper } = await mountPanel(t, {
    props: {
      compact: true,
      presentation: 'page',
    },
  });

  assert.deepEqual({
    compact: wrapper.classes().includes('is-compact'),
    dock: wrapper.classes().includes('is-dock'),
    regions: [...wrapper.get('.ssh-layout').element.children]
      .map((element) => element.className),
  }, {
    compact: true,
    dock: false,
    regions: ['ssh-workspace', 'ssh-connections'],
  });
});

test('бета-метка SSH остаётся в шапке компактного дока', async (t) => {
  const { wrapper } = await mountPanel(t, {
    props: {
      compact: true,
      presentation: 'dock',
    },
  });

  assert.deepEqual({
    compact: wrapper.classes().includes('is-compact'),
    dock: wrapper.classes().includes('is-dock'),
    chips: wrapper.findAll('.ssh-panel__title [data-product-maturity="beta"]').length,
  }, {
    compact: true,
    dock: true,
    chips: 1,
  });
});

test('медленная загрузка не открывает терминал после unmount', async (t) => {
  let finishLoad;
  const loading = new Promise((resolve) => {
    finishLoad = resolve;
  });
  const activations = [];
  const { wrapper, flushPromises } = await mountPanel(t, {
    store: {
      async load() { await loading; },
      activate(id) { activations.push(id); },
    },
  });

  wrapper.unmount();
  finishLoad();
  await flushPromises();

  assert.deepEqual({
    activations,
    terminals: globalThis.__sshPanelTerminals.length,
  }, {
    activations: [],
    terminals: 0,
  });
});

test('новое соединение выбирает проект из реестра и сохраняет его id', async (t) => {
  const { wrapper, savedConnections, flushPromises } = await mountPanel(t);
  const project = wrapper.find('[data-ssh-project-select]');

  assert.deepEqual(
    project.findAll('option').map((option) => ({
      value: option.element.value,
      text: option.text(),
    })),
    [
      { value: '', text: 'Выберите проект' },
      { value: 'grigdesk', text: 'grigdesk' },
      { value: 'factory-project', text: 'factory-project' },
    ],
  );

  await project.setValue('grigdesk');
  await wrapper.find('.ssh-profile-form').trigger('submit');
  await flushPromises();

  assert.equal(savedConnections[0]?.projectId, 'grigdesk');
});

test('повторный вход не дублирует probe, а пароль очищается после подключения', async (t) => {
  let finishProbe;
  let probes = 0;
  const connected = [];
  const probe = new Promise((resolve) => {
    finishProbe = resolve;
  });
  const connection = {
    id: 'connection-a',
    projectId: 'grigdesk',
    label: 'Production',
    role: 'backend',
    host: 'server.internal',
    port: 22,
    user: 'deploy',
  };
  const { wrapper, flushPromises } = await mountPanel(t, {
    store: {
      connections: [connection],
      async probeHostKey() {
        probes += 1;

        return probe;
      },
      async connect(id, password) {
        connected.push([id, password]);
      },
    },
  });
  const form = wrapper.find('.ssh-connection__login');
  const password = form.find('input[type="password"]');

  await password.setValue('секрет');
  await form.trigger('submit');
  await form.trigger('submit');

  assert.equal(probes, 1);

  finishProbe({ status: 'trusted' });
  await flushPromises();

  assert.deepEqual({
    connected,
    password: password.element.value,
  }, {
    connected: [['connection-a', 'секрет']],
    password: '',
  });
});

test('SSH-панель показывает карточку из общего chat.pending', async (t) => {
  const command = `sudo printf '${'x'.repeat(2_000)}'`;
  const pending = {
    'ssh-pid-1': {
      pid: 'ssh-pid-1',
      origin: 'ssh',
      kind: 'perm',
      chatKey: 'chat-a',
      tool: 'supervised_ssh',
      server: { label: 'Боевой код', host: 'server.internal', port: 22 },
      user: 'root',
      isRoot: true,
      usesSudo: true,
      command,
    },
  };
  const { wrapper } = await mountPanel(t, { pending });

  assert.deepEqual({
    cards: wrapper.findAll('[data-ssh-approval]').length,
    server: wrapper.find('[data-ssh-server]').text(),
    command: wrapper.find('[data-ssh-command]').text(),
  }, {
    cards: 1,
    server: 'Боевой код — server.internal:22',
    command,
  });
});

test('SSH-панель отвечает через ту же chat.answerPerm', async (t) => {
  const pending = {
    'ssh-pid-1': {
      pid: 'ssh-pid-1',
      origin: 'ssh',
      kind: 'perm',
      chatKey: 'chat-a',
      tool: 'supervised_ssh',
      server: { label: 'Боевой код', host: 'server.internal', port: 22 },
      user: 'deploy',
      command: 'id',
    },
  };
  const { wrapper, answers } = await mountPanel(t, { pending });
  const allow = wrapper.findAll('button').find((entry) => entry.text() === 'Разрешить');
  if (allow) {
    await allow.trigger('click');
  }

  assert.deepEqual({ button: !!allow, answers }, {
    button: true,
    answers: [['ssh-pid-1', true, false, '', '']],
  });
});

test('SSH-панель разрешает отказ без пояснения', async (t) => {
  const pending = {
    'ssh-pid-1': {
      pid: 'ssh-pid-1',
      origin: 'ssh',
      kind: 'perm',
      chatKey: 'chat-a',
      tool: 'supervised_ssh',
      server: { label: 'Боевой код', host: 'server.internal', port: 22 },
      user: 'deploy',
      command: 'id',
    },
  };
  const { wrapper, answers } = await mountPanel(t, { pending });
  const deny = wrapper.findAll('button').find((entry) => entry.text() === 'Отказать');
  await deny?.trigger('click');

  assert.deepEqual(answers, [['ssh-pid-1', false, false, '', '']]);
});

test('архивный проект не предлагается новой связи, но заведённая остаётся видимой', async (t) => {
  const { wrapper } = await mountPanel(t, {
    store: {
      projects: [
        { id: 'grigdesk', factory: false, archivedAt: null },
        { id: 'kopeika', factory: false, archivedAt: '2026-09-22T10:00:00.000Z' },
      ],
      connections: [
        {
          id: 'conn-archived',
          projectId: 'kopeika',
          label: 'Старый сервер',
          role: 'code',
          host: 'example.test',
          port: 22,
          user: 'deploy',
        },
      ],
    },
  });

  const options = wrapper.findAll('[data-ssh-project-select] option')
    .map((option) => option.attributes('value'))
    .filter(Boolean);

  // Новый сервер заводят только на активный проект: архивным больше не работают.
  assert.deepEqual(options, ['grigdesk']);
  // Архив ничего не рвёт: уже заведённая связь остаётся на месте вместе со своим проектом.
  assert.equal(wrapper.text().includes('Старый сервер'), true);
});

const layoutConnections = [
  {
    id: 'app',
    projectId: 'demo-app',
    label: 'Production',
    role: 'backend',
    host: 'app.example.test',
    port: 22,
    user: 'deploy',
  },
  {
    id: 'db',
    projectId: 'demo-data',
    label: 'Database',
    role: 'db',
    host: 'db.example.test',
    port: 2222,
    user: 'admin',
  },
];

test('каталог группирует серверы и показывает только один вход для выбранной строки', async (t) => {
  const { wrapper, flushPromises } = await mountPanel(t, {
    store: {
      connections: layoutConnections,
      sessions: [],
      activeId: '',
    },
  });

  assert.deepEqual(wrapper.findAll('.ssh-project-heading strong').map((item) => item.text()),
    ['demo-app', 'demo-data']);
  assert.equal(wrapper.findAll('.ssh-connection__login').length, 1);

  await wrapper.get('input[type="password"]').setValue('одноразовый');
  await wrapper.get('[data-connection-id="db"]').trigger('click');
  await flushPromises();

  assert.equal(wrapper.get('.ssh-selected__heading strong').text(), 'Database');
  assert.equal(wrapper.get('input[type="password"]').element.value, '');

  await wrapper.get('[data-connection-id="app"]').trigger('click');
  await flushPromises();

  assert.equal(wrapper.get('input[type="password"]').element.value, '');
});

test('поиск учитывает проект, адрес и роль без сброса выбранного входа', async (t) => {
  const { wrapper, flushPromises } = await mountPanel(t, {
    store: {
      connections: layoutConnections,
      sessions: [],
      activeId: '',
    },
  });
  const search = wrapper.get('[aria-label="Поиск сервера"]');

  for (const query of ['DEMO-DATA', 'db.example.test', 'admin', '2222']) {
    await search.setValue(query);
    await flushPromises();

    assert.deepEqual(wrapper.findAll('.ssh-connection').map((row) => row.attributes('data-connection-id')),
      ['db']);
  }

  await search.setValue('missing');
  await flushPromises();

  assert.equal(wrapper.findAll('.ssh-connection').length, 0);
  assert.equal(wrapper.get('.ssh-selected__heading strong').text(), 'Production');
  assert.equal(wrapper.text().includes('Подходящих серверов нет.'), true);
});

test('форма сохраняет черновик и один xterm при открытии и возврате к терминалу', async (t) => {
  const { wrapper, flushPromises } = await mountPanel(t);
  const toggle = wrapper.get('[aria-controls="ssh-create"]');

  await toggle.trigger('click');
  await wrapper.get('[aria-label="Метка сервера"]').setValue('Новый сервер');
  await toggle.trigger('click');
  await toggle.trigger('click');
  await flushPromises();

  assert.equal(wrapper.get('[aria-label="Метка сервера"]').element.value, 'Новый сервер');
  assert.equal(wrapper.get('#ssh-create').isVisible(), true);
  assert.equal(wrapper.get('.ssh-console').isVisible(), false);
  assert.equal(globalThis.__sshPanelTerminals.length, 1);

  await wrapper.get('[aria-controls="ssh-connections"]').trigger('click');
  await wrapper.get('[aria-controls="ssh-workspace"]').trigger('click');
  await flushPromises();

  assert.equal(wrapper.get('[aria-label="Метка сервера"]').element.value, 'Новый сервер');
  assert.equal(globalThis.__sshPanelTerminals.length, 1);
});

test('обновление реестра сохраняет выбранный сервер, удаление выбирает оставшийся', async (t) => {
  const { wrapper, store, flushPromises } = await mountPanel(t, {
    store: {
      connections: layoutConnections,
      sessions: [],
      activeId: '',
    },
  });

  await wrapper.get('[data-connection-id="db"]').trigger('click');
  store.connections = layoutConnections.map((connection) => ({ ...connection }));
  await flushPromises();

  assert.equal(wrapper.get('.ssh-selected__heading strong').text(), 'Database');

  store.connections = [layoutConnections[0]];
  await flushPromises();

  assert.equal(wrapper.get('.ssh-selected__heading strong').text(), 'Production');
});

test('гармошка открывает один проект, сохраняя выбранный сервер и его вход', async (t) => {
  const { wrapper, flushPromises } = await mountPanel(t, {
    store: {
      connections: layoutConnections,
      sessions: [],
      activeId: '',
    },
  });
  const app = wrapper.get('[data-ssh-project="demo-app"]');
  const data = wrapper.get('[data-ssh-project="demo-data"]');
  const password = wrapper.get('input[type="password"]');

  assert.equal(app.attributes('aria-expanded'), 'true');
  assert.equal(data.attributes('aria-expanded'), 'false');
  assert.equal(wrapper.get('[data-connection-id="db"]').isVisible(), false);

  await password.setValue('одноразовый');
  await data.trigger('click');
  await flushPromises();

  assert.equal(app.attributes('aria-expanded'), 'false');
  assert.equal(data.attributes('aria-expanded'), 'true');
  assert.equal(wrapper.get('[data-connection-id="app"]').isVisible(), false);
  assert.equal(wrapper.get('[data-connection-id="db"]').isVisible(), true);
  assert.equal(wrapper.get('.ssh-selected__heading strong').text(), 'Production');
  assert.equal(password.element.value, 'одноразовый');

  await data.trigger('click');
  await flushPromises();

  assert.equal(data.attributes('aria-expanded'), 'false');
  assert.equal(wrapper.get('.ssh-connection__login').isVisible(), true);
  assert.equal(globalThis.__sshPanelTerminals.length, 0);
});

test('поиск раскрывает совпадения и возвращает прежнее раскрытие после очистки', async (t) => {
  const { wrapper, flushPromises } = await mountPanel(t, {
    store: {
      connections: layoutConnections,
      sessions: [],
      activeId: '',
    },
  });

  await wrapper.get('[data-ssh-project="demo-data"]').trigger('click');
  await wrapper.get('[aria-label="Поиск сервера"]').setValue('demo-');
  await flushPromises();

  assert.equal(wrapper.findAll('[data-ssh-project][aria-expanded="true"]').length, 2);
  assert.equal(wrapper.findAll('.ssh-connection').every((row) => row.isVisible()), true);
  assert.equal(wrapper.get('[data-ssh-project="demo-app"]').attributes('disabled'), '');

  await wrapper.get('[aria-label="Поиск сервера"]').setValue('');
  await flushPromises();

  assert.equal(wrapper.get('[data-ssh-project="demo-app"]').attributes('aria-expanded'), 'false');
  assert.equal(wrapper.get('[data-ssh-project="demo-data"]').attributes('aria-expanded'), 'true');
});

test('обновление сохраняет ручное сворачивание, выбор связи раскрывает её проект', async (t) => {
  const { wrapper, store, flushPromises } = await mountPanel(t, {
    store: {
      connections: layoutConnections,
      sessions: [],
      activeId: '',
    },
  });

  await wrapper.get('[data-ssh-project="demo-app"]').trigger('click');
  store.connections = layoutConnections.map((connection) => ({ ...connection }));
  await flushPromises();

  assert.equal(wrapper.get('[data-ssh-project="demo-app"]').attributes('aria-expanded'), 'false');

  await wrapper.get('[data-ssh-project="demo-data"]').trigger('click');
  await wrapper.get('[data-connection-id="db"]').trigger('click');
  await wrapper.get('[data-ssh-project="demo-app"]').trigger('click');
  await flushPromises();

  assert.equal(wrapper.get('[data-ssh-project="demo-data"]').attributes('aria-expanded'), 'false');
  assert.equal(wrapper.get('.ssh-selected__heading strong').text(), 'Database');

  store.connections = [layoutConnections[1]];
  await flushPromises();

  assert.equal(wrapper.get('[data-ssh-project="demo-data"]').attributes('aria-expanded'), 'true');
});

test('каталог подписывает серверы и живые сессии словами, а не сокращением', async (t) => {
  const { wrapper } = await mountPanel(t, {
    store: {
      connections: [
        {
          id: 'c-app',
          projectId: 'demo-app',
          label: 'Production',
          role: 'backend',
          host: 'app.example.test',
          port: 22,
          user: 'deploy',
        },
        {
          id: 'c-db',
          projectId: 'demo-app',
          label: 'Database',
          role: 'db',
          host: 'db.example.test',
          port: 22,
          user: 'admin',
        },
      ],
      sessions: [
        {
          id: 's-app-1',
          connectionId: 'c-app',
          label: 'Production',
          role: 'backend',
        },
        {
          id: 's-app-2',
          connectionId: 'c-app',
          label: 'Production',
          role: 'backend',
        },
      ],
      activeId: '',
    },
  });

  assert.deepEqual({
    total: wrapper.get('[data-ssh-server-count]').text(),
    group: wrapper.get('[data-ssh-project="demo-app"]').attributes('aria-label'),
    serverTotal: wrapper.get('.ssh-project-heading .ssh-server-total').text(),
    groupPill: wrapper.get('.ssh-project-heading .ssh-session-pill')
      .attributes('aria-label'),
    groupPillText: wrapper.get('.ssh-project-heading .ssh-session-pill').text(),
    pill: wrapper.get('[data-connection-id="c-app"] .ssh-session-pill')
      .attributes('aria-label'),
    idle: wrapper.find('[data-connection-id="c-db"] .ssh-session-pill').exists(),
  }, {
    total: '2',
    group: 'Проект demo-app, 2 сервера, 2 живые сессии',
    serverTotal: '2 сервера',
    groupPill: '2 живые сессии',
    groupPillText: '2',
    pill: '2 живые сессии',
    idle: false,
  });
});

test('пустой каталог ведёт в форму нового сервера', async (t) => {
  const { wrapper, flushPromises } = await mountPanel(t, {
    store: {
      connections: [],
      sessions: [],
      activeId: '',
    },
  });
  const empty = wrapper.get('.ssh-catalog-empty');
  const create = empty.findAll('button').find((button) => button.text() === 'Добавить сервер');

  assert.equal(empty.get('strong').text(), 'Серверов пока нет');

  await create.trigger('click');
  await flushPromises();

  assert.equal(wrapper.get('#ssh-create').isVisible(), true);
});

test('промах поиска предлагает сброс и сохраняет карточку выбранного сервера', async (t) => {
  const { wrapper, flushPromises } = await mountPanel(t, {
    store: {
      connections: layoutConnections,
      sessions: [],
      activeId: '',
    },
  });

  await wrapper.get('[aria-label="Поиск сервера"]').setValue('missing');
  await flushPromises();

  const reset = wrapper.get('.ssh-catalog-empty')
    .findAll('button')
    .find((button) => button.text() === 'Сбросить поиск');

  assert.equal(wrapper.get('.ssh-selected__heading strong').text(), 'Production');
  assert.equal(Boolean(reset), true);

  await reset.trigger('click');
  await flushPromises();

  assert.equal(wrapper.findAll('.ssh-connection').length, 2);
  assert.equal(wrapper.find('[aria-label="Поиск сервера"]').element.value, '');
});

test('новая сессия раскрывает пароль в карточке выбранного сервера', async (t) => {
  const { wrapper, flushPromises } = await mountPanel(t, {
    store: {
      connections: [layoutConnections[0]],
      sessions: [
        {
          id: 's-app',
          connectionId: 'app',
          projectId: 'demo-app',
          label: 'Production',
          role: 'backend',
        },
      ],
      activeId: '',
    },
  });
  const toggle = wrapper.get('[aria-controls="ssh-login"]');

  assert.equal(wrapper.find('.ssh-connection__login').exists(), false);

  await toggle.trigger('click');
  await flushPromises();

  assert.deepEqual({
    expanded: wrapper.get('[aria-controls="ssh-login"]').attributes('aria-expanded'),
    login: wrapper.get('.ssh-connection__login').isVisible(),
    fields: wrapper.findAll('input[type="password"]').length,
  }, {
    expanded: 'true',
    login: true,
    fields: 1,
  });
});
