import assert from 'node:assert/strict';
import test from 'node:test';
import catalog from '../fixtures/executor-settings/synthetic-catalog.json' with { type: 'json' };
import { compileModule, webFile } from './helpers/compile-vue.js';
import { assertSettingsFields } from './helpers/settings-consistency.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { createSettingsSession } from '../../web/src/features/settings/session.ts';

test('Исполнители: очередь и исходы общей сессии', async (t) => {
  await installUiBrowser(t);

  const [{ createPinia, setActivePinia }, { mount, flushPromises }, module] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileModule(webFile('../tests/web/helpers/settings-pages.ts'), {
      stubs: {
        '../../../shared/tools/launcher.ts': `
          export const useToolLauncher = () => ({ openTerminal: async () => true });
        `,
        '../router.js': 'export const router = { push: async () => {} };',
        '../../../composables/useSse.ts': 'export const sseSubscribe = () => () => {};',
        '../../../ui.ts': `
          export * from './src/ui.ts';
          export async function confirmDialog(text, options) {
            globalThis.__providerConfirmations.push({ text, options });
            return globalThis.__providerConfirmAnswer;
          }
        `,
      },
    }),
  ]);

  /**
   * Два исполнителя имеют независимые каталоги и возрастающие CAS-ревизии.
   * Доменный store настоящий; транспорт фиксирует только синтетические обращения.
   */
  function fixture(conflict = false, unknown = false) {
    const requests = [];
    const reads = [];
    const catalogs = new Map(['alpha', 'beta'].map((id) => {
      const value = structuredClone(catalog);

      value.providerId = id;
      value.fields.push({
        ...structuredClone(value.fields[0]),
        id: '["x.y","z/w"]',
        path: ['x.y', 'z/w'],
        label: 'Второе поле',
      });

      return [id, value];
    }));
    const pinia = createPinia();

    setActivePinia(pinia);

    const store = module.defineProviderSettingsStore({
      async catalog(id) {
        reads.push(id);

        return structuredClone(catalogs.get(id));
      },
      /**
       * Ответ имитирует настоящую замену каталога с новой CAS-ревизией.
       * Вариант конфликта проверяет остановку очереди без повторной записи.
       */
      async override(id, request) {
        requests.push({ id, ...request });

        if (conflict && id === 'alpha') {
          throw new module.ApiError('Изменено другим окном', 409, {});
        }

        if (unknown) {
          throw new TypeError('Соединение оборвалось после записи');
        }

        const next = catalogs.get(id);
        const field = next.fields.find((item) => item.id === request.fieldId);

        field.override = request.operation === 'set'
          ? { state: 'known', value: request.value } : { state: 'unset' };
        next.revision = String(Number(next.revision) + 1);

        return {
          ok: true,
          changed: true,
          catalog: structuredClone(next),
        };
      },
    })(pinia);
    const session = createSettingsSession();

    session.begin();

    return {
      store,
      pinia,
      session,
      catalogs,
      requests,
      reads,
    };
  }

  await t.test('W3: unknown перечитывает нативный каталог вопреки кешу 60 с', async () => {
    const { store, session, catalogs, reads } = fixture(false, true);
    const fields = catalogs.get('alpha').fields;

    session.register(module.createProviderNativeAdapter('alpha', store), fields.map((field) => ({
      key: field.id,
      address: { pageId: 'agents.providers', fieldPath: field.path },
    })));
    await session.load('providerNative:alpha');
    assert.deepEqual(reads, ['alpha']);
    session.setField('providerNative:alpha', '["enabled"]', false);

    const result = await session.apply();

    await flushPromises();
    assert.equal(result.status, 'unknown');
    assert.deepEqual(reads, ['alpha', 'alpha']);
  });

  await t.test('W3: unknown обычного параметра делает новый GET реестра', async () => {
    const pinia = createPinia();
    const providers = module.useProvidersStore(pinia);
    const session = createSettingsSession();
    const originalFetch = globalThis.fetch;
    const gets = [];
    const provider = {
      id: 'alpha',
      settings: [{
        id: 'enabled',
        kind: 'toggle',
        value: true,
      }],
    };

    providers.providers = [provider];
    providers.loaded = true;
    globalThis.fetch = async (url, options = {}) => {
      if (!options.method || options.method === 'GET') {
        gets.push(String(url));

        return new Response(JSON.stringify({ providers: [provider] }));
      }

      throw new TypeError('Ответ записи потерян');
    };

    try {
      session.begin();
      session.register(module.createProviderSettingsAdapter('alpha', providers), [{
        key: 'enabled',
        address: { pageId: 'agents.providers', fieldPath: ['settings', 'enabled'] },
      }]);
      await session.load('providerSettings:alpha');
      session.setField('providerSettings:alpha', 'enabled', false);

      const result = await session.apply();

      await flushPromises();
      assert.equal(result.status, 'unknown');
      assert.deepEqual(gets, ['/api/providers?refresh=1']);
    } finally {
      globalThis.fetch = originalFetch;
      session.dispose();
    }
  });

  await t.test('PR02/PR03: два поля идут через Apply с новой revision и отдельными схемами', async () => {
    const { store, session, catalogs, requests } = fixture();

    for (const id of ['alpha', 'beta']) {
      const fields = catalogs.get(id).fields;

      session.register(module.createProviderNativeAdapter(id, store), fields.map((field) => ({
        key: field.id,
        address: {
          pageId: 'agents.providers',
          entityId: id,
          tabId: 'parameters',
          fieldPath: field.path,
        },
      })));
      await session.load(`providerNative:${id}`);
      session.setField(`providerNative:${id}`, '["enabled"]', false);
      session.setField(`providerNative:${id}`, '["x.y","z/w"]', true);
    }

    assert.equal(requests.length, 0);
    await session.apply();

    assert.deepEqual(requests.map((entry) => [entry.id, entry.revision, entry.schemaRevision]), [
      ['alpha', '0', 'schema-v1'], ['alpha', '1', 'schema-v1'],
      ['beta', '0', 'schema-v1'], ['beta', '1', 'schema-v1'],
    ]);
    assert.equal(Object.hasOwn(store.panel('alpha'), 'drafts'), false);
    assert.equal(session.getSnapshot().dirtyCount, 0);
  });

  await t.test('PR04/PR05: 409 перечитывает каталог, останавливает поля своего исполнителя', async () => {
    const { store, session, catalogs, requests, reads } = fixture(true);

    for (const id of ['alpha', 'beta']) {
      const fields = catalogs.get(id).fields;

      session.register(module.createProviderNativeAdapter(id, store), fields.map((field) => ({
        key: field.id,
        address: {
          pageId: 'agents.providers',
          entityId: id,
          fieldPath: field.path,
        },
      })));
      await session.load(`providerNative:${id}`);

      for (const field of fields) {
        session.setField(`providerNative:${id}`, field.id, false);
      }
    }

    const result = await session.apply('ok');

    assert.equal(requests.filter((entry) => entry.id === 'alpha').length, 1);
    assert.equal(requests.filter((entry) => entry.id === 'beta').length, 2);
    assert.equal(reads.filter((id) => id === 'alpha').length, 2);
    assert.equal(result.shouldClose, false);
    assert.equal(result.remaining.length, 2);
    assert.equal(Object.hasOwn(store.panel('alpha'), 'drafts'), false);
  });

  await t.test('PR05: legacy save/reset возвращают WriteOutcome, сохраняя прежнюю очередь', async () => {
    const { store } = fixture(true);

    await store.load('alpha');

    const outcome = await store.save('alpha', '["enabled"]', false);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.outcome, 'conflict');
    assert.equal(outcome.status, 409);
  });

  await t.test('PR07: недоступный сохранённый выбор допускает отложенное unset', async () => {
    const session = createSettingsSession();
    const calls = [];

    session.begin();
    session.register({
      id: 'inactive',
      chain: 'provider:inactive',
      order: 100,
      body: 'per-field',
      supportsUnset: true,
      read: async () => ({}),
      validate: () => [],
      async write(intents) {
        calls.push([...intents]);

        return { status: 'success', fields: [{ key: 'lost', status: 'success' }] };
      },
    }, [{
      key: 'lost',
      address: { pageId: 'agents.providers', fieldPath: ['lost'] },
      unavailable: 'Поле удалено из схемы',
      hasStoredValue: true,
    }]);
    await session.load('inactive');
    session.unsetField('inactive', 'lost');

    assert.equal(calls.length, 0);
    await session.apply();

    assert.deepEqual(calls, [[['lost', { op: 'unset' }]]]);
    assert.equal(session.getSnapshot().dirtyCount, 0);
  });


  await t.test('PR11: unknown требует изменившийся set/preview', async () => {
    for (const changed of [false, true]) {
      const session = createSettingsSession();
      const provider = {
        id: 'alpha',
        credentials: [{
          env: 'KEY',
          kind: 'secret',
          set: true,
          preview: '…old1',
        }],
      };
      let reads = 0;
      const port = {
        providers: [provider],
        loaded: true,
        async load() {
          reads += 1;

          if (changed) {
            provider.credentials[0].preview = '…new2';
          }
        },
        whenRegistryReady: async () => ({ ok: true }),
        saveCredentials: async () => ({ ok: false, outcome: 'unknown' }),
      };

      session.begin();
      session.register(module.createProviderCredentialsAdapter('alpha', port), [{
        key: 'KEY',
        secret: true,
        address: {
          pageId: 'agents.providers',
          entityId: 'alpha',
          fieldPath: ['credentials', 'KEY'],
        },
      }]);
      await session.load('providerCredentials:alpha');
      session.setField('providerCredentials:alpha', 'KEY', 'synthetic-secret-marker-new2');

      const result = await session.apply('ok');

      assert.equal(reads, 1);
      assert.equal(result.shouldClose, changed);
      assert.equal(session.getSnapshot().dirtyCount, changed ? 0 : 1);
      assert.equal(JSON.stringify(session.getSnapshot()).includes('synthetic-secret-marker'), false);
      session.dispose();
    }
  });

  await t.test('PR11: новая схема после доступа удерживает исчезнувшее dirty без отправки поля', async () => {
    const { store, pinia } = fixture();
    const settings = module.useSettingsStore(pinia);
    const initial = {
      id: 'alpha',
      settings: [{
        id: 'mode',
        kind: 'toggle',
        label: 'Режим',
        value: false,
      }],
      credentials: [{
        env: 'KEY',
        kind: 'secret',
        label: 'Ключ',
        set: false,
      }],
    };
    let writes = 0;
    const port = module.reactive({
      providers: [initial],
      loaded: true,
      async load() {},
      whenRegistryReady: async () => ({ ok: true }),
      async saveCredentials() {
        this.providers = [{ ...initial, settings: [] }];

        return { ok: true };
      },
      async saveSetting() {
        writes += 1;

        return { ok: true, serverValue: true };
      },
    });

    settings.setAuthenticated(true);
    settings.requestOpen({ pageId: 'agents.providers', entityId: 'alpha' });

    const editor = module.createProviderEditor('alpha', settings, port, store);

    await editor.loadParameters();
    await editor.loadAccess();
    settings.setField('providerSettings:alpha', 'mode', true);
    settings.setField('providerCredentials:alpha', 'KEY', 'synthetic-marker');
    await settings.apply();

    assert.equal(writes, 0);
    assert.equal(settings.snapshot.dirtyCount, 1);
    assert.ok(settings.snapshot.resources.find((item) => item.id === 'providerSettings:alpha')
      .fields.find((field) => field.key === 'mode').unavailable);
    assert.ok(settings.dynamicFields.find((field) => field.label === 'Режим').available === false);
    settings.cancel();
  });

  await t.test('PR01/PR09/PR13: выбор по типам, приватные drafts и ленивая MCP-загрузка', async () => {
    const { pinia } = fixture();
    const providers = module.useProvidersStore(pinia);
    const settings = module.useSettingsStore(pinia);
    const calls = [];

    providers.loaded = true;
    providers.providers = ['alpha', 'beta'].map((id, index) => ({
      id,
      name: id,
      type: index ? '3d' : 'universal',
      installed: true,
      mcp: true,
      credentials: [{
        env: 'KEY',
        kind: 'secret',
        label: 'Ключ',
        set: false,
      }],
    }));
    providers.loadMcp = async (id) => {
      calls.push(id);
      providers.mcp = { ...providers.mcp, [id]: { state: 'ready', servers: [] } };
    };
    providers.loadUsage = async () => {};
    settings.setAuthenticated(true);
    settings.requestOpen({ pageId: 'agents.providers', entityId: 'alpha' });
    settings.selectPage('agents.providers', 'alpha', 'access');

    const page = mount(module.ProviderPage, { props: { active: true }, global: { plugins: [pinia] } });

    try {
      await flushPromises();
      assert.equal(page.findAll('[data-executor-type]').length, 2);
      assertSettingsFields(page.element, module.SETTINGS_FIELDS, 'agents.providers');
      await page.find('input[type="password"]').setValue('alpha-private-marker');
      await page.find('[data-select-provider="beta"]').trigger('click');
      await flushPromises();
      await page.find('input[type="password"]').setValue('beta-private-marker');
      await page.find('[data-select-provider="alpha"]').trigger('click');
      await flushPromises();

      assert.equal(page.find('input[type="password"]').element.value, 'alpha-private-marker');
      assert.deepEqual(calls, []);
      settings.selectPage('agents.providers', 'alpha', 'mcp');
      await flushPromises();
      assert.deepEqual(calls, ['alpha']);
      await flushPromises();
      assert.deepEqual(calls, ['alpha']);
      settings.selectPage('agents.providers', 'alpha', 'overview');
      await flushPromises();
      assert.deepEqual(calls, ['alpha']);
    } finally {
      page.unmount();
      settings.dispose();
    }
  });

  await t.test('PR02b/PR06/PR08/PR11: подтверждение и ожидание реестра', async (scenario) => {
    const { store, pinia } = fixture();
    const providers = module.useProvidersStore();
    const settings = module.useSettingsStore();
    const registry = Promise.withResolvers();
    const calls = [];
    const originalFetch = globalThis.fetch;
    const provider = {
      id: 'alpha',
      name: 'Синтетический исполнитель',
      available: true,
      settingsCatalog: true,
      settings: [{
        id: 'capability',
        kind: 'toggle',
        label: 'Опасная возможность',
        value: false,
        confirm: { on: {
          text: 'Подтвердить возможность?',
          label: 'Разрешить',
          danger: true,
        } },
      }],
      credentials: [{
        env: 'SYNTHETIC_KEY',
        kind: 'secret',
        label: 'Ключ доступа',
        set: true,
        inFile: true,
        preview: '…old1',
        value: null,
      }],
    };

    providers.providers = [provider];
    providers.loaded = true;
    globalThis.__providerConfirmations = [];
    globalThis.__providerConfirmAnswer = false;
    globalThis.fetch = async (url, options = {}) => {
      const path = String(url);

      if (path.includes('/credentials')) {
        calls.push({ kind: 'credentials', body: JSON.parse(options.body) });

        return new Response(JSON.stringify({ ok: true }));
      }
      if (path.includes('/settings')) {
        const body = JSON.parse(options.body);

        calls.push({ kind: 'setting', body });
        provider.settings[0].value = body.value;

        return new Response(JSON.stringify({ ok: true, settings: provider.settings }));
      }
      if (path.includes('/usage')) {
        return new Response(JSON.stringify({ usage: {} }));
      }

      calls.push({ kind: 'registry' });

      return new Response(JSON.stringify(await registry.promise));
    };

    settings.setAuthenticated(true);
    settings.requestOpen({ pageId: 'agents.providers', entityId: 'alpha' });
    settings.selectPage('agents.providers', 'alpha', 'parameters');

    const page = mount(module.ProviderPage, { props: { active: true }, global: { plugins: [pinia] } });

    scenario.after(() => {
      page.unmount();
      settings.dispose();
      globalThis.fetch = originalFetch;
      delete globalThis.__providerConfirmations;
      delete globalThis.__providerConfirmAnswer;
    });
    await flushPromises();

    const toggle = page.find('[data-ordinary="capability"] [role="switch"]');

    await toggle.setValue(true);

    assert.equal(settings.getIntent('providerSettings:alpha', 'capability'), undefined);
    globalThis.__providerConfirmAnswer = true;
    await toggle.setValue(true);

    assert.equal(settings.getIntent('providerSettings:alpha', 'capability').confirmed, true);
    assert.equal(calls.length, 0);
    settings.selectPage('agents.providers', 'alpha', 'access');
    await flushPromises();

    const secret = 'synthetic-secret-marker-new2';

    await page.find('input[type="password"]').setValue(secret);

    assert.equal(JSON.stringify(settings.$state).includes(secret), false);
    assert.equal(JSON.stringify(localStorage).includes(secret), false);

    const applying = settings.apply();

    await flushPromises();

    assert.equal(calls.filter((entry) => entry.kind === 'credentials').length, 1);
    assert.equal(calls.filter((entry) => entry.kind === 'setting').length, 0);
    registry.resolve({ providers: [provider] });
    await applying;

    assert.equal(calls.filter((entry) => entry.kind === 'setting').length, 1);
    assert.equal(calls.find((entry) => entry.kind === 'setting').body.confirmed, true);
    assert.equal(globalThis.__providerConfirmations.length, 2);
    assert.equal(settings.getValue('providerCredentials:alpha', 'SYNTHETIC_KEY'), undefined);
    await page.find('[data-delete-key]').trigger('click');

    assert.match(globalThis.__providerConfirmations.at(-1).text, /Ключ будет удалён после «Применить»/);
    assert.equal(settings.getIntent('providerCredentials:alpha', 'SYNTHETIC_KEY').value, null);
    assert.equal(calls.filter((entry) => entry.kind === 'credentials').length, 1);
    settings.cancel();
    await flushPromises();

    assert.equal(Object.hasOwn(store.panel('alpha'), 'drafts'), false);
    assert.equal(settings.getIntent('providerCredentials:alpha', 'SYNTHETIC_KEY'), undefined);
    settings.requestOpen({ pageId: 'agents.providers', entityId: 'alpha' });
    settings.selectPage('agents.providers', 'alpha', 'access');
    await flushPromises();

    assert.equal(page.find('input[type="password"]').element.value, '');
    assert.equal(settings.snapshot.dirtyCount, 0);
  });
});
