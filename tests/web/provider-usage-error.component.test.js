import assert from 'node:assert/strict';
import test from 'node:test';
import { compileModule, loadProductModule, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { api } from '../../web/src/shared/apiClient.ts';

test('W4: ручная ошибка видна выбранному исполнителю и исчезает при успешном повторе', async (t) => {
  await installUiBrowser(t);

  const [{ createPinia, setActivePinia }, { mount, flushPromises }, module, store] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileModule(webFile('src/features/providers/ProviderUsageTransportNotice.vue')),
    loadProductModule('src/stores/providers.ts'),
  ]);
  const pinia = createPinia();

  setActivePinia(pinia);

  const providers = store.useProvidersStore();
  const wrapper = mount(module.default, {
    props: { providerId: 'claude' }, global: { plugins: [pinia] },
  });

  t.after(() => wrapper.unmount());
  providers.applyUsage({ claude: { state: 'ok', bars: [{ key: 'week', pct: 7 }] } }, false, 0);

  let failed = true;

  t.mock.method(api, 'post', async () => {
    if (failed) {
      throw new Error('Синтетический сетевой отказ');
    }

    return {
      autoRefresh: false,
      autoRefreshRevision: 0,
      usage: { claude: { state: 'ok', bars: [{ key: 'week', pct: 9 }] } },
    };
  });
  await providers.refreshUsage('claude');
  await flushPromises();
  assert.match(wrapper.get('[role="alert"]').text(), /Синтетический сетевой отказ/u);
  assert.equal(providers.usage.claude.bars[0].pct, 7);
  await wrapper.setProps({ providerId: 'codex' });
  assert.equal(wrapper.find('[role="alert"]').exists(), false);
  await wrapper.setProps({ providerId: 'claude' });
  failed = false;
  await providers.refreshUsage('claude');
  await flushPromises();
  assert.equal(wrapper.find('[role="alert"]').exists(), false);
  assert.equal(providers.usage.claude.bars[0].pct, 9);
});
