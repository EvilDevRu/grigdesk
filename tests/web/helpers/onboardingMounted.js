import assert from 'node:assert/strict';

import { onboardingFixture, request } from '../../server/helpers/onboardingFixture.js';
import { compileModule, compileVue, webFile } from './compile-vue.js';

let compiledStore;
let compiledHost;

/**
 * Условия проверяют подтверждённое состояние после реальной записи и Vue-обновления.
 * Ограниченный срок ловит зависший обработчик, не заменяя результат фиксированной задержкой.
 */
export async function waitOnboarding(fixture, condition) {
  const deadline = Date.now() + 4000;

  while (!condition() && Date.now() < deadline) {
    await fixture.flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  await fixture.flushPromises();
  assert.equal(condition(), true, 'Действие мастера не завершилось ожидаемым результатом');
}

/**
 * Кнопка выбирается по видимой подписи в настоящем модальном окне.
 * Отсутствие кнопки возвращается как null, без сериализации DOM в assertion.
 */
export function onboardingButton(fixture, label) {
  return fixture.wrapper.findAll('button').find((button) => button.text() === label) ?? null;
}

/**
 * Мастер использует настоящие host, router, Pinia store, шаги и сервер с временными данными.
 * Подменены только входы внешних исполнителей и транспорт, его эффекты сохраняются в журнале.
 */
export async function mountOnboarding(t, browser, { prepare, providers } = {}) {
  Object.defineProperty(globalThis, 'history', {
    value: browser.history,
    configurable: true,
    writable: true,
  });

  const backend = await onboardingFixture(t);
  const [{ reactive }, { createPinia, setActivePinia }, routing, utils] = await Promise.all([
    import('../../../web/node_modules/vue/index.mjs'),
    import('../../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../../web/node_modules/vue-router/dist/vue-router.mjs'),
    import('../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
  ]);

  if (prepare) {
    await prepare(backend);
  }

  const effects = [];
  const router = routing.createRouter({
    history: routing.createMemoryHistory(),
    routes: ['/chats', '/projects', '/projects/:id', '/documents'].map((path) => ({
      path,
      component: { template: '<div />' },
    })),
  });

  await router.push('/chats?view=agents');

  const state = {
    backend,
    router,
    effects,
    store: null,
    intercept: null,
    shell: reactive({
      initialized: true,
      present: false,
      profile: null,
      capabilities: [],
    }),
    auth: reactive({
      ready: true,
      authenticated: true,
      clientScope: 'fixture',
    }),
    providers: reactive({
      providers: providers ?? [{
        id: 'codex',
        name: 'Codex',
        available: true,
        installed: true,
        color: '#10a37f',
      }],
      load: async () => {},
      whenRegistryReady: async () => ({ ok: true }),
    }),
    read: () => request(backend.app),
    /**
     * Каждый запрос сохраняется до исполнения, включая ожидаемый PATCH и переход.
     * Перехват позволяет задержать или отклонить эффект без подмены серверного снимка.
     */
    async write(suffix, body, patch) {
      const call = {
        kind: 'request',
        suffix,
        body,
        patch,
      };

      effects.push(call);
      await state.intercept?.(call);

      return request(backend.app, patch ? 'PATCH' : 'POST', suffix, body);
    },
    inspect: async (dir) => {
      const response = await backend.app.inject({
        method: 'POST',
        url: '/api/onboarding/repository',
        payload: { dir },
      });

      return response.json();
    },
    settings: (request) => effects.push({ kind: 'settings', request }),
    terminal: (request) => effects.push({ kind: 'terminal', request }),
  };

  globalThis.__onboardingMounted = state;

  const transport = `
    export const readOnboarding = () => globalThis.__onboardingMounted.read();
    export const writeOnboarding = (...args) => globalThis.__onboardingMounted.write(...args);
    export const inspectOnboardingRepository = (...args) => globalThis.__onboardingMounted.inspect(...args);
  `;

  compiledStore ??= await compileModule(webFile('src/stores/onboarding.ts'), {
    stubs: {
      './auth.ts': 'export const useAuthStore = () => globalThis.__onboardingMounted.auth;',
      './shell.ts': 'export const useShellStore = () => globalThis.__onboardingMounted.shell;',
      '../shared/onboardingApi.ts': transport,
    },
  });

  setActivePinia(createPinia());
  state.store = compiledStore.useOnboardingStore();
  await state.store.open(prepare ? 'resume' : 'manual');

  compiledHost ??= await compileVue(webFile('src/shared/onboarding/OnboardingHost.vue'), {
    stubs: {
      '../../stores/onboarding.ts':
        'export const useOnboardingStore = () => globalThis.__onboardingMounted.store;',
      '../../stores/shell.ts': 'export const useShellStore = () => globalThis.__onboardingMounted.shell;',
      '../../stores/providers.ts':
        'export const useProvidersStore = () => globalThis.__onboardingMounted.providers;',
      '../../stores/providerInstall.ts': 'export const useProviderInstallStore = () => ({ busy: false });',
      '../../shared/tools/launcher.ts': `export const useToolLauncher = () => ({
        openTerminal: (...args) => globalThis.__onboardingMounted.terminal(...args),
      });`,
      '../../shared/settingsNavigation.ts':
        'export const openSettings = (...args) => globalThis.__onboardingMounted.settings(...args);',
      '../../composables/useSse.ts': 'export const useSse = () => {};',
      '../../shared/onboardingApi.ts': transport,
    },
  });

  const wrapper = utils.mount(compiledHost, {
    attachTo: browser.document.body,
    global: {
      plugins: [router],
      stubs: { teleport: true, transition: false },
    },
  });
  const fixture = {
    ...state,
    wrapper,
    flushPromises: utils.flushPromises,
  };

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__onboardingMounted;
  });

  await waitOnboarding(fixture, () => wrapper.find('[data-role="onboarding-modal"]').exists());

  return fixture;
}
