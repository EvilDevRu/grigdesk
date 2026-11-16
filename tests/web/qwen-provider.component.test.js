import assert from 'node:assert/strict';
import test from 'node:test';

import { directSshSetting } from '../../server/src/lib/executors/_directSshPolicy.ts';
import { qwenServiceCredential } from '../../server/src/lib/qwen/services.ts';
import { providerUsageView } from '../../web/src/features/providers/providerUsage.ts';
import { messages, translate } from '../../shared/i18n/catalogs.ts';
import data from './fixtures/settings-modal/data.json' with { type: 'json' };
import { i18nComponent } from './helpers/i18nComponent.js';

process.env.NODE_ENV = 'test';

/**
 * Собственные подписи берутся из того же общего каталога, который читает проекция.
 * До добавления Qwen fallback позволяет дойти до mounted assertion, а не упасть при импорте.
 */
function qwenEntry() {
  const metadata = messages.ru.settings.builtinProviders.qwen;
  const key = metadata?.credentials?.DASHSCOPE_API_KEY;

  return {
    ...structuredClone(data.providers.providers[0]),
    id: 'qwen',
    name: 'Qwen Code',
    type: 'universal',
    available: true,
    authLabel: Object.values(metadata?.auth ?? {})[0] || 'Настройте API-ключ.',
    settings: [directSshSetting()],
    credentials: [
      {
        env: 'DASHSCOPE_API_KEY',
        kind: 'secret',
        label: key?.label || 'Ключ API',
        hint: key?.hint,
        set: true,
        inFile: true,
        preview: '…6789',
      },
      {
        env: 'CUSTOM_QWEN_ENDPOINT_KEY',
        kind: 'secret',
        label: 'CUSTOM_QWEN_ENDPOINT_KEY',
        set: false,
        inFile: false,
      },
      {
        ...qwenServiceCredential(),
        set: false,
        inFile: false,
        value: null,
      },
    ],
    models: [{ id: 'custom-model(openai)', name: 'Моя внешняя модель' }],
  };
}

test('qwen-ru-en-metadata-and-credential-draft', async (t) => {
  const entry = qwenEntry();
  const writes = [];
  let rejectApply = true;
  const h = await i18nComponent(t, {
    fetch: async (url, init = {}) => {
      if (String(url) === '/api/providers/qwen/credentials') {
        writes.push(JSON.parse(init.body));

        return new Response(JSON.stringify(rejectApply ? { error: 'fixture refusal' } : { ok: true }),
          { status: rejectApply ? 500 : 200 });
      }

      if (String(url) === '/api/providers') {
        return new Response(JSON.stringify({ providers: [entry] }));
      }

      return new Response(JSON.stringify({}));
    },
  });
  const providers = h.module.useProvidersStore(h.pinia);

  providers.providers = [entry];
  providers.loaded = true;
  h.settings.setAuthenticated(true);
  h.settings.requestOpen({ pageId: 'agents.providers', entityId: 'qwen' });

  const wrapper = h.mount(h.module.ProviderPage, {
    attachTo: h.win.document.querySelector('#mount'),
    props: { active: true },
    global: { plugins: [h.pinia] },
  });

  t.after(() => wrapper.unmount());
  await h.flushPromises();
  h.settings.selectPage('agents.providers', 'qwen', 'access');
  await h.flushPromises();

  const input = wrapper.get(`[aria-label="${entry.credentials[0].label}"]`);

  assert.equal(input.element.value, '');
  assert.match(input.attributes('placeholder'), /6789/);
  await input.setValue('synthetic-private-draft');
  await wrapper.get('select[aria-label="Сервис API и регион"]').setValue('qwencloud-intl');
  assert.equal(writes.length, 0);
  assert.equal(JSON.stringify(h.settings.$state).includes('synthetic-private-draft'), false);
  await h.module.localeAdapter.setUiLanguage('en');
  await h.flushPromises();

  const english = h.module.metadataLocale.localizeProviderMetadata(entry, 'en');

  assert.equal(english.settings[0].label, translate('settings.blockDirectSsh', {}, 'en'),
    'Qwen должен участвовать в общей проекции встроенных метаданных');
  assert.doesNotMatch(english.authLabel, /[А-Яа-яЁё]/);
  assert.doesNotMatch(english.credentials[0].label, /[А-Яа-яЁё]/);
  assert.equal(english.credentials[1].label, 'CUSTOM_QWEN_ENDPOINT_KEY');
  assert.equal(english.credentials[2].label, 'API service and region');
  assert.doesNotMatch(english.credentials[2].hint, /[А-Яа-яЁё]/);
  assert.ok(english.credentials[2].options.every((option) => !/[А-Яа-яЁё]/u.test(option.label)));

  const planHint = english.credentials[2].options.find((option) => option.value === 'qwencloud-token').hint;

  assert.match(planHint, /Individual Plan.*qwencloud.com/);
  assert.doesNotMatch(planHint, /[А-Яа-яЁё]/u);
  assert.equal(wrapper.get('select[aria-label="API service and region"]').element.value,
    'qwencloud-intl', 'Смена языка сохраняет выбранный сервис');
  assert.equal(english.models[0].name, 'Моя внешняя модель');
  assert.equal(wrapper.get(`[aria-label="${english.credentials[0].label}"]`).element.value,
    'synthetic-private-draft', 'Смена языка сохраняет приватный draft');
  await h.settings.apply();
  assert.equal(h.settings.snapshot.dirtyCount, 2);
  assert.match(wrapper.text(), /fixture refusal/);
  rejectApply = false;
  await h.settings.apply();
  assert.deepEqual(writes.at(-1), { values: {
    DASHSCOPE_API_KEY: 'synthetic-private-draft',
    GRIGDESK_QWEN_SERVICE: 'qwencloud-intl',
  } });
  await h.module.localeAdapter.setUiLanguage('ru');
  await h.flushPromises();
  assert.equal(entry.credentials[1].label, 'CUSTOM_QWEN_ENDPOINT_KEY');
  h.settings.dispose();
  assert.equal(h.settings.getValue('providerCredentials:qwen', 'DASHSCOPE_API_KEY'), undefined);
});

test('qwen-quota-message-describes-integration-support-in-both-languages', () => {
  const message = messages.ru.settings.builtinProviderText.qwen.quotaUnsupported;
  const view = providerUsageView({ state: 'unsupported', message }, { id: 'qwen' }, 'en');

  assert.equal(view.message, messages.en.settings.builtinProviderText.qwen.quotaUnsupported);
  assert.deepEqual(view.bars, []);
  assert.doesNotMatch(view.message, /CLI/);
});

test('Qwen Host: ручное подтверждение, Apply, отказ и повтор на английском', async (t) => {
  const entry = qwenEntry();
  const writes = [];
  let refusing = true;

  entry.settings.push({
    id: 'allowHostAccess',
    kind: 'toggle',
    value: false,
    label: 'Режим «Хост»',
    confirm: { on: {
      text: 'Доступ к хосту',
      label: 'Включить',
      danger: true,
    } },
  });

  const h = await i18nComponent(t, {
    fetch: async (url, init = {}) => {
      if (String(url) === '/api/providers/qwen/settings' && init.method === 'POST') {
        const body = JSON.parse(init.body);

        writes.push(body);

        if (refusing) {
          return new Response(JSON.stringify({ error: 'fixture Host refusal' }), { status: 500 });
        }

        entry.settings.at(-1).value = true;

        // Серверный контракт saveSetting: ответ несёт обновлённый массив settings,
        // иначе сессия не получает подтверждённое значение и сохраняет dirty.
        return new Response(JSON.stringify({ ok: true, settings: entry.settings }));
      }

      return new Response(JSON.stringify(String(url) === '/api/providers' ? { providers: [entry] } : {}));
    },
  });
  const providers = h.module.useProvidersStore(h.pinia);

  providers.providers = [entry];
  providers.loaded = true;
  h.settings.setAuthenticated(true);
  h.settings.requestOpen({ pageId: 'agents.providers', entityId: 'qwen' });

  const page = h.mount(h.module.ProviderPage, {
    attachTo: h.win.document.querySelector('#mount'),
    props: { active: true },
    global: { plugins: [h.pinia] },
  });
  const dialog = h.mount(h.module.UiDialogHost, {
    attachTo: h.win.document.body,
    global: { plugins: [h.pinia] },
  });

  t.after(() => {
    dialog.unmount();
    page.unmount();
  });
  await h.flushPromises();
  h.settings.selectPage('agents.providers', 'qwen', 'parameters');
  await h.flushPromises();

  const toggle = page.get('[data-ordinary="allowHostAccess"] [role="switch"]');

  await toggle.setValue(true);
  await h.flushPromises();
  assert.match(h.win.document.body.textContent, /Docker/);

  const cancel = [...h.win.document.querySelectorAll('.ui-dialog-host__actions button')][0];

  cancel.click();
  await h.flushPromises();
  assert.equal(h.settings.getIntent('providerSettings:qwen', 'allowHostAccess'), undefined);
  assert.equal(writes.length, 0);
  await h.module.localeAdapter.setUiLanguage('en');
  await h.flushPromises();
  assert.match(page.text(), /Host mode/);
  await toggle.setValue(true);
  await h.flushPromises();
  assert.match(h.win.document.body.textContent, /Enable Host mode/);

  const accept = [...h.win.document.querySelectorAll('.ui-dialog-host__actions button')].at(-1);

  accept.click();
  await h.flushPromises();
  assert.equal(writes.length, 0, 'Подтверждение изменяет draft, не сохраняет преждевременно');
  await h.settings.apply();
  assert.match(page.text(), /fixture Host refusal/);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    settingId: 'allowHostAccess',
    value: true,
    confirmed: true,
  });
  refusing = false;
  await h.settings.apply();
  await h.flushPromises();
  assert.equal(writes.length, 2);
  assert.equal(h.settings.snapshot.dirtyCount, 0);
});
