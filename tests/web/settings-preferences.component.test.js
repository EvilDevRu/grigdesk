import assert from 'node:assert/strict';
import test from 'node:test';
import { compileModule, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { assertSettingsFields } from './helpers/settings-consistency.js';

test('Параметры приложения — общий черновик и применение', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ createPinia, setActivePinia }, { mount, flushPromises }, module] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileModule(webFile('../tests/web/helpers/settings-pages.ts'), {
      stubs: {
        '../router.ts': 'export const router = { push: async () => {} };',
        '../../../composables/useSse.ts': `
          export function sseSubscribe(listener) {
            globalThis.__settingsSseListeners.add(listener);
            return () => globalThis.__settingsSseListeners.delete(listener);
          }
        `,
        '../../../shared/webLogRuntime.ts': `
          export const getWebLogRuntime = () => ({
            applyPolicy: (...args) => globalThis.__settingsPolicyCalls.push(args),
          });
        `,
      },
    }),
  ]);
  const posts = [];
  const debugPosts = [];
  let debug = {
    configured: 'errors',
    effective: 'errors',
    source: 'global',
    expiresAt: 12000,
  };

  globalThis.__settingsSseListeners = new Set();
  globalThis.__settingsPolicyCalls = [];

  let prefs = {
    gitRefreshBeforeRun: true,
    chatLiveSessions: true,
    chatAutoContinue: true,
    showAllModels: false,
    chatAutoCompactWindow: 12000,
    stageAutoCompactWindow: 22000,
    runSilenceWindow: 90,
    arbiter: {
      auto: true,
      modelRef: { provider: 'missing', model: 'old' },
      effort: 'high',
    },
    plugins: { forbidden: true },
  };
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('/api/settings/factory-debug')) {
      if (options.method === 'POST') {
        debugPosts.push(JSON.parse(options.body));
        debug = {
          ...debug,
          configured: 'verbose',
          effective: 'errors',
          source: 'env',
        };
      }

      return new Response(JSON.stringify(debug));
    }
    if (String(url).includes('/api/settings/prefs')) {
      if (options.method === 'POST') {
        const patch = JSON.parse(options.body);

        posts.push(patch);
        prefs = { ...prefs, ...patch };
      }

      return new Response(JSON.stringify(prefs));
    }
    if (String(url).includes('/api/providers')) {
      return new Response(JSON.stringify({ providers: [] }));
    }

    throw new Error(`Неожиданный API: ${url}`);
  };

  t.after(() => {
    settings.dispose();
    globalThis.fetch = originalFetch;
    delete globalThis.__settingsSseListeners;
    delete globalThis.__settingsPolicyCalls;
  });

  const pinia = createPinia();

  setActivePinia(pinia);

  const settings = module.useSettingsStore();

  settings.setAuthenticated(true);
  settings.requestOpen({ pageId: 'automation.chats' });

  const wrapper = mount(module.PreferencesPage, {
    attachTo: browser.document.querySelector('#mount'),
    props: { active: true },
    global: { plugins: [pinia] },
  });

  t.after(() => wrapper.unmount());
  await flushPromises();

  await t.test('PF01/PF08/PF10: ввод не пишет API, Apply отправляет только prefs patch', async () => {
    const switches = wrapper.findAll('[role="switch"]');

    assert.equal(switches.length, 2);
    await switches[0].trigger('click');
    await switches[1].trigger('click');

    settings.selectPage('automation.launch');
    await flushPromises();
    await wrapper.find('[role="switch"]').trigger('click');
    settings.selectPage('agents.models');
    await flushPromises();
    await wrapper.find('[role="switch"]').trigger('click');

    assert.equal(posts.length, 0);
    assert.equal(settings.snapshot.dirtyCount, 4);
    await settings.apply();

    assert.deepEqual(posts, [{
      chatLiveSessions: false,
      chatAutoContinue: false,
      gitRefreshBeforeRun: false,
      showAllModels: true,
    }]);
    assert.equal(module.useProvidersStore().showAllModels, true);
    assert.equal(module.useChatStore().compactWindow, 12000);
  });

  await t.test('PF02/PF03: независимые пороги, 0 и нетронутые 90 секунд', async () => {
    settings.selectPage('automation.monitoring');
    await flushPromises();

    assert.equal(wrapper.find('input').element.value, '1.5');
    settings.selectPage('automation.context');
    await flushPromises();

    const inputs = wrapper.findAll('input');

    await inputs[0].setValue('0');
    await inputs[1].setValue('33000');
    assert.equal(posts.length, 1);
    await settings.apply();

    assert.deepEqual(posts[1], { chatAutoCompactWindow: 0, stageAutoCompactWindow: 33000 });
    assert.equal(module.useChatStore().compactWindow, 0);
    settings.selectPage('automation.monitoring');
    await flushPromises();
    await wrapper.find('input').setValue('2.5');
    await settings.apply();

    assert.deepEqual(posts[2], { runSilenceWindow: 150 });
  });

  await t.test('PF04/PF04b: один auto сохраняет прежние modelRef и effort', async () => {
    settings.selectPage('automation.arbiter');
    await flushPromises();

    assert.match(wrapper.text(), /нет в реестре/);
    await wrapper.find('[role="switch"]').trigger('click');
    await settings.apply();

    assert.deepEqual(posts[3], {
      arbiter: {
        auto: false,
        modelRef: { provider: 'missing', model: 'old' },
        effort: 'high',
      },
    });
  });

  await t.test('CONS-automation.*, CONS-agents.models: реестр совпадает с формой', async () => {
    for (const pageId of [
      'automation.chats', 'automation.context', 'automation.launch',
      'automation.monitoring', 'automation.arbiter', 'agents.models',
    ]) {
      settings.selectPage(pageId);
      await flushPromises();

      assertSettingsFields(wrapper.element, module.SETTINGS_FIELDS, pageId);
    }
  });

  await t.test('PF05/PF07: устройство меняется по Apply, разрешение — только кликом', async () => {
    settings.selectPage('interface.behavior');

    const device = module.useDeviceStore();

    device.wakeLockSupported = false;

    const page = mount(module.InterfacePage, { props: { active: true }, global: { plugins: [pinia] } });

    t.after(() => page.unmount());
    await flushPromises();

    assert.equal(page.find('[role="switch"]').exists(), false,
      'Без Wake Lock API выключенная настройка не отображается');
    device.wakeLockSupported = true;
    await flushPromises();

    const previous = device.wakeLockEnabled;

    await page.find('[role="switch"]').setValue(!previous);

    assert.equal(device.wakeLockEnabled, previous);
    assert.equal(browser.localStorage.getItem('grigdesk-screen-wake-lock'), null);
    await settings.apply();

    assert.equal(device.wakeLockEnabled, !previous);
    assert.equal(browser.localStorage.getItem('grigdesk-screen-wake-lock'), previous ? '0' : '1');
    device.wakeLockSupported = false;
    await flushPromises();

    assert.equal(page.find('[role="switch"]').exists(), true,
      'Сохранённую включённую настройку можно выключить и без доступного API');

    let notifications = 0;

    device.notificationSupported = true;
    device.testNotification = async () => {
      notifications += 1;

      return true;
    };
    settings.selectPage('interface.notifications');
    await flushPromises();

    assert.equal(notifications, 0);
    await page.find('button').trigger('click');

    assert.equal(notifications, 1);
    assertSettingsFields(page.element, module.SETTINGS_FIELDS, settings.pageId);
    settings.selectPage('interface.behavior');
    await flushPromises();
    await page.find('[role="switch"]').setValue(!previous);
    settings.cancel();

    assert.equal(device.wakeLockEnabled, !previous);
    page.unmount();
    settings.requestOpen({ pageId: 'interface.shortcuts' });
  });

  await t.test('PF06/PF06b: запись Escape, конфликт черновика и обмен клавиш одним Apply', async () => {
    const hotkeys = module.useHotkeysStore();
    const page = mount(module.InterfacePage, { props: { active: true }, global: { plugins: [pinia] } });

    t.after(() => page.unmount());
    await flushPromises();

    const rows = page.findAll('[data-hotkey-tool]');
    const first = rows[0].attributes('data-hotkey-tool');
    const second = rows[1].attributes('data-hotkey-tool');
    const firstCombo = hotkeys.comboOf(first);
    const secondCombo = hotkeys.comboOf(second);

    await rows[0].find('[data-record]').trigger('click');

    assert.equal(hotkeys.recording, first);

    browser.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));

    assert.equal(hotkeys.recording, null);
    settings.setField('hotkeys', 'overrides', { [first]: secondCombo, [second]: secondCombo });
    await flushPromises();

    assert.match(page.text(), /уже открывает/);
    assert.equal(hotkeys.comboOf(first), firstCombo);
    settings.setField('hotkeys', 'overrides', { [first]: secondCombo, [second]: firstCombo });
    await flushPromises();
    await settings.apply();

    assert.equal(hotkeys.comboOf(first), secondCombo);
    assert.equal(hotkeys.comboOf(second), firstCombo);
    assert.equal(settings.snapshot.dirtyCount, 0);
    assertSettingsFields(page.element, module.SETTINGS_FIELDS, 'interface.shortcuts');
    await rows[0].find('[data-record]').trigger('click');

    const nested = mount(module.UiDialog, {
      props: { open: true, label: 'Вложенная проверка' },
      global: { stubs: { transition: false } },
    });

    await flushPromises();

    assert.equal(hotkeys.recording, null);
    nested.unmount();
    await rows[0].find('[data-record]').trigger('click');
    settings.selectPage('interface.notifications');
    await flushPromises();

    assert.equal(hotkeys.recording, null);
  });

  await t.test('PF09: ответ политики, источник effective и SSE без потери dirty', async () => {
    settings.selectPage('system.diagnostics');

    const page = mount(module.DiagnosticsPage, { props: { active: true }, global: { plugins: [pinia] } });

    t.after(() => page.unmount());
    await flushPromises();

    const policies = globalThis.__settingsPolicyCalls.length;

    await page.find('select').setValue('verbose');

    assert.equal(debugPosts.length, 0);
    assert.equal(globalThis.__settingsPolicyCalls.length, policies);
    await settings.apply();
    await flushPromises();

    assert.deepEqual(debugPosts, [{ scope: 'global', level: 'verbose' }]);
    assert.deepEqual(globalThis.__settingsPolicyCalls.at(-1), ['errors', 12000]);
    assert.match(page.text(), /переменная окружения/);
    await page.find('select').setValue('decisions');

    debug = {
      configured: 'off',
      effective: 'off',
      source: 'global',
      expiresAt: 0,
    };

    for (const listener of globalThis.__settingsSseListeners) {
      listener('diagnostic-logging', { at: 100 });
    }

    await flushPromises();

    assert.equal(settings.getValue('factoryDebug', 'level'), 'decisions');

    const field = settings.snapshot.resources.find((item) => item.id === 'factoryDebug').fields[0];

    assert.equal(field.conflict.serverValue, 'off');
    assert.equal(settings.resourceDetails.factoryDebug.effective, 'off');
    assert.equal(settings.snapshot.dirtyCount, 1);
    assert.equal(debugPosts.length, 1);
  });
});
