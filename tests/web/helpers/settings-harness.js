import { compileModule, webFile } from './compile-vue.js';
import { installUiBrowser } from './ui-components.js';
import data from '../fixtures/settings-modal/data.json' with { type: 'json' };
import native from '../../fixtures/executor-settings/synthetic-catalog.json' with { type: 'json' };

/**
 * Новые страницы получают настоящие Pinia stores и общий черновик.
 * Подменяется только сеть: неизвестный адрес является ошибкой, операции видны в calls.
 */
export async function settingsHarness(t, pageId, component, options = {}) {
  const browser = options.browser || await installUiBrowser(t);
  const control = {
    data: structuredClone(data),
    calls: [],
    handlers: {},
    answer: true,
    confirms: [],
    navigations: [],
  };

  globalThis.__settingsHarness = control;

  const [
    { createPinia, setActivePinia },
    { mount, flushPromises },
    { routerKey },
    module,
  ] = await Promise.all([
    import('../../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../../web/node_modules/vue-router/dist/vue-router.mjs'),
    compileModule(webFile('../tests/web/helpers/settings-pages.ts'), {
      stubs: {
        '../router.ts': 'export const router = { push: async () => {} };',
        '../../../composables/useSse.ts': 'export const sseSubscribe = () => () => {};',
        '../../composables/useSse.ts': 'export const useSse = () => ({ connected: { value: false } });',
        '../../../ui.ts': `
          export * from './src/ui.ts';
          export const confirmDialog = async (...args) => {
            globalThis.__settingsHarness.confirms.push(args);
            return globalThis.__settingsHarness.answer;
          };
        `,
      },
    }),
  ]);
  const pinia = createPinia();

  setActivePinia(pinia);

  const settings = module.useSettingsStore(pinia);
  const providers = module.useProvidersStore(pinia);
  const plugins = module.usePluginsStore(pinia);
  const previousFetch = globalThis.fetch;

  providers.providers = control.data.providers.providers;
  providers.loaded = true;
  plugins.list = control.data.plugins.plugins;
  plugins.loaded = true;
  options.prepare?.({
    control,
    providers,
    plugins,
  });

  /**
   * Ответы отражают фактически принятые сервером значения, включая полный plugin PUT.
   * Индивидуальный тест может удержать или отклонить запрос без подмены store.
   */
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = {
      path,
      method,
      body,
    };

    control.calls.push(call);

    if (control.handlers[path]) {
      return control.handlers[path](call);
    }

    // Старый mock-сервер отклоняет новую пробу только после точных handlers.
    // Остальные query не стираются: assertions видят настоящий маршрут запроса.
    if (/^\/api\/plugin-catalog\?api=2(?:&refresh=1)?$/u.test(path)) {
      return Response.json({ error: 'Неизвестный query api' }, { status: 400 });
    }

    let value;

    if (path === '/api/settings/prefs') {
      Object.assign(control.data.prefs, body ?? {});
      value = control.data.prefs;
    } else if (path === '/api/settings/speech' || path === '/api/settings/speech?refresh=1') {
      Object.assign(control.data.speech.settings, body ?? {});
      value = control.data.speech;
    } else if (path === '/api/providers') {
      value = { providers: providers.providers };
    } else if (path === '/api/plugins') {
      value = { plugins: plugins.list };
    } else if (path === '/api/plugin-catalog' || path === '/api/plugin-catalog?refresh=1') {
      value = {
        state: 'unconfigured',
        applicationVersion: '1.0.0',
        fetchedAt: null,
        catalog: null,
      };
    } else if (path === '/api/plugin-installs/jobs/current') {
      value = { job: null, recoveryError: null };
    } else if (/\/api\/providers\/[^/]+\/settings\/catalog/.test(path)) {
      value = { ...native, providerId: decodeURIComponent(path.split('/')[3]) };
    } else if (/\/api\/plugins\/[^/]+\/settings$/.test(path)) {
      const plugin = plugins.list.find((item) => item.id === decodeURIComponent(path.split('/')[3]));

      value = {
        ok: true,
        values: body.values,
        placements: (plugin.placements ?? []).map((item) => ({
          ...item,
          enabled: body.placements[item.slot],
        })),
      };
    } else if (/\/api\/plugins\/[^/]+\/toggle$/.test(path)) {
      value = { ok: true, enabled: body.enabled };
    } else {
      throw new Error(`Неизвестный API настроек: ${method} ${path}`);
    }

    return new Response(JSON.stringify(value));
  };
  settings.setAuthenticated(true);
  settings.requestOpen({ pageId, entityId: options.entityId });

  const wrapper = mount(module[component], {
    attachTo: browser.document.querySelector('#mount'),
    props: { active: true },
    global: {
      plugins: [pinia],
      stubs: options.stubs ?? {},
      provide: {
        [routerKey]: {
          async push(target) {
            control.navigations.push(target);

            return options.navigate?.(target);
          },
        },
      },
    },
  });

  t.after(() => {
    wrapper.unmount();
    settings.dispose();
    globalThis.fetch = previousFetch;
    delete globalThis.__settingsHarness;
  });
  await flushPromises();

  return {
    browser,
    wrapper,
    module,
    settings,
    providers,
    plugins,
    control,
    flushPromises,
    writes: () => control.calls.filter((call) => call.method !== 'GET'),
  };
}
