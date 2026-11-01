import assert from 'node:assert/strict';
import test from 'node:test';

import { onboardingFixture, request } from '../server/helpers/onboardingFixture.js';
import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

/**
 * Переход пишет настоящий файл, поэтому одного Vue nextTick для ACK недостаточно.
 * Ожидание проверяет подтверждённый store и завершается по ограниченному сроку.
 */
async function waitStep(store, step) {
  const deadline = Date.now() + 4000;

  while (store.snapshot?.active?.step !== step && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(store.snapshot?.active?.step, step);
}

/**
 * Настоящие store, шаги, controls и HTTP-сервис работают в одном изолированном сценарии.
 * Внешние исполнители и оболочка подменены; отдельный браузер не запускается.
 */
test('ONB-NAV-UI: цвет готовности, единые кнопки и возврат после ACK без потери ввода', async (t) => {
  const browser = await installUiBrowser(t);
  const backend = await onboardingFixture(t);
  const [{ reactive }, { createPinia, setActivePinia }, { mount, flushPromises }] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
  ]);
  const calls = [];
  let patchGate = null;
  const state = {
    store: null,
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
      providers: [
        {
          id: 'codex',
          name: 'Codex',
          available: true,
          installed: true,
          color: '#10a37f',
        },
        {
          id: 'claude',
          name: 'Claude',
          available: false,
          installed: true,
          color: '#d97757',
        },
        {
          id: 'tripo',
          name: 'Tripo',
          available: true,
          installed: true,
          chatEnabled: false,
        },
      ],
      load: async () => {},
      whenRegistryReady: async () => ({ ok: true }),
    }),
    read: () => request(backend.app),
    /**
     * PATCH можно удержать перед серверной записью для проверки барьера перехода.
     * Все остальные ответы берутся из настоящего сервиса без подмены снимка.
     */
    async write(suffix, body, patch) {
      if (patch && patchGate) {
        await patchGate.promise;
      }

      calls.push(suffix || 'PATCH');

      return request(backend.app, patch ? 'PATCH' : 'POST', suffix, body);
    },
    inspect: async () => ({
      state: 'invalid',
      branches: [],
      currentBranch: null,
      reason: null,
    }),
  };

  globalThis.__onboardingNavigation = state;
  t.after(() => {
    patchGate?.resolve();
    delete globalThis.__onboardingNavigation;
  });

  const transport = `
    export const readOnboarding = () => globalThis.__onboardingNavigation.read();
    export const writeOnboarding = (...args) => globalThis.__onboardingNavigation.write(...args);
    export const inspectOnboardingRepository = (...args) =>
      globalThis.__onboardingNavigation.inspect(...args);
  `;
  const { useOnboardingStore } = await compileModule(webFile('src/stores/onboarding.ts'), {
    stubs: {
      './auth.ts': 'export const useAuthStore = () => globalThis.__onboardingNavigation.auth;',
      './shell.ts': 'export const useShellStore = () => globalThis.__onboardingNavigation.shell;',
      '../shared/onboardingApi.ts': transport,
    },
  });

  setActivePinia(createPinia());
  state.store = useOnboardingStore();
  await state.store.open('manual');

  const Modal = await compileVue(webFile('src/views/onboarding/OnboardingModal.vue'), {
    stubs: {
      '../../stores/onboarding.ts':
        'export const useOnboardingStore = () => globalThis.__onboardingNavigation.store;',
      '../../stores/shell.ts':
        'export const useShellStore = () => globalThis.__onboardingNavigation.shell;',
      '../../stores/providers.ts':
        'export const useProvidersStore = () => globalThis.__onboardingNavigation.providers;',
      '../../stores/providerInstall.ts': 'export const useProviderInstallStore = () => ({ busy: false });',
      '../../shared/tools/launcher.ts': 'export const useToolLauncher = () => ({});',
      '../../shared/settingsNavigation.ts': 'export const openSettings = () => {};',
      '../../shared/onboardingApi.ts': transport,
      'vue-router': 'export const useRouter = () => ({ push: async () => {} });',
    },
  });
  const wrapper = mount(Modal, {
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { teleport: true, transition: false } },
  });

  t.after(() => wrapper.unmount());
  await flushPromises();

  const button = (label) => wrapper.findAll('button').find((entry) => entry.text() === label);
  const icons = wrapper.findAll('.provider-icon');

  assert.equal(icons[0].element.style.color, '#10a37f');
  assert.equal(icons[1].element.style.color, '');
  assert.equal(icons[2].get('path').attributes('fill'), 'currentColor');
  assert.equal(Boolean(button('Назад')), false);
  assert.equal(button('Пропустить шаг').attributes('data-variant'), 'outline');
  assert.equal(button('Пропустить настройку').attributes('data-variant'), 'outline');

  await button('Пропустить шаг').trigger('click');
  await waitStep(state.store, 'project');
  await flushPromises();
  assert.equal(state.store.snapshot.active.step, 'project');
  assert.equal(button('Назад').attributes('data-variant'), 'outline');
  assert.equal(button('Пропустить настройку').attributes('data-variant'), 'outline');

  patchGate = Promise.withResolvers();
  await wrapper.get('input').setValue('Название перед возвратом');
  await button('Назад').trigger('click');
  assert.equal(calls.includes('/back'), false, 'Возврат ждёт последнего PATCH');
  assert.equal(state.store.snapshot.active.step, 'project');
  patchGate.resolve();
  await state.store.flush();
  await waitStep(state.store, 'ai');
  await flushPromises();
  assert.equal(state.store.snapshot.active.step, 'ai');
  assert.equal(state.store.draft.title, 'Название перед возвратом');
  assert.equal(wrapper.find('.onboarding-step-skipped').exists(), false);

  await button('Далее').trigger('click');
  await waitStep(state.store, 'project');
  await flushPromises();
  assert.equal(state.store.snapshot.active.step, 'project');
  assert.equal(wrapper.get('input').element.value, 'Название перед возвратом');
  state.store.error = 'save';
  await flushPromises();
  assert.equal(button('Назад').element.disabled, true);
});
