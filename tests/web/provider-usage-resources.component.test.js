import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const PROVIDERS_STUB = `
  export const useProvidersStore = () => globalThis.__providerUsageStore;
`;

function button(wrapper, label) {
  return wrapper.findAll('button').find((entry) => entry.text() === label);
}

test('provider resource подтверждает number-action через UiInlineConfirm', async (t) => {
  const browser = await installUiBrowser(t);
  const calls = [];

  globalThis.__providerUsageStore = {
    async runUsageAction(...args) {
      calls.push(args);

      return { ok: true };
    },
  };

  const [{ mount, flushPromises }, ProviderUsageResources] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/features/providers/ProviderUsageResources.vue'), {
      stubs: {
        '../../stores/providers.js': PROVIDERS_STUB,
      },
    }),
  ]);
  const wrapper = mount(ProviderUsageResources, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      providerId: 'kimi',
      resources: [{
        key: 'balance',
        label: 'Баланс',
        summary: '10 CNY',
        controls: [{
          id: 'limit',
          kind: 'number',
          label: 'Лимит',
          value: 5,
          unit: 'CNY',
          action: 'set-limit',
          field: 'limit',
          minExclusive: 0,
          confirm: {
            text: 'Установить {value} {unit}?',
            label: 'Установить',
          },
        }],
      }],
    },
  });

  t.after(() => wrapper.unmount());

  await wrapper.get('input').setValue('12,5');
  await button(wrapper, 'Сохранить').trigger('click');

  assert.match(wrapper.text(), /Установить 12.5 CNY/);

  await button(wrapper, 'Установить').trigger('click');
  await flushPromises();

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'kimi');
  assert.equal(calls[0][1], 'set-limit');
  assert.deepEqual(calls[0][2], { limit: 12.5 });
  assert.equal(typeof calls[0][3], 'string');
  assert.doesNotMatch(wrapper.text(), /Установить 12.5 CNY/);
});
