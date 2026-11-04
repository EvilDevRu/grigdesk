import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';

let createPinia;
let setActivePinia;
let useShellStore;

process.env.NODE_ENV = 'test';

let browser;

before(async () => {
  browser = await createUiBrowser();
  ({
    createPinia,
    setActivePinia,
  } = await import('../../web/node_modules/pinia/dist/pinia.mjs'));
  ({ useShellStore } = await import('../../web/src/stores/shell.ts'));
});
after(() => browser.close());

const base = {
  rev: 3,
  status: 'online',
  detail: null,
  profile: null,
  profiles: [],
  localAvailable: true,
  appApi: {
    major: 0,
    minor: 1,
  },
  serverApi: null,
  capabilities: [],
};

test('блок приложения: снимок публикует gate, повреждённый блок не открывает доступ', () => {
  const store = useShellStore(createPinia());

  store.apply({
    ...base,
    appLock: {
      enabled: true,
      delaySeconds: 60,
      locked: false,
    },
  });
  assert.deepEqual(store.appLock, {
    enabled: true,
    delaySeconds: 60,
    locked: false,
  });
  assert.equal(store.appLocked, false);

  store.apply({
    ...base,
    rev: 4,
    appLock: {
      enabled: true,
      delaySeconds: 60,
      locked: true,
    },
  });
  assert.equal(store.appLocked, true);

  for (const broken of ['locked', 42, null,
    {
      enabled: true,
      delaySeconds: 45,
      locked: true,
    },
    {
      enabled: 'yes',
      delaySeconds: 60,
      locked: true,
    },
    {
      enabled: true,
      delaySeconds: 60,
    }]) {
    store.apply({
      ...base,
      rev: 5,
      appLock: broken,
    });
    assert.equal(store.appLock, null, 'Повреждённый блок не становится ложным разрешением');
    assert.equal(store.appLocked, false);
  }

  store.apply(base);
  assert.equal(store.appLock, null);
  assert.equal(store.appLocked, false);
});

const snapshotWithLock = {
  ...base,
  appLock: {
    enabled: false,
    delaySeconds: 60,
    locked: false,
  },
};

/**
 * Компонент загружается только после установки общего DOM, чтобы Vue сохранил правильный document.
 * Каждый вызов получает отдельную оболочку над текущим Pinia, не сохраняя стор прежнего теста.
 */
async function mountSetting() {
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const Setting = await compileVue(webFile('src/views/settings/AndroidAppLockSetting.vue'), {});

  return {
    nextTick,
    wrapper: mount(Setting, { attachTo: document.body }),
  };
}

test('настройка блокировки: сохранение полным значением, busy, отказ и скрытие без блока', async (t) => {
  const saved = globalThis.fetch;

  t.after(() => globalThis.fetch = saved);

  setActivePinia(createPinia());

  const store = useShellStore();

  store.apply(snapshotWithLock);

  const { nextTick, wrapper } = await mountSetting();

  t.after(() => wrapper.unmount());
  await nextTick();

  const field = document.querySelector('[data-ui-settings-field]');

  assert.match(field.textContent, /Блокировать приложение/);

  const select = field.querySelector('select');
  const options = [...select.querySelectorAll('option')].map((item) => item.value);

  assert.deepEqual(options, ['0', '60', '300']);
  assert.equal(select.disabled, true, 'Порог недоступен, пока блокировка выключена');

  const calls = [];
  let rejectSave;

  globalThis.fetch = async (url, options) => {
    calls.push({
      url,
      body: JSON.parse(options.body),
    });

    return new Promise((_accept, fail) => {
      rejectSave = fail;
    });
  };

  const current = field.querySelector('input[type="checkbox"]');

  current.click();
  await nextTick();

  assert.deepEqual(calls[0], {
    url: '/__shell/app-lock',
    body: {
      enabled: true,
      delaySeconds: 60,
    },
  });
  assert.equal(select.disabled, true, 'Повторное изменение ждёт принятый снимок');

  rejectSave(new Error('Отказ сохранения'));
  await new Promise((resolve) => setImmediate(resolve));
  await nextTick();

  assert.match(field.textContent, /Отказ сохранения/);
  assert.equal(select.disabled, true, 'После отказа возвращается принятое значение');

  globalThis.fetch = async (url, options) => {
    calls.push({
      url,
      body: JSON.parse(options.body),
    });

    return Response.json({
      ...snapshotWithLock,
      rev: 4,
      appLock: {
        enabled: JSON.parse(options.body).enabled,
        delaySeconds: JSON.parse(options.body).delaySeconds,
        locked: false,
      },
    });
  };

  // После отказа принятое значение осталось выключенным: сначала включаем тумблер
  // и ждём применения снимка, и только затем меняем порог.
  current.click();
  await new Promise((resolve) => setImmediate(resolve));
  await nextTick();

  assert.equal(store.appLock.enabled, true);

  select.value = '300';
  select.dispatchEvent(new Event('change'));
  await new Promise((resolve) => setImmediate(resolve));
  await nextTick();

  const accepted = calls[calls.length - 1];

  assert.deepEqual(accepted, {
    url: '/__shell/app-lock',
    body: {
      enabled: true,
      delaySeconds: 300,
    },
  });
  assert.equal(store.appLock.delaySeconds, 300);

  store.apply({
    ...base,
    rev: 5,
  });
  await nextTick();

  assert.equal(Boolean(document.querySelector('[data-ui-settings-field]')), false,
    'Без блока appLock настройка скрывается целиком');
});

test('страница интерфейса показывает блокировку Android рядом с настройкой выхода', async (t) => {
  const saved = globalThis.fetch;
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');

  t.after(() => globalThis.fetch = saved);

  setActivePinia(createPinia());

  const store = useShellStore();

  store.apply(snapshotWithLock);

  const Page = await compileVue(webFile('src/views/settings/pages/InterfacePage.vue'), {
    stubs: {
      '../../../stores/settings.ts': `export const useSettingsStore = () => ({
        pageId: 'interface.behavior',
        snapshot: { resources: [] },
        getValue: () => undefined,
        setField: () => {},
        bindSession: () => () => {},
      });`,
      '../../../stores/device.ts': `export const WAKE_LOCK_KEY = 'wakeLock';
        export const useDeviceStore = () => ({
          wakeLockSupported: false,
          wakeLockEnabled: false,
          wakeLockBusy: false,
          wakeLockActive: false,
          wakeLockError: '',
          notificationBusy: false,
          notificationSupported: false,
          notificationPermission: 'denied',
          testNotification: () => {},
        });`,
      '../../../stores/hotkeys.ts': `export const HOTKEYS_KEY = 'hotkeys';
        export const DEFAULT_HOTKEYS = {};
        export const validateHotkeyOverrides = () => ({ ok: true, error: '' });
        export const useHotkeysStore = () => ({
          recording: null,
          startRecording: () => {},
          stopRecording: () => {},
        });`,
      '../../../stores/plugins.ts': `export const usePluginsStore = () => ({});`,
      '../../../features/settings/catalog.ts': `export const SETTINGS_FIELDS = [];
        export const getSettingsFields = () => [];`,
      '../../../features/settings/resources/device.ts': `export const createHotkeysAdapter = () => ({});
        export const createWakeLockAdapter = () => ({});`,
      '../SettingsField.vue': `export default { props: ['address', 'layout'], render: () => null };`,
      '../SettingsScope.vue': `export default { props: ['scope'], render: () => null };`,
      '../DesktopExitSetting.vue': `export default { render: () => null };`,
    },
  });
  const wrapper = mount(Page, {
    attachTo: document.body,
    props: { active: true },
    global: { mocks: { $route: { name: 'settings' } } },
  });

  t.after(() => wrapper.unmount());
  await nextTick();
  await nextTick();

  const fields = [...document.querySelectorAll('[data-ui-settings-field]')];
  const lockField = fields.find((item) => item.textContent.includes('Блокировать приложение'));

  assert.ok(lockField, 'Новая настройка присутствует на реальной странице интерфейса');
});
