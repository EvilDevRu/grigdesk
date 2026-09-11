// Сводка «Настройки → Доступ». Здесь важно не просто наличие карточек, а честная
// семантика контролов: LAN остаётся доступен без локального TLS, а VPS-шлюз нельзя
// изображать выключателем, пока у сервера нет операции остановки туннелей.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { compileSettingsView as compileSettingsViewFixture } from './helpers/settings-view.js';

process.env.NODE_ENV = 'test';

const VIEW_PATH = webFile('src/views/settings/AccessOverview.vue');

async function compileAccessOverview() {
  return compileVue(VIEW_PATH);
}

async function compileSettingsView() {
  return compileSettingsViewFixture({
    prefix: '__accessSettings',
    accessOverview: true,
    confirm: true,
  });
}

async function installBrowser(t) {
  // Vite объявляет эти константы через define; node-компиляции нужен тот же контракт.
  globalThis.__COCKPIT_VERSION__ = '0.0.0-test';
  globalThis.__COCKPIT_SHA__ = 'testsha';
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'https://cockpit.test/' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    Node: browser.Node,
    Document: browser.Document,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    ShadowRoot: browser.ShadowRoot,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  browser.document.body.innerHTML = '<div id="mount"></div>';
  t.after(() => browser.close());
  return browser;
}

function tls(overrides = {}) {
  return {
    enabled: false,
    source: 'none',
    httpPort: 8140,
    https: { up: false, port: 8143, error: '' },
    leaf: { exists: false },
    ca: { exists: false },
    addresses: [{ address: '192.168.1.20', iface: 'eth0' }],
    missingAddresses: [],
    needsRestart: false,
    ...overrides,
  };
}

async function mountOverview(t, props = {}) {
  const browser = await installBrowser(t);
  const [{ mount }, AccessOverview] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileAccessOverview(),
  ]);
  const wrapper = mount(AccessOverview, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      localHttpsEnabled: false,
      tls: tls(),
      gatewaySetup: null,
      gatewayJob: null,
      gatewayPublicDomain: '',
      gatewayChecks: null,
      activeDetails: '',
      ...props,
    },
  });
  t.after(() => wrapper.unmount());
  return wrapper;
}

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function mountSettingsAccess(t, {
  prefs: initialPrefs = {
    accessLocalHttps: true,
    accessGateway: false,
    trustedDirectories: [],
  },
  tlsStates = [tls({
    enabled: true,
    source: 'state',
    https: { up: true, port: 8143, error: '' },
    leaf: { exists: false, addresses: [] },
  })],
  gateway = {
    setup: {
      domain: 'cockpit.example.com', gateway: '203.0.113.10', sshPort: 22, sshUser: 'root',
    },
    job: null,
    publicDomain: 'cockpit.example.com',
  },
  confirmAnswers = [],
  prefsPost = null,
  gatewayVerify = { ok: true, checks: [] },
  tab = 'access',
} = {}) {
  const browser = await installBrowser(t);
  browser.localStorage.setItem('cockpit-settings-tab', tab);

  let currentPrefs = copy(initialPrefs);
  let tlsReads = 0;
  const gets = [];
  const posts = [];
  const confirmations = [];
  globalThis.__accessSettingsApi = {
    async get(path) {
      gets.push(path);
      if (path === '/api/settings/prefs') return copy(currentPrefs);
      if (path === '/api/settings/tls') {
        const index = Math.min(tlsReads, Math.max(0, tlsStates.length - 1));
        tlsReads += 1;
        return copy(tlsStates[index]);
      }
      if (path === '/api/gateway/setup') return copy(gateway);
      return {};
    },
    async post(path, body) {
      posts.push({ path, body: copy(body) });
      if (path === '/api/gateway/setup/verify') return copy(gatewayVerify);
      if (path !== '/api/settings/prefs') return {};
      if (prefsPost) {
        const result = await prefsPost(copy(body), copy(currentPrefs));
        currentPrefs = copy(result);
        return copy(result);
      }
      currentPrefs = { ...currentPrefs, ...copy(body) };
      return copy(currentPrefs);
    },
    async del() { return {}; },
  };
  globalThis.__accessSettingsConfirm = async (message, options) => {
    confirmations.push({ message, options: copy(options) });
    return confirmAnswers.length ? confirmAnswers.shift() : true;
  };

  const providersStore = {
    providers: [], usage: {}, mcp: {}, loaded: true, showAllModels: false,
    visibleModels: () => [],
    async load() {}, async loadUsage() {}, async saveSetting() {},
    async loadMcp() {}, async runUsageAction() {},
  };
  globalThis.__accessSettingsStores = {
    useProvidersStore: () => providersStore,
    useUiContextStore: () => ({ set() {}, clear() {} }),
    useAuthStore: () => ({
      login: 'me', secure: true, isLocal: true, authenticated: true, async load() {},
    }),
    usePluginsStore: () => ({
      loaded: true, list: [], enabled: () => true, async load() {}, async setEnabled() {},
    }),
    useChatStore: () => ({ compactWindow: 0 }),
    usePwaStore: () => ({
      canInstall: false, wakeLock: false, async install() {}, async checkForUpdate() {},
    }),
    useCockpitUpdateStore: () => ({ state: null, status: null, async load() {} }),
  };

  const [{ mount, flushPromises }, AccessOverview] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileAccessOverview(),
  ]);
  globalThis.__accessSettingsOverview = AccessOverview;
  const SettingsView = await compileSettingsView();
  const wrapper = mount(SettingsView, {
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  });
  for (let i = 0; i < 5; i += 1) await flushPromises();
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__accessSettingsApi;
    delete globalThis.__accessSettingsConfirm;
    delete globalThis.__accessSettingsOverview;
    delete globalThis.__accessSettingsStores;
  });
  return {
    wrapper,
    gets,
    posts,
    confirmations,
    tlsReadCount: () => tlsReads,
    flushPromises,
  };
}

test('ACCESS-WEB-01: три пути видны одновременно и названы как независимые', async (t) => {
  const wrapper = await mountOverview(t, {
    gatewaySetup: { domain: 'cockpit.example.com' },
    gatewayPublicDomain: 'cockpit.example.com',
  });

  assert.equal(wrapper.findAll('.access-route-card').length, 3);
  assert.match(wrapper.get('[data-testid="access-route-computer"]').text(), /На самом мозге/);
  assert.match(wrapper.get('[data-testid="access-route-home"]').text(), /В домашней сети/);
  assert.match(wrapper.get('[data-testid="access-route-internet"]').text(), /Из интернета/);
  assert.match(wrapper.text(), /Изменение одной не переключает и не отключает остальные/);

  const home = wrapper.get('[data-testid="access-route-home"]');
  assert.match(home.text(), /HTTP без шифрования/);
  assert.match(home.text(), /http:\/\/192\.168\.1\.20:8140/);
  assert.match(home.text(), /Доступ дома остаётся по HTTP/);

  const internet = wrapper.get('[data-testid="access-route-internet"]');
  assert.match(internet.text(), /Не проверен/);
  assert.match(internet.text(), /https:\/\/cockpit\.example\.com/);
  assert.match(internet.text(), /Скрытие панели шлюз не останавливает/i);
});

test('ACCESS-WEB-02: у шлюза нет ложного switch, кнопка управляет только подробностями', async (t) => {
  const wrapper = await mountOverview(t, {
    localHttpsEnabled: true,
    tls: tls({
      enabled: true,
      source: 'state',
      https: { up: true, port: 8143, error: '' },
      leaf: { exists: true, addresses: ['192.168.1.20'] },
    }),
    gatewaySetup: { domain: 'cockpit.example.com' },
    gatewayPublicDomain: 'cockpit.example.com',
  });

  assert.equal(wrapper.findAll('[role="switch"]').length, 1, 'switch должен остаться только у LAN HTTPS');
  const gatewayButton = wrapper.get('[data-testid="gateway-details-toggle"]');
  assert.equal(gatewayButton.attributes('role'), undefined);
  assert.equal(gatewayButton.attributes('aria-expanded'), 'false');
  assert.equal(gatewayButton.get('.ui-button__label').text(), 'Управление и проверка');

  await gatewayButton.trigger('click');
  assert.deepEqual(wrapper.emitted('toggle-details'), [['gateway']]);
  assert.equal(wrapper.emitted('set-local-https'), undefined, 'раскрытие шлюза не меняет режимы');

  await wrapper.setProps({ localMessage: { type: 'err', text: 'Не удалось сохранить HTTPS.' } });
  const inlineError = wrapper.get('[data-testid="access-route-home"] .access-inline-message');
  assert.equal(inlineError.text(), 'Не удалось сохранить HTTPS.');
  assert.ok(inlineError.classes().includes('err'), 'ошибка должна быть рядом с LAN, не у учётной записи');
});

test('ACCESS-WEB-03: локальный HTTPS различает факт, намерение и системный сертификат', async (t) => {
  const wrapper = await mountOverview(t, {
    localHttpsEnabled: false,
    tls: tls({
      enabled: true,
      source: 'state',
      https: { up: true, port: 8143, error: '' },
      leaf: { exists: true, addresses: ['192.168.1.20'] },
    }),
  });
  const home = () => wrapper.get('[data-testid="access-route-home"]');

  assert.match(home().text(), /Отключится после рестарта/);
  await wrapper.setProps({ localHttpsEnabled: true });
  assert.match(home().text(), /HTTPS работает/);

  await wrapper.setProps({
    localHttpsEnabled: false,
    tls: tls({
      source: 'env',
      https: { up: true, port: 8143, error: '' },
      leaf: { exists: false },
    }),
  });
  assert.match(home().text(), /HTTPS задан системой/);
  assert.match(home().text(), /Переключатель Cockpit его не отключает/);
});

test('ACCESS-WEB-04: статусы шлюза не зависят от старого prefs-флага', async (t) => {
  const wrapper = await mountOverview(t, {
    // Компонент намеренно не принимает accessGateway: сохранённая установка важнее
    // прежнего флага видимости мастера.
    gatewaySetup: { domain: 'cockpit.example.com' },
    gatewayPublicDomain: '',
  });
  const internet = () => wrapper.get('[data-testid="access-route-internet"]');

  assert.match(internet().text(), /Нужен перезапуск/);
  await wrapper.setProps({
    gatewayPublicDomain: 'cockpit.example.com',
    gatewayChecks: { ok: true, domain: 'cockpit.example.com' },
  });
  assert.match(internet().text(), /Связь проверена/);
  await wrapper.setProps({ gatewayJob: { state: 'failed', domain: 'cockpit.example.com' } });
  assert.match(internet().text(), /Настройка сорвалась/);
  await wrapper.setProps({
    gatewaySetup: null,
    gatewayJob: null,
    gatewayChecks: null,
    gatewayPublicDomain: '',
  });
  assert.match(internet().text(), /Не настроен/);
});

test('ACCESS-WEB-05: раскрыта может быть только одна панель подробностей', async (t) => {
  const wrapper = await mountOverview(t, {
    localHttpsEnabled: true,
    activeDetails: 'local',
  });
  assert.equal(wrapper.get('[data-testid="local-details-toggle"]').attributes('aria-expanded'), 'true');
  assert.equal(wrapper.get('[data-testid="gateway-details-toggle"]').attributes('aria-expanded'), 'false');

  await wrapper.setProps({ activeDetails: 'gateway' });
  assert.equal(wrapper.get('[data-testid="local-details-toggle"]').attributes('aria-expanded'), 'false');
  assert.equal(wrapper.get('[data-testid="gateway-details-toggle"]').attributes('aria-expanded'), 'true');
  assert.equal(
    wrapper.get('[data-testid="gateway-details-toggle"] .ui-button__label').text(),
    'Скрыть настройки',
  );

  await wrapper.get('[data-testid="access-route-home"] [role="switch"]').trigger('click');
  assert.deepEqual(wrapper.emitted('set-local-https'), [[false]]);
});

test('ACCESS-WEB-06: системный TLS показан фактом, а не доступным switch', async (t) => {
  const wrapper = await mountOverview(t, {
    localHttpsEnabled: false,
    tls: tls({
      source: 'env',
      https: { up: true, port: 9443, error: '' },
      leaf: { exists: false },
    }),
  });

  const home = wrapper.get('[data-testid="access-route-home"]');
  const httpsSwitch = home.get('[role="switch"]');
  assert.equal(httpsSwitch.attributes('aria-checked'), 'true', 'показываем фактически поднятый TLS');
  assert.equal(httpsSwitch.attributes('disabled'), '', 'env-настройку нельзя обещать изменить из UI');
  assert.match(home.text(), /управляется системой/);
  assert.equal(home.get('.access-route-url').text(), 'HTTPS · адрес задаётся системой');
  assert.doesNotMatch(home.get('.access-route-url').text(), /192\.168/);
  assert.equal(home.find('[data-testid="local-details-toggle"]').exists(), false);

  await httpsSwitch.trigger('click');
  assert.equal(wrapper.emitted('set-local-https'), undefined);
});

test('ACCESS-WEB-07: до рестарта различимы активный и подготовленный домены шлюза', async (t) => {
  const wrapper = await mountOverview(t, {
    gatewaySetup: { domain: 'new.example.com' },
    gatewayJob: { state: 'done', domain: 'new.example.com', needsRestart: true },
    gatewayPublicDomain: 'old.example.com',
  });
  const internet = () => wrapper.get('[data-testid="access-route-internet"]');

  assert.match(internet().text(), /Нужен перезапуск/);
  assert.equal(internet().get('.access-route-url').text(), 'https://old.example.com');
  assert.match(internet().text(), /Новый домен new\.example\.com включится после перезапуска/);
  assert.match(internet().text(), /Сейчас активен old\.example\.com/);

  await wrapper.setProps({
    gatewayJob: null,
    gatewayPublicDomain: 'new.example.com',
  });
  assert.match(internet().text(), /Не проверен/);
  assert.equal(internet().get('.access-route-url').text(), 'https://new.example.com');
  assert.doesNotMatch(internet().text(), /Новый домен|Сейчас активен/);
});

test('ACCESS-WEB-08: карточка LAN не выдаёт старый адрес и сертификат за рабочие', async (t) => {
  const wrapper = await mountOverview(t, {
    localHttpsEnabled: true,
    tls: tls({
      enabled: true,
      source: 'state',
      https: { up: true, port: 8143, error: '' },
      leaf: { exists: true, addresses: ['192.168.1.20'] },
      addresses: [{ address: '192.168.2.30', iface: 'wlan0' }],
      missingAddresses: ['192.168.2.30'],
    }),
  });
  const home = () => wrapper.get('[data-testid="access-route-home"]');

  assert.equal(home().get('.access-route-url').text(), 'https://192.168.2.30:8143');
  assert.match(home().text(), /Адрес не в сертификате/);
  assert.doesNotMatch(home().text(), /HTTPS работает/);

  await wrapper.setProps({
    tls: tls({
      enabled: true,
      source: 'state',
      https: { up: true, port: 8143, error: '' },
      leaf: { exists: true, addresses: ['192.168.2.30'] },
      addresses: [{ address: '192.168.2.30', iface: 'wlan0' }],
      needsRestart: true,
    }),
  });
  assert.match(home().text(), /Нужен перезапуск/);
  assert.doesNotMatch(home().text(), /HTTPS работает/);

  await wrapper.setProps({
    localHttpsEnabled: false,
    tls: tls({
      source: 'env',
      https: { up: false, port: 8143, error: 'EADDRINUSE' },
    }),
  });
  assert.match(home().text(), /Системный HTTPS не поднялся/);
  assert.match(home().text(), /Исправить его можно только в конфигурации сервера/);
  assert.equal(home().get('[role="switch"]').attributes('disabled'), '');
});

test('ACCESS-WEB-09: шлюз различает загрузку, цель проверки и результат verify-шага', async (t) => {
  const wrapper = await mountOverview(t, { gatewayState: 'loading' });
  const internet = () => wrapper.get('[data-testid="access-route-internet"]');
  const action = () => internet().get('[data-testid="gateway-details-toggle"]');

  assert.match(internet().text(), /Проверяем/);
  assert.equal(action().attributes('disabled'), '');

  await wrapper.setProps({ gatewayState: 'error', gatewayError: 'нет ответа' });
  assert.match(internet().text(), /Статус недоступен/);
  assert.match(internet().text(), /нет ответа/);
  assert.equal(action().attributes('disabled'), undefined);

  await wrapper.setProps({
    gatewayState: 'ready',
    gatewaySetup: { domain: 'cockpit.example.com' },
    gatewayPublicDomain: 'cockpit.example.com',
    gatewayChecks: { ok: true, domain: 'other.example.com' },
  });
  assert.match(internet().text(), /Не проверен/);
  await wrapper.setProps({ gatewayChecks: { ok: true, domain: 'cockpit.example.com' } });
  assert.match(internet().text(), /Связь проверена/);

  await wrapper.setProps({
    gatewayChecks: null,
    gatewayJob: {
      state: 'done',
      domain: 'cockpit.example.com',
      steps: [{ key: 'verify', state: 'fail' }],
    },
  });
  assert.match(internet().text(), /Есть замечания/);
  await wrapper.setProps({
    gatewayJob: {
      state: 'done',
      domain: 'cockpit.example.com',
      steps: [{ key: 'verify', state: 'ok' }],
    },
  });
  assert.match(internet().text(), /Связь проверена/);
});

test('ACCESS-WEB-10: отключение LAN HTTPS подтверждается и перечитывает TLS', async (t) => {
  const {
    wrapper, posts, confirmations, tlsReadCount, flushPromises,
  } = await mountSettingsAccess(t, { confirmAnswers: [false, true] });
  const httpsSwitch = () => wrapper.get('[data-testid="access-route-home"] [role="switch"]');

  assert.equal(httpsSwitch().attributes('aria-checked'), 'true');
  assert.equal(tlsReadCount(), 1, 'первый GET нужен для начальной сводки');

  await httpsSwitch().trigger('click');
  await flushPromises();
  assert.equal(posts.filter((call) => call.path === '/api/settings/prefs').length, 0);
  assert.equal(tlsReadCount(), 1, 'отмена не должна запускать лишнее перечитывание');
  assert.equal(httpsSwitch().attributes('aria-checked'), 'true');

  await httpsSwitch().trigger('click');
  await flushPromises();
  assert.equal(confirmations.length, 2);
  assert.match(confirmations[1].message, /Localhost и доступ через VPS-шлюз не изменятся/);
  assert.deepEqual(
    posts.filter((call) => call.path === '/api/settings/prefs'),
    [{ path: '/api/settings/prefs', body: { accessLocalHttps: false } }],
  );
  assert.equal(tlsReadCount(), 2, 'после сохранения UI обязан свериться с фактическим TLS');
  assert.equal(httpsSwitch().attributes('aria-checked'), 'false');
});

test('ACCESS-WEB-11: ошибка prefs остаётся рядом с LAN и не меняет состояние', async (t) => {
  const { wrapper, posts, tlsReadCount, flushPromises } = await mountSettingsAccess(t, {
    confirmAnswers: [true],
    prefsPost: async () => { throw new Error('prefs недоступны'); },
  });

  await wrapper.get('[data-testid="access-route-home"] [role="switch"]').trigger('click');
  await flushPromises();

  assert.deepEqual(
    posts.filter((call) => call.path === '/api/settings/prefs'),
    [{ path: '/api/settings/prefs', body: { accessLocalHttps: false } }],
  );
  assert.equal(tlsReadCount(), 1, 'при несохранённом prefs нечего перечитывать');
  assert.equal(
    wrapper.get('[data-testid="access-route-home"] [role="switch"]').attributes('aria-checked'),
    'true',
  );
  const message = wrapper.get('[data-testid="access-route-home"] .access-inline-message');
  assert.ok(message.classes().includes('err'));
  assert.equal(message.text(), 'prefs недоступны');
});

test('ACCESS-WEB-12: SettingsView действительно монтирует только одни подробности', async (t) => {
  const { wrapper, flushPromises } = await mountSettingsAccess(t);
  assert.equal(wrapper.find('#local-https-settings').exists(), false);
  assert.equal(wrapper.find('#gateway-settings').exists(), false);

  await wrapper.get('[data-testid="local-details-toggle"]').trigger('click');
  await flushPromises();
  assert.equal(wrapper.find('#local-https-settings').exists(), true);
  assert.equal(wrapper.find('#gateway-settings').exists(), false);

  await wrapper.get('[data-testid="gateway-details-toggle"]').trigger('click');
  await flushPromises();
  assert.equal(wrapper.find('#local-https-settings').exists(), false);
  assert.equal(wrapper.find('#gateway-settings').exists(), true);

  await wrapper.get('[data-testid="gateway-details-toggle"]').trigger('click');
  await flushPromises();
  assert.equal(wrapper.find('#local-https-settings').exists(), false);
  assert.equal(wrapper.find('#gateway-settings').exists(), false);
});

test('ACCESS-WEB-13: ручная проверка шлюза привязана к фактически проверенному домену', async (t) => {
  const { wrapper, posts, flushPromises } = await mountSettingsAccess(t);
  const internet = wrapper.get('[data-testid="access-route-internet"]');

  assert.match(internet.text(), /Не проверен/);
  await internet.get('[data-testid="gateway-details-toggle"]').trigger('click');
  await flushPromises();
  const verify = wrapper.findAll('button').find((button) => button.text() === 'Проверить связь');
  assert.ok(verify, 'кнопка проверки должна быть в раскрытой панели шлюза');
  await verify.trigger('click');
  await flushPromises();

  assert.deepEqual(
    posts.find((call) => call.path === '/api/gateway/setup/verify'),
    {
      path: '/api/gateway/setup/verify',
      body: {
        domain: 'cockpit.example.com',
        gateway: '203.0.113.10',
        sshPort: 22,
        sshUser: 'root',
      },
    },
  );
  assert.match(internet.text(), /Связь проверена/);
});

test('ACCESS-WEB-14: ошибка TLS — отдельное состояние с безопасным retry', async (t) => {
  const wrapper = await mountOverview(t, {
    localHttpsEnabled: true,
    tls: null,
    tlsState: 'error',
    tlsError: 'эндпоинт недоступен',
  });
  const home = wrapper.get('[data-testid="access-route-home"]');

  assert.match(home.text(), /Статус недоступен/);
  assert.match(home.text(), /эндпоинт недоступен/);
  assert.equal(home.get('[role="switch"]').attributes('disabled'), '');
  assert.equal(home.find('[data-testid="local-details-toggle"]').exists(), false);
  await home.get('[data-testid="tls-retry"]').trigger('click');
  assert.deepEqual(wrapper.emitted('reload-tls'), [[]]);
});

test('ACCESS-WEB-15: сохранённые сертификаты доступны при выключенном LAN HTTPS', async (t) => {
  const { wrapper, flushPromises } = await mountSettingsAccess(t, {
    prefs: { accessLocalHttps: false, accessGateway: false, trustedDirectories: [] },
    tlsStates: [tls({
      enabled: true,
      source: 'none',
      openssl: true,
      leaf: {
        exists: true,
        addresses: ['192.168.1.20'],
        notAfter: '2027-01-01T00:00:00.000Z',
        daysLeft: 100,
        fingerprint: 'AA:BB',
      },
      ca: {
        exists: true,
        notAfter: '2030-01-01T00:00:00.000Z',
        daysLeft: 1000,
        fingerprint: 'CC:DD',
      },
    })],
  });

  const home = wrapper.get('[data-testid="access-route-home"]');
  assert.match(home.text(), /HTTP без шифрования/);
  await home.get('[data-testid="local-details-toggle"]').trigger('click');
  await flushPromises();
  assert.equal(wrapper.get('#local-https-settings').attributes('role'), 'region');
  assert.ok(wrapper.findAll('button').some((button) => button.text() === 'Удалить сертификат'));
});

test('ACCESS-WEB-16: старый accessGateway не раскрывает мастер после перезагрузки', async (t) => {
  const { wrapper } = await mountSettingsAccess(t, {
    prefs: { accessLocalHttps: false, accessGateway: true, trustedDirectories: [] },
    gateway: { setup: null, job: null, publicDomain: '' },
  });

  assert.equal(wrapper.find('#gateway-settings').exists(), false);
  assert.match(wrapper.get('[data-testid="access-route-internet"]').text(), /Не настроен/);
});

test('ACCESS-WEB-17: мастер явно различает права Cloudflare и объясняет SSH-отпечаток', async (t) => {
  const { wrapper, flushPromises } = await mountSettingsAccess(t, {
    gateway: {
      setup: {
        domain: 'cockpit.example.com', gateway: '203.0.113.10', sshPort: 22,
        sshUser: 'root', dns: 'cloudflare',
      },
      job: null,
      publicDomain: 'cockpit.example.com',
    },
  });

  await wrapper.get('[data-testid="gateway-details-toggle"]').trigger('click');
  await flushPromises();
  const gateway = wrapper.get('#gateway-settings');
  assert.match(gateway.text(), /Zone → Zone → Read/);
  assert.match(gateway.text(), /Zone → DNS → Edit/);
  assert.match(gateway.text(), /Zone → Zone → Edit.*права менять DNS/);

  const probe = gateway.findAll('button').find((button) => button.text() === 'Проверить сервер');
  assert.ok(probe);
  await probe.trigger('click');
  await flushPromises();
  assert.match(gateway.text(), /ключа самого VPS \(SSH host key\)/);
  assert.match(gateway.text(), /веб-консоль\/VNC/);
  assert.match(gateway.text(), /ssh_host_\*_key\.pub/);
  assert.match(gateway.text(), /SHA256/);
});

test('ACCESS-WEB-18: выход со всех устройств проходит через общий danger-dialog', async (t) => {
  const {
    wrapper,
    posts,
    confirmations,
    flushPromises,
  } = await mountSettingsAccess(t, {
    confirmAnswers: [false, true],
  });
  const logoutAllButton = wrapper.findAll('button')
    .find((button) => button.text() === 'Выйти со всех устройств');

  assert.ok(logoutAllButton);

  await logoutAllButton.trigger('click');
  await flushPromises();
  assert.equal(posts.some((call) => call.path === '/api/auth/logout-all'), false);

  await logoutAllButton.trigger('click');
  await flushPromises();
  assert.equal(confirmations.length, 2);
  assert.deepEqual(confirmations[1], {
    message: 'Разлогинить все устройства, включая это?',
    options: {
      danger: true,
      okText: 'Выйти со всех',
    },
  });
  assert.equal(
    posts.filter((call) => call.path === '/api/auth/logout-all').length,
    1,
  );
});
