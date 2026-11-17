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
  capabilities: ['notify'],
};

test('фоновая связь: снимок публикует блок, повреждённый блок не становится настройкой', () => {
  const store = useShellStore(createPinia());

  store.apply({
    ...base,
    backgroundLink: {
      enabled: true,
    },
  });
  assert.deepEqual(store.backgroundLink, {
    enabled: true,
  });

  for (const broken of ['enabled', 42, null, {
    enabled: 'yes',
  }, {
    enabled: true,
    extra: 1,
  }]) {
    store.apply({
      ...base,
      rev: 4,
      backgroundLink: broken,
    });
    assert.equal(store.backgroundLink, null, 'Повреждённый блок не становится настройкой');
  }

  store.apply(base);
  assert.equal(store.backgroundLink, null);
});

const snapshotWithLink = {
  ...base,
  backgroundLink: {
    enabled: false,
  },
};

/**
 * Компонент загружается после установки общего DOM, чтобы Vue сохранил правильный document.
 * Каждый вызов получает отдельный стор над текущей Pinia, не наследуя прежний тест.
 */
async function mountSetting() {
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const Setting = await compileVue(webFile('src/views/settings/AndroidBackgroundLinkSetting.vue'), {});

  return {
    nextTick,
    wrapper: mount(Setting, { attachTo: document.body }),
  };
}

test('тумблер фоновой связи: сохранение, busy, отказ и скрытие без блока', async (t) => {
  const saved = globalThis.fetch;

  t.after(() => globalThis.fetch = saved);

  setActivePinia(createPinia());

  const store = useShellStore();

  store.apply(snapshotWithLink);

  const { nextTick, wrapper } = await mountSetting();

  t.after(() => wrapper.unmount());
  await nextTick();

  const field = document.querySelector('[data-ui-settings-field]');

  assert.match(field.textContent, /Оповещения в фоне/);

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
    url: '/__shell/background-link',
    body: {
      enabled: true,
    },
  });
  assert.equal(current.disabled, true, 'Повторное изменение ждёт принятый снимок');

  rejectSave(new Error('Отказ сохранения'));
  await new Promise((resolve) => setImmediate(resolve));
  await nextTick();

  assert.match(field.textContent, /Отказ сохранения/);
  assert.equal(current.checked, false, 'После отказа возвращается принятое значение');

  globalThis.fetch = async (url, options) => {
    calls.push({
      url,
      body: JSON.parse(options.body),
    });

    return Response.json({
      ...snapshotWithLink,
      rev: 4,
      backgroundLink: {
        enabled: JSON.parse(options.body).enabled,
      },
    });
  };

  current.click();
  await new Promise((resolve) => setImmediate(resolve));
  await nextTick();

  assert.equal(store.backgroundLink.enabled, true);
  assert.equal(current.checked, true);

  wrapper.unmount();
  store.apply({
    ...base,
    rev: 5,
  });

  const bare = await mountSetting();

  t.after(() => bare.wrapper.unmount());
  await bare.nextTick();

  assert.equal(document.querySelector('[data-ui-settings-field]') === null, true,
    'Оболочка без блока не показывает настройку');
});
