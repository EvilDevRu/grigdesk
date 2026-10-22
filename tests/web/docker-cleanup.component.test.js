import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const CLEANUP = webFile('src/views/docker/DockerCleanup.vue');

// Публичную границу UI подменяем целиком, но настоящими примитивами: подделать нужно
// только диалог подтверждения, иначе тест проверял бы не панель, а свои же заглушки.
const UI_STUB = `
export { default as UiButton } from '${webFile('src/components/primitives/UiButton.vue')}';
export { default as UiCheckbox } from '${webFile('src/components/primitives/UiCheckbox.vue')}';
export { default as UiInlineMessage } from '${webFile('src/components/feedback/UiInlineMessage.vue')}';
export const confirmDialog = async (text, options) => {
  globalThis.__dockerCleanupHarness.confirmations.push({ text, options });
  return globalThis.__dockerCleanupHarness.confirmed;
};
`;

const USAGE = {
  source: 'daemon',
  computedAt: new Date().toISOString(),
  cached: false,
  containers: { total: 57, active: 19, stopped: 38, size: 8_364_523_520, reclaimable: 4_768_522_240 },
  images: {
    total: 94,
    active: 33,
    unused: 63,
    size: 163_228_287_579,
    reclaimable: 32_738_110_530,
    dangling: { count: 4, size: 1_073_741_824 },
  },
  volumes: { total: 39, active: 13, unused: 26, size: 38_716_134_211, reclaimable: 17_045_713_529 },
  networks: { total: 17, unused: 4 },
  buildCache: { total: 833, size: 115_043_895_109, reclaimable: 38_546_998_304 },
};

/**
 * Панель уборки монтируется с двойниками стора и плагинов: проверяется решение
 * интерфейса («что предложено удалить и что обещано вернуть»), а не сетевой слой.
 */
async function mountCleanup(t, { values = {}, prune = async () => ({ ok: true, report: {} }) } = {}) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/docker');
  const pruneCalls = [];
  globalThis.__dockerCleanupHarness = {
    store: {
      usage: USAGE,
      usageLoading: false,
      usageError: '',
      loadUsage: async () => {},
      prune: async (input) => {
        pruneCalls.push(input);
        return prune(input);
      },
    },
    plugins: { byId: () => ({ id: 'docker', values }) },
    confirmed: true,
    confirmations: [],
  };
  const component = await compileVue(CLEANUP, {
    stubs: {
      '../../stores/docker': 'export const useDockerStore = () => globalThis.__dockerCleanupHarness.store;',
      '../../stores/plugins.ts': (
        'export const usePluginsStore = () => globalThis.__dockerCleanupHarness.plugins;'
      ),
      '../../ui': (UI_STUB) +
        "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
    },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, { attachTo: browser.document.querySelector('#mount') });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__dockerCleanupHarness;
  });
  await flushPromises();

  return { wrapper, flushPromises, pruneCalls };
}

test('очистка томов недоступна, пока она не разрешена настройками плагина', async (t) => {
  const { wrapper } = await mountCleanup(t);

  const rows = wrapper.findAll('tbody tr');
  const volumes = rows.find((row) => row.text().includes('Неиспользуемые тома'));
  assert.ok(volumes, 'строка про тома должна быть на экране, а не спрятана');
  assert.equal(volumes.get('input[type="checkbox"]').attributes('disabled'), '');
  assert.match(volumes.text(), /выключено в настройках плагина/u);
  assert.match(wrapper.text(), /Снос всех неиспользуемых включается/u);
});

test('образы по умолчанию обещают только висячие, а с разрешением — все неиспользуемые', async (t) => {
  const { wrapper, flushPromises } = await mountCleanup(t, { values: { allowImagePruneAll: true } });

  const imagesRow = () => wrapper.findAll('tbody tr')
    .find((row) => row.text().includes('Образы'));
  assert.match(imagesRow().text(), /4 без тегов из 94/u);
  assert.match(imagesRow().text(), /1\.0 ГБ/u, 'обещано ровно то, что даст очистка висячих');

  const allImages = wrapper.findAll('input[type="checkbox"]').at(-1);
  await allImages.setValue(true);
  await flushPromises();

  assert.match(imagesRow().text(), /63 неиспользуемых/u);
  assert.match(imagesRow().text(), /30\.5 ГБ/u, 'цифра берётся у демона, а не складывается по образам');
});

test('подтверждение перечисляет удаляемое, и только после него уборка уходит на сервер', async (t) => {
  const { wrapper, flushPromises, pruneCalls } = await mountCleanup(t, {
    prune: async () => ({ ok: true, report: { buildCache: { removed: 800, freed: 38_546_998_304 } } }),
  });

  const cache = wrapper.findAll('tbody tr').find((row) => row.text().includes('Кэш сборки'));
  await cache.get('input[type="checkbox"]').setValue(true);
  await flushPromises();

  assert.match(wrapper.text(), /Вернётся примерно 35\.9 ГБ/u);

  const clean = () => wrapper.findAll('button')
    .find((item) => item.text().includes('Очистить выбранное'));

  globalThis.__dockerCleanupHarness.confirmed = false;
  await clean().trigger('click');
  await flushPromises();
  assert.equal(pruneCalls.length, 0, 'отказ в диалоге не должен ничего удалять');

  globalThis.__dockerCleanupHarness.confirmed = true;
  await clean().trigger('click');
  await flushPromises();

  assert.deepEqual(pruneCalls, [{ targets: ['buildCache'], allImages: false }]);
  const question = globalThis.__dockerCleanupHarness.confirmations.at(-1);
  assert.match(question.text, /Кэш сборки/u, 'человек видит поимённо, что исчезнет');
  assert.match(question.text, /35\.9 ГБ/u);
  assert.equal(question.options.danger, true);
  assert.match(wrapper.text(), /Удалено объектов: 800, освобождено 35\.9 ГБ/u);
  assert.equal(cache.get('input[type="checkbox"]').element.checked, false,
    'после уборки выбор сбрасывается, чтобы повтор не случился нечаянно');
});

test('пустой выбор не даёт нажать «Очистить»', async (t) => {
  const { wrapper } = await mountCleanup(t);

  const button = wrapper.findAll('button').find((item) => item.text().includes('Очистить выбранное'));
  assert.ok(button);
  assert.equal(button.attributes('disabled'), '');
});
