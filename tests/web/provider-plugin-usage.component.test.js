import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const RESOURCE = {
  key: 'forecast',
  label: 'Прогноз · 24 / 48 ч',
  summary: '0 % / 50 %',
  note: 'Оценка codexreset.org, не гарантия сброса.',
  translations: { en: { label: 'Forecast · 24 / 48 h', note: 'Experimental estimate.' } },
  controls: [{
    id: 'source',
    kind: 'link',
    label: 'codexreset.org',
    href: 'https://codexreset.org/',
  }],
};

function plugin(id = 'feed') {
  return {
    id,
    name: id,
    version: '0.1.1',
    enabled: true,
    placements: [{ slot: 'provider.popover.after-bars', enabled: true }],
  };
}

/**
 * Подменяет каталог и API данных, сохраняя настоящие компоненты Vue/UI.
 * Так проверяется путь от объявления фонового плагина до строки в popup.
 */
async function fixture(t, get, list = [plugin()], clock = false) {
  const browser = await installUiBrowser(t);
  const [{ mount, flushPromises, reactive }, Component] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs')
      .then(async (utils) => ({ ...utils, ...await import('../../web/node_modules/vue/index.mjs') })),
    compileVue(webFile('src/features/providers/ProviderUsagePlugins.vue'), {
      expose: ["setLocale: async (value) => (await import('../../ui.ts')).setUiLocale(value)"],
      stubs: {
        '../../stores/plugins.ts': 'export const usePluginsStore = () => globalThis.__providerPlugins;',
        '../../stores/providers.ts': 'export const useProvidersStore = () => ({});',
        '../../shared/apiClient.ts': `
          export const api = {get: (...args) => globalThis.__providerPluginGet(...args)};
        `,
      },
    }),
  ]);
  const calls = [];

  globalThis.__providerPlugins = reactive({
    loaded: true,
    list,
    placementEnabled(id, slot) {
      return this.list.find((entry) => entry.id === id)?.placements
        ?.some((entry) => entry.slot === slot && entry.enabled);
    },
  });
  globalThis.__providerPluginGet = (...args) => {
    calls.push(args);

    return get(...args);
  };

  if (clock) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
  }

  const wrapper = mount(Component, {
    attachTo: browser.document.querySelector('#mount'),
    props: { providerId: 'codex' },
  });

  t.after(() => wrapper.unmount());
  await flushPromises();

  return {
    wrapper,
    calls,
    flushPromises,
    store: globalThis.__providerPlugins,
  };
}

test('popup показывает только объявленный фоновый источник, ссылку, оговорку и язык', async (t) => {
  const f = await fixture(t, async () => ({ resources: [RESOURCE] }), [
    plugin(),
    { ...plugin('disabled'), enabled: false },
    { ...plugin('page'), web: '/web/' },
    { ...plugin('module'), webModule: {} },
    { ...plugin('without-slot'), placements: [] },
  ]);

  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], '/api/ext/feed/provider-usage?providerId=codex');
  assert.match(f.wrapper.text(), /Прогноз · 24 \/ 48 ч/);
  assert.match(f.wrapper.text(), /0 % \/ 50 %/);
  assert.match(f.wrapper.text(), /не гарантия/);
  assert.equal(f.wrapper.get('a').attributes('href'), 'https://codexreset.org/');

  await f.wrapper.vm.setLocale('en');
  await f.flushPromises();

  assert.match(f.wrapper.text(), /Forecast · 24 \/ 48 h/);
  assert.match(f.wrapper.text(), /Experimental estimate/);
  assert.equal(f.calls.length, 1);
});

test('выключение и закрытие popup отменяют чтение и не принимают поздний ответ', async (t) => {
  const response = Promise.withResolvers();
  const f = await fixture(t, () => response.promise);
  const signal = f.calls[0][1].signal;

  f.store.list[0].enabled = false;
  await f.flushPromises();
  assert.equal(signal.aborted, true);
  response.resolve({ resources: [RESOURCE] });
  await f.flushPromises();
  assert.equal(f.wrapper.text(), '');

  f.store.list[0].enabled = true;
  await f.flushPromises();

  const resumed = f.calls[1][1].signal;

  f.wrapper.unmount();
  assert.equal(resumed.aborted, true);
});

test('отказ API сохраняет прошлые цифры с видимой пометкой о давности', async (t) => {
  let count = 0;
  const f = await fixture(t, async () => {
    count += 1;

    if (count > 1) {
      throw new Error('private transport detail');
    }

    return { resources: [RESOURCE] };
  }, [plugin()], true);

  await f.wrapper.vm.setLocale('ru');
  t.mock.timers.tick(60_000);
  await f.flushPromises();

  assert.equal(count, 2);
  assert.match(f.wrapper.text(), /0 % \/ 50 %/);
  assert.match(f.wrapper.text(), /устарел/i);
  assert.match(f.wrapper.text(), /не гарантия/);
  assert.doesNotMatch(f.wrapper.text(), /private transport detail/);
});
