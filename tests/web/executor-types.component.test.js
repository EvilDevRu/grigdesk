import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { compileSettingsView } from './helpers/settings-view.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

/**
 * Создаёт безопасную публичную карточку без credential-значений.
 * Тип определяет только заявленные возможности, доступность меняется реактивно.
 */
function card(id, type, available = true) {
  return {
    id,
    name: id === 'tripo' ? 'Tripo' : 'Universal',
    vendor: 'Fixture',
    type,
    kind: type === '3d' ? 'api' : 'cli',
    available,
    installed: true,
    chatEnabled: type !== '3d',
    models: [],
    settings: [],
    credentials: type === '3d' ? [{
      env: 'TRIPO_API_KEY',
      kind: 'secret',
      label: 'API-ключ Tripo',
      set: false,
      inFile: false,
    }, {
      env: 'TRIPO_REGION',
      kind: 'choice',
      label: 'Регион',
      value: 'ov',
      options: [
        { value: 'ov', label: 'Международный' },
        { value: 'cn', label: 'Китай' },
      ],
    }] : [],
  };
}

function credits(summary = '215 кредитов') {
  return {
    state: 'ok',
    bars: [],
    resources: [{
      key: 'credits',
      label: 'Кредиты',
      summary,
      tone: 'ok',
      controls: [{
        id: 'top-up',
        kind: 'link',
        label: 'Пополнить',
        href: 'https://example.test/billing'
      }],
    }],
  };
}

/**
 * Компилирует настоящую оболочку с общей UI-границей, подменяя только окружение продукта.
 * SSE-handler остаётся настоящим: сценарий вызывает его как общий поток окна.
 */
function compileShell() {
  const stores = {
    system: 'useSystemStore',
    device: 'useDeviceStore',
    providers: 'useProvidersStore',
    plugins: 'usePluginsStore',
    'notify-watch': 'useNotifyWatchStore',
    'grigdesk-update': 'useGrigDeskUpdateStore',
    chat: 'useChatStore',
    board: 'useBoardStore',
    tasks: 'useTasksStore',
    ui: 'useUiStore',
    dock: 'useDockStore',
  };
  const stubs = Object.fromEntries(Object.entries(stores).map(([file, name]) => [
    `../../stores/${file}.js`,
    `export const ${name} = () => globalThis.__typesShellStores.${name};`,
  ]));
  const children = [
    '../../features/board/BoardTimerPopover.vue',
    '../../features/pipeline/PipelineTopbarPopover.vue',
    '../../features/analysis/AttentionAlerts.vue',
    '../../features/alerts/AlertHistoryPopover.vue',
    '../../plugins/PluginSlot.vue',
    './ToolHost.vue',
    './ToolsGrid.vue',
  ];

  for (const child of children) {
    stubs[child] = "export default { template: '<span />' };";
  }

  return compileVue(webFile('src/shared/layout/AppShell.vue'), {
    stubs: {
      ...stubs,
      '../apiClient.ts': 'export const api = { get: async () => ({}) };',
      '../../composables/useSse.ts': `
        export const useSse = (handler) => {
          globalThis.__typesShellSse = handler;
          return { connected: globalThis.__typesShellConnected };
        };
      `,
      'vue-router': `
        export const useRoute = () => ({ path: '/chats', fullPath: '/chats', query: {}, meta: {} });
        export const useRouter = () => ({ push() {}, resolve: () => ({ matched: [] }) });
      `,
      '../alertDeepLinks.ts': 'export const installAlertDeepLinks = () => () => {}; '
        + 'export const openAlertTarget = () => {};',
      '../alerts.ts': 'export const setAlertTargetOpener = () => {};',
      '../../actions/inbox': `
        export const useInboxStore = () => ({ reviewCount: 0 });
        export const startInboxSummary = () => {};
        export const stopInboxSummary = () => {};
      `,
      '../../composables/useDesktopSettingsSync.ts': 'export const useDesktopSettingsSync = () => {};',
      '../tools/launcher.ts': 'export const useToolLauncher = () => ({ openTerminal() {} });',
      '../tools/registry.ts': 'export const toolById = () => null;',
    },
  });
}

/**
 * Один браузер и одна Vue-runtime на файл предотвращают потерю Teleport между сценариями.
 * Подменённые stores читаются в момент setup, поэтому каждый mount получает свежий снимок.
 */
test('типы исполнителей в настоящих настройках и топбаре', async (t) => {
  const browser = await installUiBrowser(t);

  globalThis.__GRIGDESK_VERSION__ = 'test';
  globalThis.__GRIGDESK_SHA__ = 'test';

  const { reactive, ref, nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const { createPinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );

  globalThis.__typesApi = { get: async () => ({}), post: async () => ({}) };

  const SettingsView = await compileSettingsView({ prefix: '__types' });

  await t.test('две группы: общая гармошка, ARIA, поля, API и credits', async (s) => {
    browser.document.body.innerHTML = '<div id="mount"></div>';
    browser.localStorage.setItem('grigdesk-settings-tab', 'providers');

    const providers = reactive({
      providers: [card('universal'), card('tripo', '3d', false)],
      loaded: true,
      usage: { tripo: credits() },
      mcp: {},
      updating: '',
      updateResults: {},
      visibleModels: () => [],
      load: async () => {},
      loadUsage: async () => {},
      saveSetting: async () => ({ ok: true }),
      saveCredentials: async () => ({ ok: true }),
    });

    globalThis.__typesStores = {
      useProvidersStore: () => providers,
      useAuthStore: () => ({ login: 'fixture' }),
      usePluginsStore: () => ({
        loaded: true,
        list: [],
        enabled: () => false,
        load: async () => {}
      }),
      useChatStore: () => ({ compactWindow: 0 }),
      useDeviceStore: () => ({ canInstall: false }),
      useGrigDeskUpdateStore: () => ({ state: null, load: async () => {} }),
    };

    const wrapper = mount(SettingsView, {
      attachTo: browser.document.querySelector('#mount'),
      global: { plugins: [createPinia()] },
    });

    s.after(() => wrapper.unmount());
    await flushPromises();

    assert.deepEqual(wrapper.findAll('[data-executor-type] h3').map((item) => item.text()),
      ['Универсальные', '3D-генерация']);

    const universal = wrapper.get('[data-provider-id="universal"]');
    const tripo = wrapper.get('[data-provider-id="tripo"]');
    const toggleA = universal.get('[data-testid="provider-toggle"]');
    const toggleB = tripo.get('[data-testid="provider-toggle"]');

    assert.equal(toggleA.attributes('aria-expanded'), 'false');
    // happy-dom не синтезирует native click из keyboard, поэтому посылаем оба события браузера.
    await toggleA.trigger('keydown', { key: 'Enter' });
    await toggleA.trigger('click');
    assert.equal(toggleA.attributes('aria-expanded'), 'true');
    assert.equal(universal.get('[role="region"]').attributes('aria-labelledby'), toggleA.attributes('id'));
    await toggleB.trigger('keydown', { key: ' ' });
    await toggleB.trigger('click');
    assert.equal(toggleB.attributes('aria-expanded'), 'true');
    assert.equal(toggleA.attributes('aria-expanded'), 'false');
    assert.match(tripo.text(), /API/);
    assert.doesNotMatch(tripo.text(), /подключение к чатам|Обновить CLI|Установка:/);
    assert.match(tripo.text(), /API-ключ Tripo/);
    assert.match(tripo.text(), /215 кредитов/);
    assert.equal(tripo.get('a[href="https://example.test/billing"]').text(), 'Пополнить');

    const edit = tripo.findAll('button').find((item) => item.text() === 'Задать ключи…');

    await edit.trigger('click');
    await flushPromises();

    const input = browser.document.querySelector('input[name="TRIPO_API_KEY"]');

    assert.ok(input);
    input.value = 'draft-value';
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
    await toggleA.trigger('click');
    await toggleB.trigger('click');
    assert.equal(browser.document.querySelector('input[name="TRIPO_API_KEY"]').value, 'draft-value');
    providers.providers = [card('universal')];
    await nextTick();
    assert.equal(wrapper.find('[data-executor-type]').exists(), false);
  });

  await t.test('реактивный топбар показывает Tripo с ключом, credits/ошибку и удаление; SSE invalidation',
    async (s) => {
      browser.document.body.innerHTML = '<div id="mount"></div>';

      const invalidated = [];
      const prov = reactive({
        providers: [card('universal', undefined, false), card('tripo', '3d', false)],
        usage: { tripo: credits() },
        updating: '',
        updateResults: {},
        load: async () => {},
        loadUsage: async () => {},
        noteUsageConnection() {},
        invalidateCredentials(id) {
          invalidated.push(id);
        },
        applyUsage(usage) {
          prov.usage = usage;
        },
      });
      const base = reactive({
        load() {},
        start() {},
        ensure() {},
        list: [],
        loaded: true,
        enabled: () => false,
        railNav: [],
        toolsNav: [],
        dockNav: [],
        activity: { activeTimerCount: 0, unseenCount: 0 },
        data: ref(null),
        stale: ref(false),
        updatedAt: ref(0),
        unreadCount: 0,
        waitingCount: 0,
        topbarItems: [],
        badgeSummary: {},
      });

      globalThis.__typesShellStores = Object.fromEntries([
        'useSystemStore', 'useDeviceStore', 'usePluginsStore', 'useNotifyWatchStore',
        'useGrigDeskUpdateStore', 'useChatStore', 'useBoardStore',
        'useTasksStore', 'useUiStore', 'useDockStore',
      ].map((name) => [name, base]));
      globalThis.__typesShellStores.useProvidersStore = prov;
      globalThis.__typesShellConnected = ref(false);

      const Shell = await compileShell();
      const wrapper = mount(Shell, {
        attachTo: browser.document.querySelector('#mount'),
        global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
      });

      s.after(() => wrapper.unmount());
      await flushPromises();

      assert.equal(wrapper.find('.prov.tripo').exists(), false);
      assert.equal(wrapper.find('.prov.universal').exists(), true);
      prov.providers[1].available = true;
      await nextTick();
      await wrapper.get('.prov.tripo').trigger('click');
      await flushPromises();
      assert.match(browser.document.body.textContent, /215 кредитов/);
      assert.equal(Boolean(browser.document.querySelector('a[href="https://example.test/billing"]')), false);
      assert.ok(browser.document.querySelector('[data-context="topbar-popover-refresh"]'));
      prov.usage.tripo = credits('0 кредитов');
      await nextTick();
      assert.match(browser.document.body.textContent, /0 кредитов/);
      assert.equal(wrapper.find('.prov.tripo').exists(), true);
      prov.usage.tripo = {
        state: 'auth_required',
        bars: [],
        resources: [],
        message: 'Проверьте ключ и регион'
      };
      await nextTick();
      assert.match(browser.document.body.textContent, /Проверьте ключ и регион/);
      assert.equal(wrapper.find('.prov.tripo').exists(), true);
      globalThis.__typesShellSse('providers-update', { credentials: 'tripo' });
      assert.deepEqual(invalidated, ['tripo']);
      prov.providers[1].available = false;
      await nextTick();
      assert.equal(wrapper.find('.prov.tripo').exists(), false);
    });

  delete globalThis.__typesStores;
  delete globalThis.__typesApi;
  delete globalThis.__typesShellStores;
  delete globalThis.__typesShellSse;
  delete globalThis.__typesShellConnected;
});
