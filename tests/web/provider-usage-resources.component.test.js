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

test('Карточки Kimi и Codex видны в обоих режимах, ссылки остаются только в настройках', async (t) => {
  await installUiBrowser(t);

  globalThis.__providerUsageStore = {
    async runUsageAction() {
      return { ok: true };
    },
  };

  const [{ mount }, ProviderUsageResources, kimi, codex] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/features/providers/ProviderUsageResources.vue'), {
      stubs: {
        '../../stores/providers.ts': PROVIDERS_STUB,
      },
    }),
    import('../../server/src/lib/kimi/usage.ts'),
    import('../../server/src/lib/executors/codex.ts'),
  ]);
  const cases = [
    {
      providerId: 'kimi',
      resources: kimi.parseKimiUsageResources({
        kind: 'ok',
        summary: { used: 40, limit: 100 },
        extra_usage: null,
      }),
      summaries: ['Extra Usage', 'Не включено или не пополнено',
        'Месячный объём', 'Kimi не сообщает остаток'],
      href: 'https://www.kimi.com/code/console',
    },
    {
      providerId: 'codex',
      resources: codex.parseCodexUsageResources({
        rateLimits: { primary: { usedPercent: 40 }, credits: null },
      }),
      summaries: ['Дополнительные кредиты', 'Нет данных о кредитах'],
      href: 'https://chatgpt.com/codex/settings/usage',
    },
  ];

  for (const { providerId, resources, summaries, href } of cases) {
    const wrapper = mount(ProviderUsageResources, {
      props: {
        providerId,
        resources,
        readonly: true,
      },
    });

    t.after(() => wrapper.unmount());

    for (const summary of summaries) {
      assert.ok(wrapper.text().includes(summary), summary);
    }

    assert.equal(wrapper.findAll('.usage-resource.is-muted').length, resources.length);
    assert.equal(wrapper.findAll('.usage-resource-bar').length, 0);
    assert.equal(wrapper.findAll('a, button, input').length, 0);

    await wrapper.setProps({ readonly: false });

    const links = wrapper.findAll('a');

    assert.equal(links.length, resources.length);
    assert.ok(links.every((link) => link.attributes('href') === href));
    assert.equal(wrapper.findAll('button, input').length, 0);

    if (providerId === 'kimi') {
      assert.ok(links.some((link) => link.text() === 'Включить и пополнить в Kimi'));
    }
  }
});
