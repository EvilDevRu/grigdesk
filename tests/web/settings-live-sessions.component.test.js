// Карточка «Настройки → Запуски → Живые процессы агентов».
//
// Смысл проверки: живой процесс — единственное место, где «прибраться» может стоить
// человеку работы агента. Свободную сессию гасим одним кликом (терять нечего: разговор
// остаётся, следующий ход поднимет процесс заново), а идущий ход — только после явного
// подтверждения и только с `force`, иначе сервер справедливо ответит `409 chat_busy`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileSettingsView } from './helpers/settings-view.js';

process.env.NODE_ENV = 'test';

async function installBrowser(t, storage = {}) {
  globalThis.__GRIGDESK_VERSION__ = '0.0.0-test';
  globalThis.__GRIGDESK_SHA__ = 'testsha';
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://grigdesk.test/#/settings' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  for (const [key, value] of Object.entries(storage)) browser.localStorage.setItem(key, value);
  browser.document.body.innerHTML = '<div id="mount"></div>';
  t.after(() => browser.close());
  return browser;
}

const NOW = Date.now();

function sessionsPayload() {
  return {
    enabled: true,
    maxSessions: 4,
    idleMs: 30 * 60 * 1000,
    sessions: [
      {
        chatKey: 'free-chat',
        chatTitle: 'Разбор гоч',
        taskId: null,
        executor: 'claude',
        model: 'claude-opus-5',
        effort: 'high',
        permissionMode: 'plan',
        cwd: '/home/user/grigdesk',
        pid: 4242,
        running: false,
        unsolicited: true,
        openedAt: NOW - 12 * 60 * 1000,
        lastUsed: NOW - 4 * 60 * 1000,
        idleAtMs: NOW + 26 * 60 * 1000,
      },
      {
        chatKey: 'busy-chat',
        chatTitle: 'Сборка фронта',
        taskId: '4242',
        executor: 'claude',
        model: 'claude-opus-5',
        effort: '',
        permissionMode: 'default',
        cwd: '/home/user/grigdesk',
        pid: 4243,
        running: true,
        unsolicited: true,
        openedAt: NOW - 3 * 60 * 1000,
        lastUsed: NOW - 60 * 1000,
        idleAtMs: null,
      },
    ],
  };
}

async function mountRuns(t, { confirmAnswer = true } = {}) {
  const browser = await installBrowser(t, { 'grigdesk-settings-tab': 'runs' });
  const deleted = [];
  const confirms = [];

  globalThis.__settingsApi = {
    /**
     * Список сессий и prefs приходят из одного управляемого транспорта.
     * Тест видит только заданный снимок и не читает работающий сервер.
     */
    async get(path) {
      if (path === '/api/chat/sessions') return sessionsPayload();
      if (path === '/api/settings/prefs') {
        return { chatLiveSessions: true, providerSettings: {} };
      }
      return {};
    },
    async post() { return {}; },
    async del(path) {
      deleted.push(path);
      return { ok: true, closed: 1, skipped: 0, forced: path.includes('force=1') };
    },
  };
  globalThis.__settingsConfirm = async (text) => {
    confirms.push(text);
    return confirmAnswer;
  };
  globalThis.__settingsStores = {
    useProvidersStore: () => ({
      providers: [{
        id: 'claude',
        name: 'Claude',
        available: true,
        models: [{ id: 'claude-opus-5', name: 'Opus 5' }],
        modes: [{ id: 'plan', label: 'План' }, { id: 'default', label: 'Спрашивать' }],
      }],
      usage: {},
      mcp: {},
      loaded: true,
      showAllModels: false,
      visibleModels: () => [],
      modelOf: () => ({ id: '', model: null, provider: null }),
      async load() {},
      async loadUsage() {},
      async saveSetting() { return { ok: true }; },
      async loadMcp() { return { state: 'ok', servers: [] }; },
      async runUsageAction() { return { ok: true }; },
    }),
    useAuthStore: () => ({ login: 'me', async logoutAll() {} }),
    usePluginsStore: () => ({
      loaded: true,
      list: [],
      enabled: () => true,
      byId: () => null,
      async load() {},
      async toggle() {},
      async saveSettings() {},
    }),
    useChatStore: () => ({ compactWindow: 0, setActive() {} }),
    useDeviceStore: () => ({ canInstall: false, wakeLock: false, async install() {} }),
    useGrigDeskUpdateStore: () => ({ state: null, async load() {} }),
  };

  const [{ mount, flushPromises }, SettingsView] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileSettingsView({ confirm: true }),
  ]);
  const wrapper = mount(SettingsView, {
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__settingsApi;
    delete globalThis.__settingsStores;
    delete globalThis.__settingsConfirm;
  });
  for (let i = 0; i < 6; i += 1) await flushPromises();
  return { wrapper, deleted, confirms, flushPromises };
}

function closeButton(row) {
  return row.findAll('button').find((btn) => btn.text() === 'Погасить');
}

test('вкладка разделяет правила, процессы и наблюдение по смысловым зонам', async (t) => {
  const { wrapper } = await mountRuns(t);
  const rules = wrapper.get('[data-testid="runs-rules-grid"]');
  const live = wrapper.get('[data-testid="runs-live-card"]');

  assert.equal(rules.findAll('.run-card').length, 2);
  assert.match(rules.text(), /Старт и восстановление/);
  assert.match(rules.text(), /Контекст агентов/);
  assert.match(live.text(), /Держать агента чата живым между ходами/);
  assert.equal(live.findAll('.live-row').length, 2);
  assert.equal(wrapper.findAll('.run-observe-item').length, 2);
});

test('строка процесса называет чат, исполнителя и pid, а занятость видна', async (t) => {
  const { wrapper } = await mountRuns(t);
  const rows = wrapper.findAll('.live-row');
  assert.equal(rows.length, 2, 'карточка обязана показывать все живые процессы');

  const free = rows[0].text();
  assert.match(free, /Разбор гоч/);
  // Подписи исполнителя и режима берутся из живого реестра, а не из своей копии.
  assert.match(free, /Claude · claude-opus-5 · усилие high · План/);
  assert.match(free, /pid 4242/, 'pid нужен, чтобы сверить процесс с ps');
  assert.match(free, /погаснет через 26 мин/);

  const busy = rows[1];
  assert.match(busy.text(), /Сборка фронта · задача 4242/);
  assert.match(busy.text(), /идёт ход/);
  assert.equal(busy.find('.live-dot').classes().includes('busy'), true);
});

test('свободный процесс гасится сразу, идущий ход — только с подтверждением', async (t) => {
  const { wrapper, deleted, confirms, flushPromises } = await mountRuns(t);
  const rows = wrapper.findAll('.live-row');

  await closeButton(rows[0]).trigger('click');
  await flushPromises();
  assert.deepEqual(confirms, [], 'у свободной сессии терять нечего — лишний вопрос только мешает');
  assert.deepEqual(deleted, ['/api/chat/sessions/free-chat'], 'без force: ход не идёт');

  await closeButton(rows[1]).trigger('click');
  await flushPromises();
  assert.equal(confirms.length, 1, 'работа агента не теряется без явного согласия');
  assert.match(confirms[0], /идёт ход/);
  assert.equal(deleted[1], '/api/chat/sessions/busy-chat?force=1');
});

test('отказ от подтверждения не гасит процесс', async (t) => {
  const { wrapper, deleted, confirms, flushPromises } = await mountRuns(t, { confirmAnswer: false });
  const rows = wrapper.findAll('.live-row');

  await closeButton(rows[1]).trigger('click');
  await flushPromises();
  assert.equal(confirms.length, 1);
  assert.deepEqual(deleted, [], 'нажали «отмена» — запрос уходить не должен');
});
