import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeUsageResources } from '../../server/src/lib/providerUsage.ts';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const PROVIDERS_STUB = `
  export const useProvidersStore = () => globalThis.__providerUsageStore;
`;

test('нормализованный тариф рисуется общим компонентом', async (t) => {
  const browser = await installUiBrowser(t);

  globalThis.__providerUsageStore = {
    async runUsageAction() {
      return { ok: true };
    },
  };

  const [{ mount }, Component] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/features/providers/ProviderUsageResources.vue'), {
      stubs: { '../../stores/providers.ts': PROVIDERS_STUB },
    }),
  ]);
  const literal = {
    key: 'tariff',
    label: 'Тариф',
    summary: 'вне пика до пн 13:00',
    note: 'Сайт тарифов недоступен; пик по будням 13:00–17:00 (UTC+7).',
    tone: 'ok',
    controls: [{
      id: 'pricing',
      kind: 'link',
      label: 'Тарифы Z.ai',
      href: 'https://docs.z.ai/devpack/overview',
    }],
  };
  const resources = normalizeUsageResources([literal]);
  const wrapper = mount(Component, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      providerId: 'glm',
      readonly: true,
      resources,
    },
  });

  t.after(() => wrapper.unmount());

  assert.deepEqual(resources, [literal]);
  assert.match(wrapper.text(), /Тариф/u);
  assert.match(wrapper.text(), /вне пика до пн 13:00/u);
  assert.equal(wrapper.get('.usage-resource').classes().includes('is-ok'), true);
  assert.equal(wrapper.find('.usage-resource-note').exists(), false);
  assert.equal(wrapper.find('a').exists(), false);

  await wrapper.setProps({
    resources: normalizeUsageResources([{
      ...literal,
      tone: 'warn',
      summary: 'пик до 17:00',
    }]),
  });

  assert.equal(wrapper.get('.usage-resource').classes().includes('is-warn'), true);
  assert.match(wrapper.text(), /пик до 17:00/u);
  assert.equal(wrapper.find('.usage-resource-note').exists(), false);

  await wrapper.setProps({ readonly: false, resources });

  assert.equal(wrapper.get('.usage-resource-note').text(), literal.note);
  assert.equal(wrapper.get('a').attributes('href'), literal.controls[0].href);
  assert.equal(wrapper.get('a').text(), 'Тарифы Z.ai');

  const changed = 'overview: конец пика на сайте 19:00 — расписание устарело.';

  await wrapper.setProps({
    readonly: true,
    resources: normalizeUsageResources([{
      ...literal,
      tone: 'bad',
      note: changed,
    }]),
  });

  assert.equal(wrapper.get('.usage-resource').classes().includes('is-bad'), true);
  assert.equal(wrapper.get('.usage-resource-note').text(), changed);
  assert.equal(wrapper.find('a').exists(), false);
});
