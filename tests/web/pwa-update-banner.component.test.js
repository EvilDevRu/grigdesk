import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const STORE_KEY = '__cockpitPwaUpdateBannerStore';

/**
 * Монтирует уведомление с управляемым PWA-store, не обращаясь к настоящему service worker.
 * Глобальная ссылка нужна скомпилированному data-модулю и удаляется вместе с тестом.
 */
async function mountBanner(t, { standalone = false } = {}) {
  const browser = await installUiBrowser(t);
  const [{ reactive }, { mount }] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
  ]);
  const calls = { updates: 0 };
  const pwa = reactive({
    needRefresh: false,
    updating: false,
    doUpdate() {
      calls.updates += 1;
    },
  });

  globalThis[STORE_KEY] = pwa;
  t.after(() => {
    delete globalThis[STORE_KEY];
  });

  const UpdateBanner = await compileVue(webFile('src/features/pwa/UpdateBanner.vue'), {
    stubs: {
      '../../stores/pwa.js': [
        `const pwa = globalThis[${JSON.stringify(STORE_KEY)}];`,
        'export const usePwaStore = () => pwa;',
      ].join('\n'),
    },
  });
  const wrapper = mount(UpdateBanner, {
    attachTo: browser.document.querySelector('#mount'),
    props: { standalone },
  });

  t.after(() => wrapper.unmount());

  return { calls, pwa, wrapper };
}

test('PWA-UPDATE-01: уведомление появляется только для ожидающего обновления', async (t) => {
  const { pwa, wrapper } = await mountBanner(t);

  assert.equal(wrapper.find('.update-notice').exists(), false);

  pwa.needRefresh = true;
  await wrapper.vm.$nextTick();

  assert.equal(wrapper.get('.update-action-label').text(), 'Доступно обновление');
  assert.doesNotMatch(wrapper.text(), /кокпит/i);
  assert.equal(wrapper.get('.update-notice').attributes('role'), 'status');
});

test('PWA-UPDATE-02: кнопка применяет обновление и показывает занятое состояние', async (t) => {
  const { calls, pwa, wrapper } = await mountBanner(t);

  pwa.needRefresh = true;
  await wrapper.vm.$nextTick();
  await wrapper.get('.update-action').trigger('click');

  assert.equal(calls.updates, 1);

  pwa.updating = true;
  await wrapper.vm.$nextTick();
  assert.equal(wrapper.get('.update-action').attributes('aria-busy'), 'true');
});

test('PWA-UPDATE-03: рабочая версия живёт в топбаре, а вход сохраняет самостоятельную полосу', async (t) => {
  const { pwa, wrapper } = await mountBanner(t, { standalone: true });

  pwa.needRefresh = true;
  await wrapper.vm.$nextTick();
  assert.ok(wrapper.get('.update-notice').classes('is-standalone'));

  const [app, shell] = await Promise.all([
    readFile(webFile('src/App.vue'), 'utf8'),
    readFile(webFile('src/shared/layout/AppShell.vue'), 'utf8'),
  ]);
  const topbar = shell.slice(shell.indexOf('<header class="topbar">'), shell.indexOf('</header>'));

  assert.match(topbar, /<UpdateBanner\s*\/>/);
  assert.ok(
    topbar.indexOf('<UpdateBanner />') < topbar.indexOf('<div class="status">'),
    'уведомление стоит в левой группе до системных метрик',
  );
  assert.match(app, /<UpdateBanner v-if="!auth\.authenticated" standalone \/>/);
});

test('PWA-UPDATE-04: на планшете действие в топбаре сокращается до иконки', async () => {
  const source = await readFile(webFile('src/features/pwa/UpdateBanner.vue'), 'utf8');

  assert.match(
    source,
    /@media \(max-width: 1099px\)[\s\S]*\.update-notice:not\(\.is-standalone\) \.update-action-label/u,
  );
});
