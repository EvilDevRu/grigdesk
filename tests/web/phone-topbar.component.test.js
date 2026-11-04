process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';

let browser;
let mount;
let flushPromises;
let h;
let ref;
let nextTick;
let PhoneStatusBar;
let SystemResourcesButton;
let PhoneShellPortal;

before(async () => {
  browser = await createUiBrowser();
  Object.defineProperty(globalThis, 'history', {
    value: browser.history,
    configurable: true,
  });

  const [utils, vue, status, portal, metrics] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
    compileVue(webFile('src/shared/layout/PhoneStatusBar.vue')),
    compileVue(webFile('src/shared/layout/PhoneShellPortal.vue')),
    compileVue(webFile('src/shared/layout/SystemResourcesButton.vue')),
  ]);

  ({ mount, flushPromises } = utils);
  h = vue.h;
  ref = vue.ref;
  nextTick = vue.nextTick;
  PhoneStatusBar = status;
  SystemResourcesButton = metrics;
  PhoneShellPortal = portal;
});

after(async () => browser.close());

test('DESKTOP-RESOURCES: кнопка ресурсов принимает клик в заголовке и удерживает метку', async (t) => {
  browser.document.body.innerHTML = '<header class="window-titlebar"><div id="mount"></div></header>';
  browser.happyDOM.setWindowSize({ width: 1440, height: 900 });

  const wrapper = mount(SystemResourcesButton, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      metrics: null,
      stale: false,
      alarm: true,
    },
    attrs: { class: 'system-resources-trigger' },
  });
  const style = browser.document.createElement('style');
  const actions = await readFile(webFile('src/styles/components/actions.css'), 'utf8');
  const shell = await readFile(webFile('src/shared/layout/AppShell.vue'), 'utf8');
  const shellCss = shell.match(/<style scoped>([\s\S]*?)<\/style>/u)[1];

  style.textContent = actions;
  browser.document.head.append(style);
  t.after(() => {
    wrapper.unmount();
    style.remove();
  });

  const selectors = [...shellCss.matchAll(/([^{}]+)\{\s*-webkit-app-region: no-drag;/gu)]
    .map((match) => match[1].trim());
  const noDrag = selectors.some((selector) => wrapper.element.closest(selector) !== null);
  const position = browser.getComputedStyle(wrapper.element).position || 'static';
  const alarm = browser.getComputedStyle(wrapper.get('.resources-alarm').element);

  assert.equal(position, 'relative');
  assert.equal(noDrag, true);
  assert.equal(alarm.top, '-2px');
  assert.equal(alarm.right, '-3px');
  assert.equal(browser.getComputedStyle(wrapper.get('.resource-memory').element).position, 'relative');
});

test('PHONE-TOPBAR: сводка использует снимок, неизвестные значения и компактную геометрию', async (t) => {
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const wrapper = mount(PhoneStatusBar, {
    attachTo: browser.document.querySelector('#mount'),
  });
  const metrics = mount(SystemResourcesButton, {
    attachTo: wrapper.get('#phone-status-metrics').element,
    props: {
      metrics: null,
      stale: false,
      phone: true,
    },
  });

  t.after(() => {
    metrics.unmount();
    wrapper.unmount();
  });
  assert.match(wrapper.text(), /CPU —/u);
  assert.match(wrapper.text(), /RAM —/u);
  assert.equal(wrapper.find('button').exists(), true);

  await metrics.setProps({
    metrics: {
      cpu: { percent: 85 },
      mem: {
        percent: 60,
        usedGb: 6.4,
        totalGb: 16,
      },
    },
    stale: true,
  });

  assert.match(wrapper.text(), /CPU 85%/u);
  assert.match(wrapper.text(), /RAM 6,4\/16/u);
  assert.equal(wrapper.get('.phone-status-metrics').classes().includes('stale'), true);
  assert.equal(wrapper.get('.phone-status-metrics b').classes().includes('lv-bad'), true);

  const style = browser.document.createElement('style');
  const cssText = (await Promise.all(['tokens', 'base', 'components/patterns'].map((name) =>
    readFile(webFile(`src/styles/${name}.css`), 'utf8')))).join('\n');

  browser.happyDOM.setWindowSize({ width: 390, height: 844 });
  style.textContent = cssText;
  browser.document.head.append(style);
  t.after(() => style.remove());

  const css = browser.getComputedStyle(wrapper.element);

  assert.equal(css.display, 'flex');
  assert.equal(css.height, '30px');
  assert.equal(css.gridRow, '1');
  assert.equal(css.alignSelf, 'end');
  assert.equal(browser.getComputedStyle(wrapper.get('.phone-status-providers').element).overflowX, 'auto');

  browser.happyDOM.setWindowSize({ width: 1280, height: 900 });
  style.textContent = cssText;
  assert.equal(browser.getComputedStyle(wrapper.element).display, 'none');
});

test('PHONE-TOPBAR: перенос сохраняет один экземпляр и возвращает действие на desktop', async (t) => {
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const phone = ref(false);
  const menuOpen = ref(false);
  let clicks = 0;
  const wrapper = mount({
    render: () => h('div', [
      h('div', { id: 'phone-actions-parking', hidden: true }),
      menuOpen.value ? h('section', { id: 'phone-sections-actions' }) : null,
      h('header', { 'data-ui-topbar': '' }, [
        h(PhoneShellPortal, { phone: phone.value, menuOpen: menuOpen.value }, {
          default: () => h('button', { onClick: () => clicks += 1 }, 'Действие'),
        }),
      ]),
    ]),
  }, { attachTo: browser.document.querySelector('#mount') });

  t.after(() => wrapper.unmount());
  await nextTick();

  const action = wrapper.get('button').element;

  assert.equal(action.closest('header') !== null, true);
  phone.value = true;
  await nextTick();
  assert.equal(action.parentElement.id, 'phone-actions-parking');
  menuOpen.value = true;
  await flushPromises();
  assert.equal(action.parentElement.id, 'phone-sections-actions');
  action.click();
  assert.equal(clicks, 1);
  menuOpen.value = false;
  await flushPromises();
  assert.equal(action.parentElement.id, 'phone-actions-parking');
  phone.value = false;
  await nextTick();
  assert.equal(action.closest('header') !== null, true);
  assert.equal(browser.document.querySelectorAll('button').length, 1);
});

/**
 * Монтирует настоящую оболочку с управляемым начальным состоянием подключения.
 * Сетевые и тяжёлые панели изолированы, Teleport и переходы DOM выполняет Vue.
 */
async function mountAppShell(t, shellState) {
  browser.document.body.innerHTML = '<div id="mount"></div>';
  browser.happyDOM.setWindowSize({ width: 390, height: 844 });

  const [{ createPinia }, routerModule, compiledShell] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/vue-router/dist/vue-router.mjs'),
    compileVue(webFile('src/shared/layout/AppShell.vue'), {
      stubs: {
        './speechPcmWorklet.ts?worker&url': 'export default "fixture-worklet";',
        '../../shared/monaco.ts': [
          'export const monaco = {};',
          'export const langOf = () => "text";',
          'export const READONLY_OPTS = {};',
        ].join('\n'),
        '../tools/registry.ts': 'export const toolById = () => true;',
        './ToolHost.vue': 'export default { render: () => null };',
        '../../features/analysis/AttentionAlerts.vue': 'export default { render: () => null };',
        '../ProviderInstallDialog.vue': 'export default { render: () => null };',
        '../../views/settings/PhoneConnectDialog.vue': 'export default { render: () => null };',
        '../../composables/useSse.ts': [
          'import { ref } from "vue";',
          'export const useSse = () => ({ connected: ref(false) });',
          'export const sseSubscribe = () => () => {};',
        ].join('\n'),
      },
    }),
  ]);
  const router = routerModule.createRouter({
    history: routerModule.createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  });

  await router.push('/board');
  await router.isReady();

  const pinia = createPinia();

  if (shellState) {
    pinia.state.value.shell = shellState;
  }

  const errors = [];
  const wrapper = mount(compiledShell, {
    attachTo: browser.document.querySelector('#mount'),
    props: { active: false },
    global: {
      plugins: [pinia, router],
      stubs: { transition: false },
      config: {
        errorHandler(error, _instance, phase) {
          const details = {
            name: error.name,
            message: error.message,
            phase,
          };

          errors.push(details);
        },
      },
    },
  });

  t.after(() => {
    wrapper.unmount();
    assert.deepEqual(errors, []);
  });
  await flushPromises();
  // Happy DOM начинает сравнение matches с false даже для уже совпадающего media.
  // Первый resize запоминает текущее совпадение перед проверкой реальной смены ширины.
  browser.dispatchEvent(new browser.Event('resize'));
  await flushPromises();

  return {
    wrapper,
    pinia,
    router,
  };
}

test('PHONE-TOPBAR: настоящая оболочка переносит команды в диалог разделов', async (t) => {
  const { wrapper, pinia } = await mountAppShell(t);
  const metricsHost = wrapper.get('#phone-status-metrics').element;
  const providersHost = wrapper.get('#phone-status-providers').element;

  assert.equal(wrapper.get('.topbar').find('[data-shell-status-trigger]').exists(), false);
  assert.equal(wrapper.get('.topbar').findAll('button').length, 1);
  assert.equal(wrapper.find('[data-ui-phone-status]').exists(), true);

  const providerStore = pinia._s.get('providers');
  let usageLoads = 0;

  providerStore.loadUsage = async () => usageLoads += 1;
  providerStore.providers = [{
    id: 'codex',
    name: 'Codex',
    vendor: 'Fixture',
    type: 'universal',
    kind: 'cli',
    available: true,
    installed: true,
    chatEnabled: true,
    models: [],
    settings: [],
    credentials: [],
  }];
  providerStore.usage = {
    codex: {
      state: 'ok',
      bars: [{
        key: 'week',
        label: 'Неделя',
        pct: 42,
      }],
    },
  };
  await flushPromises();

  const providerButton = wrapper.get('[data-ui-phone-status] [data-context="provider-status"]');
  const style = browser.document.createElement('style');

  browser.document.documentElement.setAttribute('data-ui-touch', '');
  style.textContent = (await Promise.all(['tokens', 'base', 'components/foundation', 'components/actions']
    .map((name) => readFile(webFile(`src/styles/${name}.css`), 'utf8')))).join('\n');
  browser.document.head.append(style);
  t.after(() => {
    style.remove();
    browser.document.documentElement.removeAttribute('data-ui-touch');
  });
  assert.equal(browser.getComputedStyle(providerButton.element).width, '32px');
  assert.equal(browser.getComputedStyle(providerButton.element).height, '30px');

  await providerButton.trigger('click');
  await flushPromises();
  assert.equal(usageLoads, 1);
  assert.equal(browser.document.querySelector('.ptip-name').textContent, 'Codex');
  assert.match(browser.document.querySelector('.pu').textContent, /Неделя.*42%/u);
  await providerButton.trigger('click');
  await flushPromises();

  const notifyWatch = pinia._s.get('notifyWatch');

  notifyWatch.running = [{ task: 71, taskTitle: 'Проверка скрытого конвейера' }];
  pinia._s.get('system').data = {
    cpu: {
      percent: 72,
      cores: 8,
      load1: 1.23,
    },
    mem: {
      totalGb: 24,
      usedGb: 16,
      percent: 67,
    },
  };
  await flushPromises();

  const metricsButton = wrapper.get('[data-ui-phone-status] [data-context="phone-status-metrics"]');

  assert.equal(metricsButton.attributes('aria-expanded'), 'false');
  metricsButton.element.focus();
  await metricsButton.trigger('click');
  await flushPromises();
  assert.equal(metricsButton.attributes('aria-expanded'), 'true');
  assert.equal(Boolean(browser.document.querySelector(
    '[data-role="system-resources"] .computer-resources',
  )), true);
  assert.match(browser.document.querySelector('.computer-resources').textContent, /Процессор.*72%/u);
  assert.equal(Boolean(browser.document.querySelector('.shell-status-panel')), false);
  assert.equal(browser.document.querySelectorAll('[data-role="system-resources"] button').length, 1);
  assert.equal(browser.getComputedStyle(metricsButton.element).height, '30px');
  browser.document.querySelector('[data-role="system-resources"] button[aria-label="Закрыть"]').click();
  await flushPromises();
  assert.equal(metricsButton.attributes('aria-expanded'), 'false');
  assert.equal(browser.document.activeElement === metricsButton.element, true);

  const phoneCommand = browser.document.querySelector(
    '#phone-actions-parking button[aria-haspopup="dialog"]',
  );

  assert.equal(Boolean(phoneCommand), true);
  await wrapper.get('.phone-nav button').trigger('click');
  await flushPromises();

  const dialog = browser.document.querySelector('[data-role="phone-sections"]');
  const moved = dialog.querySelector('#phone-sections-actions');

  assert.equal(moved.contains(phoneCommand), true);
  assert.equal(browser.document.activeElement.classList.contains('tools-grid'), true);
  assert.equal(Boolean(moved.querySelector('[data-shell-status-trigger]')), false);
  assert.equal(Boolean(moved.querySelector('[data-context="provider-status"]')), false);
  dialog.querySelector('button[aria-label="Закрыть"]').click();
  await flushPromises();
  assert.equal(phoneCommand.closest('#phone-actions-parking') !== null, true);

  browser.happyDOM.setWindowSize({ width: 1280, height: 900 });
  await flushPromises();
  assert.equal(wrapper.get('.topbar').find('[data-context="pipeline-topbar"]').exists(), true);

  for (const width of [1280, 800]) {
    browser.happyDOM.setWindowSize({ width, height: 900 });
    await flushPromises();
    await wrapper.get('.topbar [data-context="topbar-metrics"]').trigger('click');
    await flushPromises();
    assert.equal(Boolean(browser.document.querySelector(
    '[data-role="system-resources"] .computer-resources',
  )), true);
    assert.equal(Boolean(browser.document.querySelector('.shell-status-panel')), false);
    browser.document.querySelector('[data-role="system-resources"] button[aria-label="Закрыть"]').click();
    await flushPromises();
  }

  browser.happyDOM.setWindowSize({ width: 390, height: 844 });
  await flushPromises();

  pinia._s.get('shell').present = true;
  await flushPromises();
  assert.equal(wrapper.get('[data-ui-phone-status]').isVisible(), false);
  assert.equal(metricsHost.isConnected, true);
  assert.equal(providersHost.isConnected, true);
  assert.equal(wrapper.get('.phone-nav').findAll('a').length, 0);
  await wrapper.get('.phone-nav button').trigger('click');
  await flushPromises();
  assert.equal(Boolean(browser.document.querySelector(
    '.topbar [data-context="connection-trigger"]',
  )), true);
  assert.equal(Boolean(browser.document.querySelector('#phone-sections-actions .connection-label')), false);
  browser.document.querySelector('[data-role="phone-sections"] button[aria-label="Закрыть"]').click();
  await flushPromises();

  pinia._s.get('shell').present = false;
  await flushPromises();
  assert.equal(wrapper.get('[data-ui-phone-status]').isVisible(), true);
  assert.equal(wrapper.get('#phone-status-metrics').element === metricsHost, true);
  assert.equal(wrapper.get('#phone-status-providers').element === providersHost, true);
  assert.equal(browser.document.querySelectorAll('#phone-status-metrics button').length, 1);
  assert.equal(browser.document.querySelectorAll('#phone-status-providers button').length, 1);
});

test('PHONE-TOPBAR: запуск без машины восстанавливает обе области после подключения', async (t) => {
  const { wrapper, pinia, router } = await mountAppShell(t, {
    present: true,
    initialized: true,
    snapshot: null,
    everOnline: false,
    showConnections: false,
  });

  assert.equal(wrapper.get('.phone-nav').findAll('a').length, 0);
  assert.equal(wrapper.get('[data-ui-phone-status]').isVisible(), false);
  pinia._s.get('providers').providers = [{
    id: 'codex',
    name: 'Codex',
    kind: 'cli',
    available: true,
    installed: true,
    chatEnabled: true,
    models: [],
    settings: [],
    credentials: [],
  }];

  const shell = pinia._s.get('shell');
  const profile = {
    id: 'fixture-machine',
    name: 'Проверочная машина',
    kind: 'remote',
    address: 'https://grigdesk.test',
    status: 'online',
  };
  const snapshot = {
    rev: 1,
    status: 'online',
    detail: null,
    profile,
    profiles: [profile],
    localAvailable: false,
    serverApi: { major: 1, minor: 0 },
    appApi: { major: 1, minor: 0 },
    capabilities: [],
  };

  shell.apply(snapshot);
  await flushPromises();
  assert.equal(browser.document.querySelectorAll('#phone-status-metrics button').length, 1);
  assert.equal(browser.document.querySelectorAll('#phone-status-providers button').length, 1);
  assert.match(wrapper.get('#phone-status-metrics').text(), /CPU —.*RAM —/u);

  const metrics = wrapper.get('#phone-status-metrics button').element;
  const provider = wrapper.get('#phone-status-providers button').element;

  for (const status of ['offline', 'connecting', 'locked', 'online']) {
    shell.apply({
      ...snapshot,
      rev: shell.snapshot.rev + 1,
      status,
    });
    await flushPromises();
    assert.equal(wrapper.get('#phone-status-metrics button').element === metrics, true);
    assert.equal(wrapper.get('#phone-status-providers button').element === provider, true);
    assert.equal(metrics.isConnected && provider.isConnected, true);
  }

  pinia._s.get('system').stale = true;
  await flushPromises();
  assert.equal(metrics.classList.contains('stale'), true);
  metrics.focus();
  metrics.click();
  await flushPromises();
  assert.equal(browser.document.querySelectorAll('[data-role="system-resources"]').length, 1);
  browser.document.querySelector('[data-role="system-resources"] button[aria-label="Закрыть"]').click();
  await flushPromises();
  assert.equal(browser.document.activeElement === metrics, true);

  // Граница сети отключена для проверки прямых действий настоящей оболочки.
  // Сам мастер запрашивается настоящим store без запуска серверного прохода.
  for (const [store, action] of [
    ['chat', 'ensure'],
    ['plugins', 'load'],
    ['providers', 'load'],
    ['providers', 'loadUsage'],
    ['notifyWatch', 'start'],
    ['grigdesk-update', 'start'],
  ]) {
    pinia._s.get(store)[action] = async () => {};
  }

  await wrapper.setProps({ active: true });
  await flushPromises();

  const originalRoute = router.currentRoute.value.fullPath;
  const wizard = wrapper.get('.topbar button[aria-label="Мастер настройки"]');
  const machine = wrapper.get('.topbar [data-context="connection-trigger"]');

  assert.equal(wizard.attributes('data-context'), 'topbar-action');
  assert.equal(wizard.attributes('aria-haspopup'), 'dialog');
  await wizard.trigger('click');
  await flushPromises();
  assert.equal(pinia._s.get('onboarding').requestedMode, 'manual');
  assert.equal(router.currentRoute.value.fullPath, originalRoute);
  assert.equal(browser.document.querySelectorAll('button[aria-label="Мастер настройки"]').length, 1);
  await machine.trigger('click');
  await flushPromises();
  assert.equal(browser.document.querySelectorAll('[data-connection-menu]').length, 1);
  await machine.trigger('click');
  await flushPromises();
  await wrapper.get('.phone-nav button').trigger('click');
  await flushPromises();
  assert.equal(Boolean(browser.document.querySelector(
    '#phone-sections-actions button[aria-label="Мастер настройки"]',
  )), false);
  assert.equal(Boolean(browser.document.querySelector(
    '#phone-sections-actions [data-context="connection-trigger"]',
  )), false);
  browser.document.querySelector('[data-role="phone-sections"] button[aria-label="Закрыть"]').click();
  await flushPromises();
  assert.equal(wizard.element.closest('.topbar') !== null, true);
  assert.equal(machine.element.closest('.topbar') !== null, true);
  await wrapper.setProps({ active: false });
  await flushPromises();
  assert.equal(wrapper.find('.topbar button[aria-label="Мастер настройки"]').exists(), false);
  assert.equal(wrapper.get('.topbar [data-context="connection-trigger"]').element === machine.element, true);
});
