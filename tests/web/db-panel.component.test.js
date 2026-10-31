import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const PANEL = webFile('src/views/db/DbPanel.vue');
const DB_ACTIONS_STUB = `
  const bridge = () => globalThis.__dbPanelStore;
  export const useDbStore = bridge;
  export const loadDb = (...args) => bridge().load(...args);
  export const loadDbProjects = (...args) => bridge().loadProjects?.(...args);
  export const loadDbSshSessions = (...args) => bridge().loadSshSessions?.(...args);
  export const loadDbSchema = (...args) => bridge().loadSchema?.(...args);
  export const openDbSession = (...args) => bridge().openSession?.(...args);
  export const closeDbSession = (...args) => bridge().closeSession?.(...args);
  export const setDbAgentAccess = (...args) => bridge().setAgentAccess?.(...args);
  export const saveDbProfile = (...args) => bridge().saveProfile?.(...args);
  export const runDbQuery = (...args) => bridge().runQuery?.(...args);
  export const cancelDbQuery = (...args) => bridge().cancelQuery?.(...args);
  export const watchDb = () => {};
`;

async function mountPanel(t, store, props = {}) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/db');
  globalThis.__dbPanelStore = store;
  const component = await compileVue(PANEL, {
    stubs: {
      // Заглушка сопоставляется по точной строке импорта: панель зовёт операции
      // раздела, а состояние берёт из того же реактивного объекта.
      '../../actions/db': DB_ACTIONS_STUB,
      '../../stores/dbEngineInstall.ts': `
        export const useDbEngineInstallStore = () => ({
          job: null, versions: [], error: null, recoveryError: null, pendingAction: null,
          reconciling: false, busy: false, versionsLoading: false, versionsInputKey: '', versionsUrl: '',
          loadJob: async () => {}, invalidateVersions: () => {},
        });
      `,
    },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, {
    attachTo: browser.document.querySelector('#mount'),
    props,
  });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__dbPanelStore;
  });
  await flushPromises();

  return { wrapper, flushPromises };
}

test('панель БД объединяет сессии схему консоль ленту отмену и журнал', async (t) => {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/db');
  globalThis.__dbPanelStore = {
    profiles: [],
    sessions: [],
    sshSessions: [],
    engines: [],
    queries: [{
      id: 'query-a', text: 'SELECT id FROM orders', actor: 'agent', state: 'running',
    }],
    audit: [{ at: '2026-09-02T00:00:00.000Z', query: 'SELECT 1', outcome: 'success' }],
    schemas: {},
    load: async () => {},
    cancelQuery: async () => {},
  };
  let component;

  try {
    component = await compileVue(PANEL, {
      stubs: {
        '../../actions/db': DB_ACTIONS_STUB,
      '../../stores/dbEngineInstall.ts': `
        export const useDbEngineInstallStore = () => ({
          job: null, versions: [], error: null, recoveryError: null, pendingAction: null,
          reconciling: false, busy: false, versionsLoading: false, versionsInputKey: '', versionsUrl: '',
          loadJob: async () => {}, invalidateVersions: () => {},
        });
      `,
      },
    });
  } catch (error) {
    assert.fail(`единая DB-панель ещё не реализована: ${error.message}`);
  }
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, { attachTo: browser.document.querySelector('#mount') });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__dbPanelStore;
  });
  await flushPromises();

  assert.deepEqual(
    ['profiles', 'sessions', 'schema', 'console', 'queries', 'cancel', 'audit']
      .map((name) => wrapper.find(`[data-db-${name}]`).exists()),
    [true, true, true, true, true, true, true],
  );
  assert.match(wrapper.text(), /SELECT id FROM orders/u);
  assert.match(wrapper.text(), /агент · выполняется/u);
  assert.match(wrapper.text(), /успешно/u);
  assert.equal(wrapper.get('[data-db-cancel]').attributes('disabled'), undefined);
});

test('панель передаёт выбранную SSH-сессию при открытии DB via ssh', async (t) => {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/db');
  const calls = [];
  globalThis.__dbPanelStore = {
    profiles: [{
      id: 'profile-a', projectId: 'grigdesk', label: 'Прод', role: 'read',
      engine: 'clickhouse', via: 'ssh',
    }],
    sessions: [],
    sshSessions: [{ id: 'ssh-session-a', projectId: 'grigdesk', label: 'Бастион' }],
    engines: [{ id: 'clickhouse', label: 'ClickHouse' }],
    queries: [],
    audit: [],
    schemas: {},
    load: async () => {},
    loadSshSessions: async () => {},
    async openSession(...args) {
      calls.push(args);
    },
  };
  const component = await compileVue(PANEL, {
    stubs: {
      // Заглушка сопоставляется по точной строке импорта: панель зовёт операции
      // раздела, а состояние берёт из того же реактивного объекта.
      '../../actions/db': DB_ACTIONS_STUB,
      '../../stores/dbEngineInstall.ts': `
        export const useDbEngineInstallStore = () => ({
          job: null, versions: [], error: null, recoveryError: null, pendingAction: null,
          reconciling: false, busy: false, versionsLoading: false, versionsInputKey: '', versionsUrl: '',
          loadJob: async () => {}, invalidateVersions: () => {},
        });
      `,
    },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, { attachTo: browser.document.querySelector('#mount') });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__dbPanelStore;
  });
  await wrapper.get('[data-profile-id="profile-a"]').trigger('click');
  await flushPromises();
  await wrapper.get('.db-connect-form').trigger('submit');
  await flushPromises();
  assert.deepEqual(calls, []);

  await wrapper.get('[data-db-ssh-session]').setValue('ssh-session-a');
  await wrapper.get('input[type="password"]').setValue('secret');
  await wrapper.findAll('button').find((button) => button.text() === 'Открыть сессию').trigger('click');
  await flushPromises();

  assert.deepEqual(calls, [['profile-a', 'secret', 'ssh-session-a']]);
});

test('панель БД использует каркас ToolHost и явные пустые состояния', async (t) => {
  const { wrapper } = await mountPanel(t, {
    profiles: [],
    projects: [],
    sessions: [],
    sshSessions: [],
    engines: [],
    queries: [],
    audit: [],
    schemas: {},
    async load() {},
    async loadProjects() {},
  }, {
    compact: true,
    presentation: 'dock',
  });

  assert.deepEqual({
    maturity: {
      heading: wrapper.get('#db-panel-title').text(),
      text: wrapper.get('[data-product-maturity="beta"]').text(),
      label: wrapper.get('[data-product-maturity="beta"]').attributes('aria-label'),
      role: wrapper.get('[data-product-maturity="beta"]').attributes('role'),
      inTitle: wrapper.get('.db-panel__title [data-product-maturity="beta"]').exists(),
      inSummary: wrapper.find('.db-panel__summary [data-product-maturity]').exists(),
    },
    compact: wrapper.classes().includes('is-compact'),
    dock: wrapper.classes().includes('is-dock'),
    workspace: wrapper.find('.db-workspace').exists(),
    profiles: wrapper.find('.db-profiles').exists(),
    emptyProfile: wrapper.find('.db-profiles__empty').text(),
    emptyResult: wrapper.find('.db-result-state').text(),
  }, {
    maturity: {
      heading: 'Базы', text: 'бета', label: 'Бета-версия', role: undefined,
      inTitle: true, inSummary: false,
    },
    compact: true,
    dock: true,
    workspace: true,
    profiles: true,
    emptyProfile: 'Профилей пока нетДобавьте подключение — оно появится в каталоге проектов.'
      + '+ Добавить профиль',
    emptyResult: '{ }Результатов пока нетОткройте сессию из профиля слева.',
  });
});

test('сессии БД работают вкладками, а результат показан таблицей', async (t) => {
  const schemas = [];
  const access = [];
  const closed = [];
  let releaseFirstSchema;
  const store = {
    profiles: [],
    projects: [],
    sessions: [
      {
        id: 'session-a', profileId: 'profile-a', projectId: 'grigdesk',
        label: 'Аналитика', engine: 'clickhouse', role: 'read', agentAllowed: false,
      },
      {
        id: 'session-b', profileId: 'profile-b', projectId: 'shop',
        label: 'Заказы', engine: 'mysql', role: 'write', agentAllowed: true,
      },
    ],
    sshSessions: [],
    engines: [
      { id: 'clickhouse', label: 'ClickHouse' },
      { id: 'mysql', label: 'MySQL' },
    ],
    queries: [
      {
        id: 'query-done', text: 'SELECT id, state FROM orders', actor: 'human',
        sessionId: 'session-a', state: 'done', result: {
          rows: [{ id: 7, state: 'paid' }],
          shownRows: 1,
          totalRows: 1,
          untrusted: true,
        },
      },
      {
        id: 'query-old', text: 'SELECT secret FROM archive', actor: 'human',
        sessionId: 'session-closed', state: 'done', result: { rows: [{ secret: 'old' }] },
      },
    ],
    audit: [],
    schemas: {},
    async load() {},
    async loadProjects() {},
    async loadSchema(id) {
      schemas.push(id);
      if (id === 'session-a') {
        await new Promise((resolve) => { releaseFirstSchema = resolve; });
      }
    },
    async setAgentAccess(id, allowed) { access.push([id, allowed]); },
    async closeSession(id) { closed.push(id); },
  };
  const { wrapper, flushPromises } = await mountPanel(t, store);
  const tabs = wrapper.findAll('.db-tabs [role="tab"]');

  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].attributes('aria-selected'), 'true');
  const closedResult = wrapper.findAll('button')
    .find((button) => button.text() === 'Сессия закрыта');
  assert.equal(closedResult.attributes('disabled'), '');
  await wrapper.get('.db-query-row__actions button').trigger('click');
  await flushPromises();
  assert.equal(wrapper.get('.db-panel').attributes('data-pane'), 'result');
  assert.deepEqual(
    wrapper.findAll('.db-result-table th').map((cell) => cell.text()),
    ['id', 'state'],
  );
  assert.match(wrapper.find('.db-result-table').text(), /7paid/u);

  await tabs[1].trigger('click');
  await flushPromises();
  assert.equal(tabs[1].attributes('aria-selected'), 'true');
  assert.deepEqual(schemas, ['session-a', 'session-b']);
  assert.equal(wrapper.find('.db-result-table').exists(), false);
  releaseFirstSchema();
  await flushPromises();

  await wrapper.find('.db-agent-access input[role="switch"]').setValue(false);
  await wrapper.get('[aria-label^="Закрыть активную сессию"]').trigger('click');
  await flushPromises();

  assert.deepEqual(access, [['session-b', false]]);
  assert.deepEqual(closed, ['session-b']);
  assert.match(wrapper.text(), /Недоверенные данные/u);
  assert.match(wrapper.text(), /Показано 1 из 1/u);
});

test('форма нового профиля сохраняет описание без пароля', async (t) => {
  const saved = [];
  const { wrapper, flushPromises } = await mountPanel(t, {
    profiles: [],
    projects: [{ id: 'grigdesk' }],
    sessions: [],
    sshSessions: [],
    engines: [{ id: 'mysql', label: 'MySQL' }],
    queries: [],
    audit: [],
    schemas: {},
    async load() {},
    async loadProjects() {},
    async saveProfile(profile) {
      saved.push(profile);
      return { ...profile, id: 'profile-new' };
    },
  });

  await wrapper.get('[data-db-project-select]').setValue('grigdesk');
  await wrapper.get('[aria-label="Метка профиля"]').setValue('Заказы');
  await wrapper.get('[aria-label="Адрес базы"]').setValue('db.internal');
  await wrapper.get('[aria-label="Порт базы"]').setValue('3306');
  await wrapper.get('[aria-label="Пользователь базы"]').setValue('reader');
  await wrapper.get('.db-profile-form').trigger('submit');
  await flushPromises();

  assert.deepEqual(saved, [{
    projectId: 'grigdesk',
    label: 'Заказы',
    engine: 'mysql',
    role: 'read',
    host: 'db.internal',
    port: 3306,
    user: 'reader',
    database: '',
    via: 'direct',
    prod: false,
  }]);
  assert.equal(Object.hasOwn(saved[0], 'password'), false);
});

test('архивный проект не предлагается новому профилю базы', async (t) => {
  const { wrapper } = await mountPanel(t, {
    profiles: [],
    sessions: [],
    sshSessions: [],
    engines: [],
    queries: [],
    audit: [],
    schemas: {},
    projects: [
      { id: 'grigdesk', archivedAt: null },
      { id: 'kopeika', archivedAt: '2026-09-22T10:00:00.000Z' },
    ],
    load: async () => {},
  });

  const options = wrapper.findAll('[data-db-project-select] option')
    .map((option) => option.attributes('value'))
    .filter(Boolean);

  // Новый профиль базы заводят только на активный проект: архивным уже не работают.
  assert.deepEqual(options, ['grigdesk']);
});

test('PD-db-catalog: исчезнувший выбор нового профиля сбрасывается, сессии сохраняются', async (t) => {
  await installUiBrowser(t, 'http://grigdesk.test/#/db');

  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const saved = [];
  const store = reactive({

    profiles: [],
    projects: [{ id: 'demo' }, { id: 'other' }],
    sessions: [],
    sshSessions: [],

    engines: [{ id: 'mysql', label: 'MySQL' }],
    queries: [],
    audit: [],
    schemas: {},

    load: async () => { },
    loadProjects: async () => { },

    saveProfile: async (profile) => {
      saved.push(profile);
    },

  });
  const { wrapper, flushPromises } = await mountPanel(t, store);

  await wrapper.get('[data-db-project-select]').setValue('demo');
  await wrapper.get('[aria-label="Метка профиля"]').setValue('Заказы');
  await wrapper.get('[aria-label="Адрес базы"]').setValue('fixture.invalid');
  await wrapper.get('[aria-label="Пользователь базы"]').setValue('reader');
  store.projects = [{ id: 'other' }];
  await flushPromises();
  await wrapper.get('.db-profile-form').trigger('submit');
  await flushPromises();
  assert.equal(wrapper.get('[data-db-project-select]').element.value, '');
  assert.equal(saved.length, 0, 'старый projectId не уходит в новый профиль');
  assert.equal(wrapper.get('[aria-label="Метка профиля"]').element.value, 'Заказы');
  store.projects = [{ id: 'demo' }, { id: 'other' }];
  await flushPromises();
  assert.equal(wrapper.get('[data-db-project-select]').element.value, '',
    'поздний каталог не восстанавливает прежний выбор');
});

/**
 * Используем реактивный снимок, чтобы поиск, удаление профиля и открытые сессии
 * проходили через те же watchers, что и обновления реестра в приложении.
 */
async function catalogStore() {
  const { reactive } = await import('../../web/node_modules/vue/index.mjs');

  return reactive({
    profiles: [
      {
        id: 'primary',
        projectId: 'shop',
        label: 'Заказы',
        engine: 'mysql',
        role: 'read',
        host: 'orders.internal',
        port: 3306,
        user: 'reader',
        database: 'orders',
        via: 'direct',
      },
      {
        id: 'analytics',
        projectId: 'reports',
        label: 'Аналитика',
        engine: 'postgres',
        role: 'write',
        host: 'reports.internal',
        port: 5432,
        user: 'analyst',
        database: 'metrics',
        via: 'direct',
      },
    ],
    projects: [{ id: 'shop' }, { id: 'reports' }],
    engines: [{ id: 'mysql', label: 'MySQL' }, { id: 'postgres', label: 'PostgreSQL' }],
    sessions: [],
    sshSessions: [],
    queries: [],
    audit: [],
    schemas: {},
    async load() {},
    async loadProjects() {},
  });
}

test('консоль показывает причину SQL-ошибки вместо сырого JSON', async (t) => {
  const store = await catalogStore();

  store.sessions = [{
    id: 'session-a',
    profileId: 'primary',
    projectId: 'shop',
    label: 'Заказы',
    engine: 'mysql',
    role: 'read',
    agentAllowed: false,
  }];
  store.queries = [{
    id: 'query-error',
    sessionId: 'session-a',
    text: 'SELEC 1',
    actor: 'human',
    state: 'error',
    result: {
      ok: false,
      error: 'ER_PARSE_ERROR',
      message: 'Syntax error near SELECT',
    },
  }];

  const { wrapper, flushPromises } = await mountPanel(t, store);

  await wrapper.get('.db-query-row__actions button').trigger('click');
  await flushPromises();
  assert.match(wrapper.get('[data-db-query-error]').text(), /Syntax error near SELECT/u);
  assert.match(wrapper.get('[data-db-query-error]').text(), /ER_PARSE_ERROR/u);
  assert.equal(wrapper.find('.db-result__raw').exists(), false);
});

test('предупреждение аудита не скрывает профили и не выдаёт журнал за пустой', async (t) => {
  const store = await catalogStore();

  store.auditError = 'Журнал недоступен';
  store.auditSkippedRecords = 2;

  const { wrapper } = await mountPanel(t, store);

  assert.equal(wrapper.findAll('[data-db-profile-card]').length, 2);
  assert.match(wrapper.get('[data-db-audit-error]').text(), /Журнал недоступен/u);
  assert.match(wrapper.get('[data-db-audit-warning]').text(), /Повреждённых записей в журнале: 2/u);
  assert.equal(wrapper.find('.db-audit__empty').exists(), false);
});

test('поиск профилей сохраняет выбранный вход, а смена профиля очищает пароль', async (t) => {
  const store = await catalogStore();
  const { wrapper, flushPromises } = await mountPanel(t, store);

  await wrapper.get('input[type="password"]').setValue('one-use');
  await wrapper.get('input[type="search"]').setValue('metrics');
  await flushPromises();

  assert.deepEqual(wrapper.findAll('[data-profile-id]').map((row) => row.attributes('data-profile-id')),
    ['analytics']);
  assert.match(wrapper.get('.db-selected').text(), /Заказы/);
  assert.equal(wrapper.get('input[type="password"]').element.value, 'one-use');

  await wrapper.get('input[type="search"]').setValue('missing');
  assert.match(wrapper.get('.db-catalog-empty').text(), /Подходящих профилей нет/);
  await wrapper.get('.db-catalog-empty button').trigger('click');
  assert.equal(wrapper.findAll('[data-profile-id]').length, 2);

  await wrapper.get('[data-profile-id="analytics"]').trigger('click');
  assert.equal(wrapper.get('input[type="password"]').element.value, '');
  assert.match(wrapper.get('.db-selected').text(), /Аналитика/);

  store.profiles = store.profiles.filter((profile) => profile.id === 'primary');
  await flushPromises();
  assert.match(wrapper.get('.db-selected').text(), /Заказы/);
});

test('выбор подключённого профиля возвращает сессию, новый вход получает фокус', async (t) => {
  const store = await catalogStore();

  store.sessions.push({
    id: 'live',
    profileId: 'primary',
    label: 'Заказы',
    projectId: 'shop',
    engine: 'mysql',
    role: 'read',
    agentAllowed: false,
  });

  const { wrapper, flushPromises } = await mountPanel(t, store);

  assert.equal(wrapper.find('.db-connect-form').exists(), false);
  await wrapper.get('[data-profile-id="primary"]').trigger('click');
  assert.equal(wrapper.get('.db-panel').attributes('data-pane'), 'query');
  assert.equal(wrapper.get('.db-tabs [role="tab"]').attributes('aria-selected'), 'true');
  await wrapper.get('[aria-controls="db-login"]').trigger('click');
  await flushPromises();

  assert.equal(document.activeElement === wrapper.get('input[type="password"]').element, true);
  await wrapper.get('input[type="password"]').setValue('temporary');
  await wrapper.get('[aria-controls="db-login"]').trigger('click');
  await wrapper.get('[aria-controls="db-login"]').trigger('click');
  assert.equal(wrapper.get('input[type="password"]').element.value, '');
});

test('скрытие формы сохраняет черновик профиля и SQL, активная лента раскрывается', async (t) => {
  const store = await catalogStore();

  store.sessions.push({
    id: 'live',
    profileId: 'primary',
    label: 'Заказы',
    projectId: 'shop',
    engine: 'mysql',
    role: 'read',
    agentAllowed: false,
  });

  const { wrapper, flushPromises } = await mountPanel(t, store);

  await wrapper.get('[data-role="db-query"]').setValue('SELECT 42');
  await wrapper.get('[aria-controls="db-create"]').trigger('click');
  await wrapper.get('[aria-label="Метка профиля"]').setValue('Черновик');
  assert.equal(wrapper.get('.db-panel').attributes('data-pane'), 'create');
  await wrapper.get('[aria-controls="db-create"]').trigger('click');
  await wrapper.get('[aria-controls="db-create"]').trigger('click');

  assert.equal(wrapper.get('[aria-label="Метка профиля"]').element.value, 'Черновик');
  assert.equal(wrapper.get('[data-role="db-query"]').element.value, 'SELECT 42');
  assert.equal(wrapper.get('[data-db-queries]').attributes('open'), undefined);

  store.queries.push({
    id: 'running',
    sessionId: 'live',
    state: 'running',
    text: 'SELECT 42',
  });
  await flushPromises();
  assert.equal(wrapper.get('[data-db-queries]').attributes('open'), '');
});


/**
 * Для новых сценариев все данные синтетические; metadata не создаёт второй engines state.
 * Mount сохраняет настоящий UiSelect и общий driver dialog.
 */
function driverPanelStore(overrides = {}) {
  return {
    profiles: [],
    projects: [{ id: 'fixture' }],
    sessions: [],
    sshSessions: [],
    engines: [
      {
        id: 'mysql',
        label: 'MySQL',
        capabilities: {}
      },
      {
        id: 'fixture-db',
        label: 'Внешняя СУБД',
        capabilities: {}
      },
    ],
    engineErrors: [],
    engineInstalls: {},
    installHealth: null,
    queries: [],
    audit: [],
    schemas: {},
    load: async () => { },
    loadProjects: async () => { },
    ...overrides,
  };
}

test('DUI-01: явная установка открывает driver wizard и сохраняет один селект движков', async (t) => {
  const { wrapper, flushPromises } = await mountPanel(t, driverPanelStore(), {
    compact: true, presentation: 'dock',
  });

  const install = wrapper.findAll('button')
    .find((button) => /Установить драйвер из Git/u.test(button.text()));

  assert.ok(install, 'в Базах нужна явная кнопка установки драйвера');

  await install.trigger('click');

  await flushPromises();

  assert.match(wrapper.text(), /драйвер/iu);

  const dialog = wrapper.findComponent({ name: 'PluginInstallDialog' });

  assert.equal(dialog.exists(), true);

  assert.equal(dialog.props('packageKind'), 'db-engine');

  await dialog.vm.$emit('update:open', false);

  await flushPromises();

  const add = wrapper.findAll('button').find((button) => button.text().includes('Добавить профиль'));

  await add.trigger('click');

  await flushPromises();

  const selects = wrapper.findAll('select[aria-label="Движок базы"]');

  assert.equal(selects.length, 1);

  assert.deepEqual(selects[0].findAll('option').map((option) => option.attributes('value')),
    ['', 'mysql', 'fixture-db']);

  assert.equal(wrapper.findAll('table').length, 0);
});

test('DUI-02: warning внешнего драйвера виден рядом с прежними профилями', async (t) => {
  const { wrapper } = await mountPanel(t, driverPanelStore({
    profiles: [{
      id: 'profile-a',
      projectId: 'fixture',
      label: 'Прежний профиль',
      engine: 'mysql',
      role: 'read',
      via: 'direct'
    }],
    engineErrors: [{
      id: 'broken',
      code: 'manifest_invalid',
      message: 'Ошибка внешнего драйвера'
    }],
  }));

  assert.match(wrapper.text(), /Ошибка внешнего драйвера/u);

  assert.match(wrapper.text(), /Прежний профиль/u);

  assert.equal(wrapper.findAll('[data-db-profile-card]').length, 1);
});
