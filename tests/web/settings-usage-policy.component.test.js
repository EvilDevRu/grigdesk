import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

test('U1: один общий switch, default false, Apply и повторное открытие', async (t) => {
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    entityId: 'fixture',
  });
  const selector = '[aria-label="Автообновление квот"]';

  assert.equal(h.wrapper.findAll(selector).length, 1);
  assert.equal(h.wrapper.get(selector).attributes('aria-checked'), 'false');
  await h.wrapper.get(selector).trigger('click');
  assert.equal(h.writes().length, 0);
  assert.equal(h.settings.snapshot.dirtyCount, 1);
  await h.settings.apply();
  assert.deepEqual(h.writes().map((call) => call.body), [{ providerUsageAutoRefresh: true }]);
  assert.equal(h.settings.snapshot.dirtyCount, 0);
  h.settings.requestClose();
  h.settings.requestOpen({ pageId: 'agents.providers', entityId: 'fixture' });
  await h.flushPromises();
  assert.equal(h.wrapper.get(selector).attributes('aria-checked'), 'true');
  assert.equal(h.wrapper.findAll(selector).length, 1);
  h.settings.selectPage('agents.providers', 'three-d', 'overview');
  await h.flushPromises();
  assert.equal(h.wrapper.findAll(selector).length, 1);
  assert.equal(h.wrapper.get(selector).attributes('aria-checked'), 'true');
});

test('U2: отказ Apply сохраняет switch и позволяет повтор', async (t) => {
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    entityId: 'fixture',
  });

  await h.wrapper.get('[aria-label="Автообновление квот"]').trigger('click');
  h.control.handlers['/api/settings/prefs'] = () =>
    new Response(JSON.stringify({ message: 'Синтетический отказ' }), { status: 500 });
  await h.settings.apply('ok');
  assert.equal(h.settings.isOpen, true);
  assert.equal(h.settings.snapshot.dirtyCount, 1);
  assert.match(h.wrapper.text(), /Синтетический отказ/u);
  delete h.control.handlers['/api/settings/prefs'];
  await h.settings.apply();
  assert.equal(h.control.data.prefs.providerUsageAutoRefresh, true);
  assert.equal(h.settings.snapshot.dirtyCount, 0);
});

test('U3: чтение prefs повторяется после ошибки, форма переводится в EN', async (t) => {
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    entityId: 'fixture',
    prepare({ control }) {
      control.handlers['/api/settings/prefs'] = () =>
        new Response(JSON.stringify({ message: 'Настройки недоступны' }), { status: 500 });
    },
  });

  assert.match(h.wrapper.text(), /Настройки недоступны/u);
  assert.equal(h.wrapper.find('[aria-label="Автообновление квот"]').exists(), false);
  delete h.control.handlers['/api/settings/prefs'];
  await h.wrapper.get('[data-usage-prefs-retry]').trigger('click');
  await h.flushPromises();
  assert.equal(h.wrapper.get('[aria-label="Автообновление квот"]').attributes('aria-checked'), 'false');
  h.module.setUiLocale('en');
  t.after(() => h.module.setUiLocale('ru'));
  await h.flushPromises();
  assert.equal(h.wrapper.get('[aria-label="Refresh quotas automatically"]').exists(), true);
  assert.equal(h.writes().length, 0);
});

test('U4: поздний prefs ACK не откатывает более новую политику SSE', async (t) => {
  let enter;
  let finish;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const response = new Promise((resolve) => {
    finish = resolve;
  });
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    entityId: 'fixture',
    prepare({ control }) {
      control.data.prefs.providerUsageAutoRefresh = false;
      control.data.prefs.providerUsagePolicyRevision = 0;
      control.handlers['/api/settings/prefs'] = ({ method }) => {
        if (method === 'POST') {
          enter();

          return response;
        }

        return new Response(JSON.stringify(control.data.prefs));
      };
    },
  });

  t.after(() => finish(new Response(JSON.stringify(h.control.data.prefs))));
  await h.wrapper.get('[aria-label="Автообновление квот"]').trigger('click');

  const applying = h.settings.apply();

  await entered;
  h.control.data.prefs.providerUsageAutoRefresh = false;
  h.control.data.prefs.providerUsagePolicyRevision = 2;
  h.providers.applyUsage({ fixture: { state: 'ok', bars: [] } }, false, 2);
  await h.flushPromises();
  finish(new Response(JSON.stringify({
    ...h.control.data.prefs,
    providerUsageAutoRefresh: true,
    providerUsagePolicyRevision: 1,
  })));
  await applying;
  await h.flushPromises();
  assert.equal(h.providers.usageAutoRefresh, false);
  assert.equal(h.providers.usagePolicyRevision, 2);
  assert.equal(h.wrapper.get('[aria-label="Автообновление квот"]').attributes('aria-checked'), 'false');
});

test('U5: две открытые формы получают общий выбор и сохраняют dirty-конфликт', async (t) => {
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    entityId: 'fixture',
    prepare({ control }) {
      control.data.prefs.providerUsageAutoRefresh = false;
      control.data.prefs.providerUsagePolicyRevision = 0;
      control.handlers['/api/settings/prefs'] = ({ method, body }) => {
        if (method === 'POST') {
          const changed = body.providerUsageAutoRefresh !== control.data.prefs.providerUsageAutoRefresh;

          Object.assign(control.data.prefs, body);
          control.data.prefs.providerUsagePolicyRevision += changed ? 1 : 0;
        }

        return new Response(JSON.stringify(control.data.prefs));
      };
    },
  });
  const { createPinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');
  const { mount } =
    await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const { routerKey, routeLocationKey } =
    await import('../../web/node_modules/vue-router/dist/vue-router.mjs');
  const secondPinia = createPinia();
  const secondSettings = h.module.useSettingsStore(secondPinia);
  const secondProviders = h.module.useProvidersStore(secondPinia);

  secondProviders.providers = JSON.parse(JSON.stringify(h.providers.providers));
  secondProviders.loaded = true;
  secondSettings.setAuthenticated(true);
  secondSettings.requestOpen({ pageId: 'agents.providers', entityId: 'fixture' });

  const second = mount(h.module.ProviderPage, {
    attachTo: h.browser.document.body,
    props: { active: true },
    global: {
      plugins: [secondPinia],
      provide: {
        [routeLocationKey]: { meta: {}, params: {} },
        [routerKey]: { push: async () => {} },
      },
    },
  });

  t.after(() => {
    second.unmount();
    secondSettings.dispose();
  });
  await h.flushPromises();
  await h.wrapper.get('[aria-label="Автообновление квот"]').trigger('click');
  await h.settings.apply();

  const writes = h.writes().length;

  secondProviders.applyUsage({ fixture: { state: 'ok', bars: [] } }, true, 1);
  await h.flushPromises();
  assert.equal(second.get('[aria-label="Автообновление квот"]').attributes('aria-checked'), 'true');
  assert.equal(h.writes().length, writes);
  await second.get('[aria-label="Автообновление квот"]').trigger('click');
  h.control.data.prefs.providerUsageAutoRefresh = false;
  h.control.data.prefs.providerUsagePolicyRevision = 2;
  secondProviders.applyUsage({ fixture: { state: 'ok', bars: [] } }, false, 2);
  await h.flushPromises();

  const field = secondSettings.snapshot.resources.find((resource) => resource.id === 'prefs')
    .fields.find((entry) => entry.key === 'providerUsageAutoRefresh');

  assert.equal(field.dirty, true);
  assert.equal(field.value, false);
  assert.equal(field.conflict.serverValue, false);
});

test('U6: сбой доставки политики после загрузки лечится повтором', async (t) => {
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    entityId: 'fixture',
    prepare({ control }) {
      control.data.prefs.providerUsageAutoRefresh = false;
      control.data.prefs.providerUsagePolicyRevision = 0;
    },
  });
  const selector = '[aria-label="Автообновление квот"]';

  assert.equal(h.wrapper.get(selector).attributes('aria-checked'), 'false');

  h.control.handlers['/api/settings/prefs'] = () =>
    new Response(JSON.stringify({ message: 'Синтетический сбой доставки' }), { status: 500 });
  h.providers.applyUsage({ fixture: { state: 'ok', bars: [] } }, false, 1);
  await h.flushPromises();

  assert.match(h.wrapper.text(), /Синтетический сбой доставки/u);
  assert.equal(h.wrapper.get('[data-usage-prefs-retry]').exists(), true);

  delete h.control.handlers['/api/settings/prefs'];
  await h.wrapper.get('[data-usage-prefs-retry]').trigger('click');
  await h.flushPromises();

  assert.equal(h.wrapper.text().includes('Синтетический сбой доставки'), false);
  assert.equal(h.wrapper.get(selector).attributes('aria-checked'), 'false');
  assert.equal(h.writes().length, 0);
});
