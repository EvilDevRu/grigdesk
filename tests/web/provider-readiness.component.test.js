import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { settingsHarness } from './helpers/settings-harness.js';

process.env.NODE_ENV = 'test';

/**
 * Две реальные поверхности получают один настоящий providers store.
 * Подменяются только HTTP и неиспользуемые внешние действия мастера.
 */
test('PROVIDER-READINESS: общий статус, допуск чата и восстановление после ошибки', async (t) => {
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    entityId: 'tripo',
    prepare({ providers }) {
      providers.providers = [
        {
          id: 'tripo',
          name: 'Tripo',
          type: '3d',
          kind: 'api',
          available: true,
          installed: true,
          chatEnabled: false,
          models: [],
        },
        {
          id: 'setup-only',
          name: 'Setup only',
          available: true,
          installed: true,
          chatEnabled: false,
          models: [],
        },
        {
          id: 'synthetic-chat',
          name: 'Synthetic chat',
          available: false,
          installed: true,
          chatEnabled: true,
          models: [],
        },
      ];
    },
  });

  h.settings.selectPage('agents.providers', 'tripo', 'overview');
  globalThis.__readinessProviders = h.providers;

  const Step = await compileVue(webFile('src/views/onboarding/OnboardingAiStep.vue'), {
    stubs: {
      '../../stores/providers.ts':
        'export const useProvidersStore = () => globalThis.__readinessProviders;',
      '../../stores/providerInstall.ts':
        'export const useProviderInstallStore = () => ({ busy: false });',
      '../../stores/onboarding.ts':
        'export const useOnboardingStore = () => ({ flush: async () => true, hide() {} });',
      '../../shared/tools/launcher.ts':
        'export const useToolLauncher = () => ({ openTerminal() {} });',
    },
  });
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wizard = mount(Step, { attachTo: h.browser.document.body });

  t.after(() => {
    wizard.unmount();
    delete globalThis.__readinessProviders;
  });

  await h.flushPromises();

  const card = (name) => wizard.findAll('article.provider').find((item) => item.get('h3').text() === name);
  const status = (name) => card(name).get('.provider-status span:last-child').text();
  const chatReady = () => wizard.emitted('ready').at(-1)[0];
  const refresh = () => wizard.get('.provider-refresh button');
  const titleStatus = () => h.wrapper.get('.settings-provider-status').text();
  const listStatus = () => h.wrapper.get('[data-select-provider="tripo"] .ui-settings-catalog-status').text();

  assert.equal(status('Tripo'), 'Доступен');
  assert.equal(titleStatus(), 'Доступен');
  assert.equal(listStatus(), 'Доступен');
  assert.equal(card('Tripo').get('path').attributes('fill'), '#F6D85A');
  assert.equal(status('Setup only'), 'Доступен');
  assert.equal(chatReady(), false);

  h.providers.providers[2].available = true;
  await h.flushPromises();
  assert.equal(chatReady(), true);
  h.providers.providers[2].chatEnabled = false;
  await h.flushPromises();
  assert.equal(chatReady(), false);
  delete h.providers.providers[2].chatEnabled;
  await h.flushPromises();
  assert.equal(chatReady(), true, 'Старый чатовый DTO без chatEnabled остаётся совместимым');

  const gate = Promise.withResolvers();

  h.control.handlers['/api/providers?refresh=1'] = () => gate.promise;

  try {
    await refresh().trigger('click');
    assert.equal(refresh().attributes('aria-disabled'), 'true');
    assert.equal(refresh().attributes('aria-busy'), 'true');
    assert.equal(status('Tripo'), 'Доступен');
  } finally {
    gate.resolve(Response.json({ error: 'fixture unavailable' }, { status: 503 }));
  }

  await h.providers.whenRegistryReady();
  await h.flushPromises();
  assert.match(wizard.text(), /Не удалось проверить исполнителей/u);
  assert.equal(refresh().attributes('aria-disabled'), undefined);
  assert.equal(refresh().attributes('aria-busy'), undefined);
  assert.equal(status('Tripo'), 'Доступен');
  assert.equal(titleStatus(), 'Доступен');

  const snapshot = h.providers.providers.map((provider) => ({ ...provider, available: false }));

  h.control.handlers['/api/providers?refresh=1'] = () => Response.json({ providers: snapshot });
  await refresh().trigger('click');
  await h.providers.whenRegistryReady();
  await h.flushPromises();
  assert.equal(status('Tripo'), 'Недоступен');
  assert.equal(titleStatus(), 'Недоступен');
  assert.equal(listStatus(), 'Недоступен');
  assert.equal(card('Tripo').get('path').attributes('fill'), 'currentColor');
  assert.equal(chatReady(), false);
  assert.doesNotMatch(wizard.text(), /Не удалось проверить исполнителей/u);

  h.control.handlers['/api/providers?refresh=1'] = () => Response.json({
    providers: snapshot.map((provider) => ({ ...provider, available: true })),
  });
  await refresh().trigger('click');
  await h.providers.whenRegistryReady();
  await h.flushPromises();
  assert.equal(status('Tripo'), 'Доступен');
  assert.equal(titleStatus(), 'Доступен');
  assert.equal(chatReady(), true);

  t.after(() => h.module.setUiLocale('ru'));
  h.module.setUiLocale('en');
  await h.flushPromises();
  assert.equal(titleStatus(), 'Available');
  assert.equal(listStatus(), 'Available');
  h.module.setUiLocale('ru');
  await h.flushPromises();
  assert.equal(titleStatus(), 'Доступен');
  assert.equal(listStatus(), 'Доступен');
  assert.deepEqual(h.writes(), []);
});
