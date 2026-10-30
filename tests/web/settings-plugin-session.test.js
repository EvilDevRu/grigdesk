import assert from 'node:assert/strict';
import test from 'node:test';
import { compileModule, webFile } from './helpers/compile-vue.js';
import { assertSettingsFields } from './helpers/settings-consistency.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { createSettingsSession } from '../../web/src/features/settings/session.ts';

test('Плагины: общая сессия и полная запись значений', async (t) => {
  await installUiBrowser(t);

  const [{ createPinia, setActivePinia }, { mount, flushPromises }, module] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileModule(webFile('../tests/web/helpers/settings-pages.ts'), {
      stubs: {
        '../router.ts': 'export const router = { push: async () => {} };',
      },
    }),
  ]);

  /**
   * Реальный store получает только контролируемый транспорт плагинов.
   * Полный PUT проверяется на параметрах, которые пользователь не менял.
   */
  function fixture() {
    const pinia = createPinia();

    setActivePinia(pinia);

    const plugins = module.usePluginsStore(pinia);
    const settings = module.useSettingsStore(pinia);
    const calls = [];
    const originalFetch = globalThis.fetch;
    const plugin = {
      id: 'sample',
      name: 'Пример',
      enabled: false,
      needsRestart: true,
      settings: [
        {
          key: 'limit',
          type: 'number',
          label: 'Предел',
          min: 4,
          max: 100,
          step: 4,
        },
        {
          key: 'name',
          type: 'text',
          label: 'Имя',
        },
        {
          key: 'keep',
          type: 'checkbox',
          label: 'Сохранить',
        },
      ],
      values: {
        limit: 12,
        name: 'baseline',
        keep: true,
      },
      placements: [{
        slot: 'chat.header',
        label: 'Чат',
        enabled: true,
      }],
    };

    plugins.list = [plugin];
    plugins.loaded = true;
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).endsWith('/plugin-installs/jobs/current')) {
        return new Response(JSON.stringify({ job: null, recoveryError: null }));
      }

      const body = JSON.parse(options.body);

      calls.push({ path: String(url), body });

      return new Response(JSON.stringify(String(url).endsWith('/toggle')
        ? { ok: true, enabled: body.enabled }
        : {
          ok: true,
          values: body.values,
          placements: [{ ...plugin.placements[0], enabled: body.placements['chat.header'] }],
        }));
    };
    settings.setAuthenticated(true);
    settings.requestOpen({ pageId: 'plugins.installed', entityId: 'sample' });

    return {
      pinia,
      plugins,
      settings,
      calls,
      plugin,
      cleanup() {
        settings.dispose();
        globalThis.fetch = originalFetch;
      },
    };
  }

  for (const resourceId of ['pluginSettings:sample', 'pluginEnabled:sample']) {
    await t.test(`W3: unknown перечитывает GET /api/plugins — ${resourceId}`, async () => {
      const state = fixture();
      const originalFetch = globalThis.fetch;
      const gets = [];

      globalThis.fetch = async (url, options = {}) => {
        if (options.method === 'GET' || !options.method) {
          gets.push(String(url));

          return new Response(JSON.stringify({ plugins: [state.plugin] }));
        }

        throw new TypeError('Соединение оборвалось после записи');
      };

      try {
        const editor = module.createPluginEditor('sample', state.settings, state.plugins);

        await editor.load();
        gets.length = 0;
        state.settings.setField(resourceId,
          resourceId.startsWith('pluginSettings') ? '["values","limit"]' : 'enabled',
          resourceId.startsWith('pluginSettings') ? 20 : true);

        const result = await state.settings.apply();

        await flushPromises();
        assert.equal(result.status, 'unknown');
        assert.deepEqual(gets, ['/api/plugins']);
      } finally {
        globalThis.fetch = originalFetch;
        state.cleanup();
      }
    });
  }

  await t.test('PL02/03/03b: полный values и placements, enabled после параметров', async () => {
    const fixtureState = fixture();
    const { settings, plugins, calls } = fixtureState;

    try {
      const editor = module.createPluginEditor('sample', settings, plugins);

      await editor.load();
      settings.setField('pluginSettings:sample', '["values","limit"]', 20);
      settings.setField('pluginSettings:sample', '["placements","chat.header"]', false);
      settings.setField('pluginEnabled:sample', 'enabled', true);

      assert.equal(calls.length, 0);
      assert.equal(plugins.list[0].enabled, false);
      await settings.apply();

      assert.deepEqual(calls.map((call) => call.body), [{
        values: {
          limit: 20,
          name: 'baseline',
          keep: true,
        },
        placements: { 'chat.header': false },
      }, { enabled: true }]);
      assert.equal(settings.snapshot.dirtyCount, 0);
      assert.equal(plugins.restartPending.sample, true);
    } finally {
      fixtureState.cleanup();
    }
  });

  await t.test('PL05/09: пустое число и исчезнувший плагин не подтверждаются', async () => {
    const state = fixture();
    const { settings, plugins, calls } = state;

    try {
      const editor = module.createPluginEditor('sample', settings, plugins);

      await editor.load();
      settings.setField('pluginSettings:sample', '["values","limit"]', '');
      await settings.apply('ok');

      assert.equal(calls.length, 0);
      assert.equal(settings.isOpen, true);
      settings.setField('pluginSettings:sample', '["values","limit"]', 20);
      plugins.list = [];

      const result = await plugins.saveSettings('sample', {});

      assert.equal(result.ok, false);
      assert.equal(result.outcome, 'failed');
      await settings.apply();
      assert.equal(settings.snapshot.dirtyCount, 1);
    } finally {
      state.cleanup();
    }
  });
  await t.test('PL-ADDR: поля системного плагина адресуются его страницей', async () => {
    const state = fixture();
    const systemList = [{
      ...state.plugin,
      id: 'ssh',
      system: true,
      settings: [{
        key: 'outputLimitKiB',
        type: 'number',
        label: 'Лимит',
        min: 4,
        max: 1024
      }],
      placements: [{
        slot: 'chat.header',
        label: 'Чат',
        enabled: true
      }],
    }];

    try {
      const custom = module.createPluginEditor('sample', state.settings, state.plugins);
      const system = module.createPluginEditor('ssh', state.settings, {
        ...state.plugins,
        list: systemList,
      });

      await custom.load();
      await system.load();

      const customFields = state.settings.snapshot.resources
        .find((item) => item.id === 'pluginSettings:sample').fields;
      const systemFields = state.settings.snapshot.resources
        .find((item) => item.id === 'pluginSettings:ssh').fields;
      const enabled = state.settings.snapshot.resources
        .find((item) => item.id === 'pluginEnabled:ssh').fields;

      assert.deepEqual(customFields[0].address, {
        pageId: 'plugins.installed',
        entityId: 'sample',
        fieldPath: ['values', 'limit'],
      });
      assert.deepEqual(systemFields[0].address, {
        pageId: 'connections.ssh',
        fieldPath: ['values', 'outputLimitKiB'],
      });
      assert.deepEqual(enabled[0].address, {
        pageId: 'connections.ssh',
        fieldPath: ['enabled'],
      });
      assert.deepEqual(systemFields[1].address, {
        pageId: 'connections.ssh',
        fieldPath: ['placements', 'chat.header'],
      });
      assert.deepEqual(state.settings.dynamicFields.filter((item) =>
        item.address.pageId === 'connections.ssh').map((item) => item.address), [
        {
          pageId: 'connections.ssh',
          fieldPath: ['values', 'outputLimitKiB']
        },
        {
          pageId: 'connections.ssh',
          fieldPath: ['placements', 'chat.header']
        },
        {
          pageId: 'connections.ssh',
          fieldPath: ['enabled']
        },
      ]);

      const forecast = module.createPluginEditor('usage-forecast', state.settings, {
        ...state.plugins,
        list: [{
          ...state.plugin,
          id: 'usage-forecast',
          system: true,
          settings: [],
          placements: [{
            slot: 'provider.popover.after-bars',
            enabled: true
          }],
        }],
      });

      await forecast.load();
      assert.deepEqual(state.settings.dynamicFields.filter((item) =>
        item.address.pageId === 'interface.usageForecast').map((item) => item.address), [
        {
          pageId: 'interface.usageForecast',
          fieldPath: ['placements', 'provider.popover.after-bars']
        },
        {
          pageId: 'interface.usageForecast',
          fieldPath: ['enabled']
        },
      ]);
    } finally {
      state.cleanup();
    }
  });

  await t.test('PL04/05: потерянная модель, effort и секрет в новой форме', async () => {
    const state = fixture();
    const { settings, pinia, plugins, calls } = state;
    const providerStore = module.useProvidersStore(pinia);

    providerStore.loaded = true;
    providerStore.providers = [{
      id: 'future',
      name: 'Будущий',
      models: [{
        id: 'org/model:tag',
        name: 'Модель',
        efforts: ['low', 'high'],
      }],
    }];
    plugins.list[0].settings.push({
      key: 'model',
      type: 'model',
      label: 'Модель',
    });
    plugins.list[0].settings.push({
      key: 'password',
      type: 'password',
      label: 'Секрет',
    });
    plugins.list[0].values.model = {
      provider: 'missing',
      model: 'old',
      effort: 'retired',
    };
    plugins.list[0].values.password = '';

    const page = mount(module.PluginPage, { props: { active: true }, global: { plugins: [pinia] } });

    try {
      await flushPromises();
      assertSettingsFields(page.element, module.SETTINGS_FIELDS, 'plugins.installed');
      assert.match(page.text(), /missing: old — нет в реестре/);
      await page.find('select[aria-label="Модель"]').setValue(JSON.stringify({
        provider: 'future',
        model: 'org/model:tag',
      }));
      await page.find('select[aria-label="Усилие"]').setValue('high');
      await page.find('select[aria-label="Усилие"]').setValue('');
      await page.find('input[type="password"]').setValue('private-plugin-marker');

      const model = settings.getValue('pluginSettings:sample', '["values","model"]');

      assert.deepEqual(model, { provider: 'future', model: 'org/model:tag' });
      assert.equal(JSON.stringify(settings.$state).includes('private-plugin-marker'), false);
      assert.equal(JSON.stringify(settings.dynamicFields).includes('private-plugin-marker'), false);
      await page.find('input[type="number"]').setValue('');
      await settings.apply();
      assert.equal(calls.length, 0);
      settings.cancel();
      assert.equal(settings.getValue('pluginSettings:sample', '["values","password"]'), undefined);
    } finally {
      page.unmount();
      state.cleanup();
    }
  });

  await t.test('PL01/06/10: фильтр, setup по baseline и изменение схемы', async () => {
    const state = fixture();
    const { pinia, settings, plugins, calls } = state;
    const installer = module.usePluginInstallStore(pinia);
    const setupCalls = [];

    installer.loadJob = async () => {};
    plugins.list.push({
      ...structuredClone(state.plugin),
      id: 'second',
      name: 'Второй',
    });
    plugins.list[0].enabled = true;
    plugins.list[0].setup = { path: '/api/example/setup' };
    plugins.loadSetup = async () => ({ items: [{
      id: 'sample',
      title: 'Подготовить',
      action: {
      label: 'Запустить подготовку', hint: 'Синтетическая операция',
    },
      job: null,
    }], checkedAt: 'fixture' });
    plugins.runSetup = async (_plugin, id) => {
      setupCalls.push(id);

      return { items: [], checkedAt: 'fixture' };
    };

    let page = mount(module.PluginPage, { props: { active: true }, global: { plugins: [pinia] } });

    try {
      await flushPromises();
      await page.find('input[type="number"]').setValue('20');
      await page.find('[data-select-plugin="second"]').trigger('click');
      await flushPromises();
      await page.find('[data-select-plugin="sample"]').trigger('click');
      await flushPromises();

      assert.equal(page.find('input[type="number"]').element.value, '20');
      await page.find('[data-plugin-filter]').setValue('Пример');
      assert.equal(page.findAll('[data-select-plugin]').length, 1);
      page.unmount();
      page = mount(module.PluginPage, { props: { active: true }, global: { plugins: [pinia] } });
      await flushPromises();

      assert.equal(page.find('[data-plugin-filter]').element.value, 'Пример');
      assert.equal(page.find('input[type="number"]').element.value, '20');
      settings.setField('pluginEnabled:sample', 'enabled', false);
      await flushPromises();
      await page.findAll('button').find((item) => item.text() === 'Запустить подготовку').trigger('click');
      await flushPromises();

      assert.deepEqual(setupCalls, ['sample']);
      assert.equal(calls.length, 0);
      plugins.list[0].settings[0].type = 'text';
      await flushPromises();
      await settings.apply();

      assert.equal(calls.length, 0);
      assert.ok(settings.snapshot.resources.find((item) => item.id === 'pluginSettings:sample')
        .fields.find((field) => field.key === '["values","limit"]').unavailable);
      assert.equal(settings.snapshot.dirtyCount, 2);
    } finally {
      page.unmount();
      state.cleanup();
    }
  });

});
