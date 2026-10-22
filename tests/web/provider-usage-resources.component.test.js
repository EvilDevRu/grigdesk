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
        '../../stores/providers.ts': PROVIDERS_STUB,
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

// Доплата — деньги аккаунта: её меняют в плашке настроек, а всплывашка топбара про
// неё только рассказывает. Живая операция исполнителя (`scope: 'live'`) остаётся
// кнопкой: она отвечает на «что делать сейчас» там же, где видно состояние.
test('readonly не отражает ручки аккаунта и оставляет живую операцию кнопкой', async (t) => {
  const browser = await installUiBrowser(t);
  const calls = [];

  globalThis.__providerUsageStore = {
    async runUsageAction(...args) {
      calls.push(args);

      return { ok: true };
    },
  };

  const [{ mount }, ProviderUsageResources] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/features/providers/ProviderUsageResources.vue'), {
      stubs: {
        '../../stores/providers.ts': PROVIDERS_STUB,
      },
    }),
  ]);
  const wrapper = mount(ProviderUsageResources, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      providerId: 'claude',
      readonly: true,
      resources: [
        {
          key: 'extra-usage',
          label: 'Extra usage (доплата)',
          summary: 'выключено',
          controls: [
            {
              id: 'extra-usage-toggle',
              kind: 'toggle',
              label: 'доплата выключена',
              value: false,
              action: 'configure-extra-usage',
              field: 'enabled',
            },
            {
              id: 'extra-usage-limit',
              kind: 'number',
              label: 'потолок',
              value: 20,
              unit: 'USD',
              action: 'configure-extra-usage',
              field: 'limit',
            },
            {
              id: 'manage-extra-usage',
              kind: 'link',
              label: 'Карта и история — на claude.ai',
              href: 'https://claude.ai/settings/usage',
            },
          ],
        },
        {
          key: 'loaded-1',
          label: 'qwen3:latest',
          summary: 'в видеопамяти',
          controls: [{
            id: 'unload',
            kind: 'button',
            scope: 'live',
            label: 'Выгрузить из памяти',
            action: 'unload-model',
            confirm: { text: 'Выгрузить модель?', label: 'Выгрузить' },
          }],
        },
      ],
    },
  });

  t.after(() => wrapper.unmount());

  assert.equal(wrapper.findAll('.ui-switch').length, 0);
  assert.equal(wrapper.findAll('input').length, 0);
  assert.equal(wrapper.findAll('a').length, 0);
  // Состояние ручек во всплывашке не отражается вовсе: на «включено или нет» уже
  // ответила сводка ресурса, и вторая строка о том же только занимала место.
  assert.match(wrapper.text(), /выключено/);
  assert.doesNotMatch(wrapper.text(), /доплата выключена/);
  assert.doesNotMatch(wrapper.text(), /потолок: 20 USD/);
  assert.ok(button(wrapper, 'Выгрузить из памяти'));
});

// Заметка ресурса — то место, где сервис объясняет, почему работа встанет. Во
// всплывашке она остаётся только у беды: спокойный «причина отказа: out_of_credits»
// повторял сводку, а «сверх лимитов подписки работа не пойдёт» терять нельзя.
test('readonly оставляет заметку только у беды', async (t) => {
  const browser = await installUiBrowser(t);

  globalThis.__providerUsageStore = { async runUsageAction() { return { ok: true }; } };

  const [{ mount }, ProviderUsageResources] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/features/providers/ProviderUsageResources.vue'), {
      stubs: {
        '../../stores/providers.ts': PROVIDERS_STUB,
      },
    }),
  ]);
  const resources = [
    {
      key: 'quiet',
      label: 'Extra usage (доплата)',
      summary: 'выключено',
      tone: 'muted',
      note: 'Причина отказа: out_of_credits',
      controls: [],
    },
    {
      key: 'blocking',
      label: 'Extra usage (доплата)',
      summary: '20 из 20 USD',
      tone: 'bad',
      note: 'Месячный потолок доплаты выбран — сверх лимитов подписки работа не пойдёт.',
      controls: [],
    },
  ];
  const popover = mount(ProviderUsageResources, {
    attachTo: browser.document.querySelector('#mount'),
    props: { providerId: 'claude', readonly: true, resources },
  });

  t.after(() => popover.unmount());

  assert.doesNotMatch(popover.text(), /out_of_credits/);
  assert.match(popover.text(), /работа не пойдёт/);

  const settings = mount(ProviderUsageResources, {
    props: { providerId: 'claude', resources },
  });

  t.after(() => settings.unmount());

  // В плашке настроек причина отказа остаётся: там её читают, когда доплата не включается.
  assert.match(settings.text(), /out_of_credits/);
});
