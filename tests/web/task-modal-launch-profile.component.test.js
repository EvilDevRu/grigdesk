import assert from 'node:assert/strict';
import test from 'node:test';
import { compileTaskModal } from './helpers/task-modal.js';

process.env.NODE_ENV = 'test';

// Общий стенд для сценариев формы запуска: happy-dom + заглушки сторов.
// launchOptions/launch задаёт тест, остальные вызовы — безобидные пустышки.
async function mountLaunchForm(t, { launchOptions }) {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://grigdesk.test/#/board' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    FormData: browser.FormData,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  const launchCalls = [];
  globalThis.__taskModalLaunchApi = {
    async get(url) {
      if (url.endsWith('/clarifications')) return { text: '' };
      if (url === '/api/tasks') return { tasks: [] };
      return {};
    },
    async post() { return {}; },
    async upload() { return {}; },
  };
  globalThis.__taskModalLaunchRunnerDisplay = await import('../../web/src/shared/runnerDisplay.ts');
  globalThis.__taskModalLaunchUiStore = defineStore('task-modal-launch-ui', {
    state: () => ({ taskId: 42 }),
    actions: { close() {} },
  });
  globalThis.__taskModalLaunchTasksStore = defineStore('task-modal-launch-tasks', {
    actions: {
      async load() { return { title: 'Обновить отчёт', description: 'Проверить результат' }; },
      async timer() {},
      async complete() {},
      async comment() {},
      launchOptions,
      async launch(id, payload) {
        launchCalls.push([String(id), payload]);
        return { outcome: 'launched', profile: payload.profile, route: payload.route };
      },
    },
  });
  globalThis.__taskModalLaunchBoardStore = defineStore('task-modal-launch-board', {
    state: () => ({
      data: {
        tasks: [{ id: 42, title: 'Обновить отчёт', group: 'Проект Бета' }],
        toReview: [], created: [], accomplice: [], auditor: [],
      },
    }),
    actions: { async load() {} },
  });
  globalThis.__taskModalLaunchAnalysisStore = defineStore('task-modal-launch-analysis', {
    actions: {
      async detail() { return {}; },
      async analyze() {},
    },
  });
  globalThis.__taskModalLaunchFavoritesStore = defineStore('task-modal-launch-favorite', {
    state: () => ({ taskIds: [], loaded: true, loading: false, error: null, pending: {} }),
    getters: {
      isFavorite: () => () => false,
      isPending: () => () => false,
    },
    actions: { async load() {}, async toggle() {} },
  });
  // Открытая задача перестаёт быть новой; форме запуска отметка безразлична.
  globalThis.__taskModalLaunchSeenStore = defineStore('task-modal-launch-seen', {
    state: () => ({ taskIds: [], loaded: true, initialized: true, loading: false, error: null }),
    getters: {
      isSeen: () => () => false,
      ready: () => true,
    },
    actions: { async load() {}, async markSeen() { return true; } },
  });

  const wrapper = mount(await compileTaskModal('__taskModalLaunch'), {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()], stubs: { teleport: true } },
  });
  t.after(() => {
    wrapper.unmount();
    browser.close();
    for (const key of [
      '__taskModalLaunchApi',
      '__taskModalLaunchRunnerDisplay',
      '__taskModalLaunchUiStore',
      '__taskModalLaunchTasksStore',
      '__taskModalLaunchBoardStore',
      '__taskModalLaunchAnalysisStore',
      '__taskModalLaunchFavoritesStore',
      '__taskModalLaunchSeenStore',
    ]) delete globalThis[key];
  });
  await flushPromises();
  return { wrapper, flushPromises, launchCalls };
}

test('TaskModal выбирает project-beta, перечитывает feature и шлёт profile в launch', async (t) => {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://grigdesk.test/#/board' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    FormData: browser.FormData,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  const optionCalls = [];
  const launchCalls = [];
  globalThis.__taskModalLaunchRunnerDisplay = await import('../../web/src/shared/runnerDisplay.ts');
  globalThis.__taskModalLaunchApi = {
    async get(url) {
      if (url.endsWith('/clarifications')) return { text: '' };
      if (url === '/api/tasks') return { tasks: [] };
      return {};
    },
    async post() { return {}; },
    async upload() { return {}; },
  };
  globalThis.__taskModalLaunchUiStore = defineStore('task-modal-launch-ui', {
    state: () => ({ taskId: 42 }),
    actions: { close() {} },
  });
  globalThis.__taskModalLaunchTasksStore = defineStore('task-modal-launch-tasks', {
    actions: {
      async load() { return { title: 'Обновить отчёт', description: 'Проверить результат' }; },
      async timer() {},
      async complete() {},
      async comment() {},
      async launchOptions(id, profile = '') {
        optionCalls.push([String(id), profile]);
        if (profile === 'project-beta') {
          return {
            profile: 'project-beta',
            profiles: ['project-beta'],
            routes: ['consilium-debug', 'feature'],
            defaultRoute: 'feature',
            routeOptions: {
              'consilium-debug': { deliveryMode: 'publish', instrumentationRequired: true },
              feature: { deliveryMode: 'publish', instrumentationRequired: false },
            },
            repositories: [{ name: 'project-beta', targetBranch: 'master' }],
            instrumentationSuggestions: ['project-beta:src/diagnostics.py'],
            diagnosisSuggestion: { kind: 'data', signal: 'Повторный запуск создаёт дубликаты' },
            profileContractError: null,
          };
        }
        return {
          profile: 'project-alpha',
          profiles: ['project-alpha', 'project-beta'],
          routes: [],
          defaultRoute: null,
          error: 'no_catalog',
          message: 'каталог маршрутов профиля не опубликован',
        };
      },
      async launch(id, payload) {
        launchCalls.push([String(id), payload]);
        return { outcome: 'launched', profile: payload.profile, route: payload.route };
      },
    },
  });
  globalThis.__taskModalLaunchBoardStore = defineStore('task-modal-launch-board', {
    state: () => ({
      data: {
        tasks: [{ id: 42, title: 'Обновить отчёт', group: 'Проект Бета' }],
        toReview: [], created: [], accomplice: [], auditor: [],
      },
    }),
    actions: { async load() {} },
  });
  globalThis.__taskModalLaunchAnalysisStore = defineStore('task-modal-launch-analysis', {
    actions: {
      async detail() { return { analysis: { route_guess: 'feature' } }; },
      async analyze() {},
    },
  });
  globalThis.__taskModalLaunchFavoritesStore = defineStore('task-modal-launch-favorite', {
    state: () => ({ taskIds: [], loaded: true, loading: false, error: null, pending: {} }),
    getters: {
      isFavorite: () => () => false,
      isPending: () => () => false,
    },
    actions: { async load() {}, async toggle() {} },
  });
  // Открытая задача перестаёт быть новой; форме запуска отметка безразлична.
  globalThis.__taskModalLaunchSeenStore = defineStore('task-modal-launch-seen', {
    state: () => ({ taskIds: [], loaded: true, initialized: true, loading: false, error: null }),
    getters: {
      isSeen: () => () => false,
      ready: () => true,
    },
    actions: { async load() {}, async markSeen() { return true; } },
  });

  const wrapper = mount(await compileTaskModal('__taskModalLaunch'), {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()], stubs: { teleport: true } },
  });
  t.after(() => {
    wrapper.unmount();
    browser.close();
    for (const key of [
      '__taskModalLaunchApi',
      '__taskModalLaunchRunnerDisplay',
      '__taskModalLaunchUiStore',
      '__taskModalLaunchTasksStore',
      '__taskModalLaunchBoardStore',
      '__taskModalLaunchAnalysisStore',
      '__taskModalLaunchFavoritesStore',
      '__taskModalLaunchSeenStore',
    ]) delete globalThis[key];
  });
  await flushPromises();

  await wrapper.get('[data-role="task-launch-open"]').trigger('click');
  await flushPromises();
  const profile = wrapper.get('#launch-profile');
  assert.deepEqual(profile.findAll('option').map((option) => option.text()), ['project-alpha', 'project-beta']);
  assert.match(wrapper.text(), /каталог маршрутов профиля не опубликован/);
  assert.equal(wrapper.get('[data-role="task-launch-submit"]').attributes('disabled'), '');

  await profile.setValue('project-beta');
  await flushPromises();
  assert.equal(wrapper.get('#launch-route').element.value, 'feature');
  assert.match(wrapper.text(), /debug/);
  assert.equal(wrapper.find('#launch-profile').exists(), false);
  assert.match(wrapper.get('[aria-label="Параметры запуска"]').text(), /project-beta/);
  assert.match(wrapper.get('[aria-label="Параметры запуска"]').text(), /project-beta\/master/);
  assert.equal(wrapper.find('[aria-label="Целевая ветка project-beta"]').exists(), false);
  assert.equal(wrapper.get('.ladvanced').attributes('open'), undefined);
  assert.match(wrapper.get('.ladvanced').text(), /Целевые ветки из конфигурации профиля/);

  await wrapper.get('#launch-route').setValue('consilium-debug');
  await flushPromises();
  assert.equal(wrapper.get('#launch-instrumentation').element.value, 'project-beta:src/diagnostics.py');
  assert.equal(wrapper.get('#launch-diagnosis-kind').element.value, 'data');
  assert.equal(wrapper.get('#launch-diagnosis-signal').element.value, 'Повторный запуск создаёт дубликаты');
  await wrapper.get('#launch-route').setValue('feature');
  await flushPromises();

  await wrapper.get('[data-role="task-launch-submit"]').trigger('click');
  await flushPromises();
  assert.deepEqual(optionCalls, [['42', ''], ['42', 'project-beta']]);
  assert.equal(launchCalls.length, 1);
  assert.equal(launchCalls[0][0], '42');
  assert.equal(launchCalls[0][1].profile, 'project-beta');
  assert.equal(launchCalls[0][1].route, 'feature');
  assert.equal(launchCalls[0][1].title, 'Обновить отчёт');
  assert.deepEqual(launchCalls[0][1].acceptanceCriteria, []);
  assert.equal(Object.hasOwn(launchCalls[0][1], 'deliveryTargets'), false);
  assert.deepEqual(launchCalls[0][1].instrumentationFiles, []);
  assert.equal(Object.hasOwn(launchCalls[0][1], 'ticket'), false);
  assert.equal(Object.hasOwn(launchCalls[0][1], 'generation'), false);
  assert.equal(Object.hasOwn(launchCalls[0][1], 'runnerPrimary'), false);
});

test('TaskModal: исполнитель по умолчанию «из профиля», runnerPrimary уходит только при явном выборе', async (t) => {
  const { wrapper, flushPromises, launchCalls } = await mountLaunchForm(t, {
    launchOptions: async () => ({
      profile: 'project-alpha',
      profiles: ['project-alpha'],
      routes: ['feature'],
      defaultRoute: 'feature',
      routeOptions: { feature: { deliveryMode: 'publish', instrumentationRequired: false } },
      repositories: [{ name: 'project-alpha', targetBranch: 'main' }],
      runners: ['claude', 'codex'],
      defaultRunner: 'claude',
    }),
  });

  await wrapper.get('[data-role="task-launch-open"]').trigger('click');
  await flushPromises();

  const runner = wrapper.get('#launch-runner');
  assert.deepEqual(
    runner.findAll('option').map((option) => option.text()),
    ['Из профиля (Claude)', 'Claude', 'Codex'],
  );
  assert.equal(runner.element.value, '');

  // Без выбора исполнителя payload его не несёт — решение остаётся за профилем.
  await wrapper.get('[data-role="task-launch-submit"]').trigger('click');
  await flushPromises();
  assert.equal(launchCalls.length, 1);
  assert.equal(Object.hasOwn(launchCalls[0][1], 'runnerPrimary'), false);

  // Явный выбор — runnerPrimary уезжает в launch.
  await wrapper.get('[data-role="task-launch-open"]').trigger('click');
  await flushPromises();
  await wrapper.get('#launch-runner').setValue('codex');
  await wrapper.get('[data-role="task-launch-submit"]').trigger('click');
  await flushPromises();
  assert.equal(launchCalls.length, 2);
  assert.equal(launchCalls[1][1].runnerPrimary, 'codex');
});

test('TaskModal: смена профиля сбрасывает выбор исполнителя на «из профиля»', async (t) => {
  const catalog = (override) => ({
    profiles: ['project-alpha', 'project-beta'],
    routes: ['feature'],
    defaultRoute: 'feature',
    routeOptions: { feature: { deliveryMode: 'publish', instrumentationRequired: false } },
    repositories: [{ name: 'repo', targetBranch: 'main' }],
    ...override,
  });
  const { wrapper, flushPromises, launchCalls } = await mountLaunchForm(t, {
    launchOptions: async (id, profile = '') => (profile === 'project-beta'
      ? catalog({ profile: 'project-beta', runners: ['codex'], defaultRunner: 'codex' })
      : catalog({ profile: 'project-alpha', runners: ['claude', 'codex'], defaultRunner: 'claude' })),
  });

  await wrapper.get('[data-role="task-launch-open"]').trigger('click');
  await flushPromises();
  await wrapper.get('#launch-runner').setValue('codex');
  assert.equal(wrapper.get('#launch-runner').element.value, 'codex');

  // У нового профиля свой набор исполнителей и свой primary — прошлый выбор терять обязаны.
  await wrapper.get('#launch-profile').setValue('project-beta');
  await flushPromises();
  const runner = wrapper.get('#launch-runner');
  assert.equal(runner.element.value, '');
  assert.deepEqual(
    runner.findAll('option').map((option) => option.text()),
    ['Из профиля (Codex)', 'Codex'],
  );

  await wrapper.get('[data-role="task-launch-submit"]').trigger('click');
  await flushPromises();
  assert.equal(launchCalls.length, 1);
  assert.equal(launchCalls[0][1].profile, 'project-beta');
  assert.equal(Object.hasOwn(launchCalls[0][1], 'runnerPrimary'), false);
});

// Объём из триажа — предзаполнение критериев приёмки: человек видит и правит объём до
// конвейера, а «не делаем» показано рядом с причинами. Своё введённое (даже стёртое до
// пустоты) смена профиля не перезаписывает подсказкой.
test('TaskModal: критерии предзаполняются объёмом триажа, список «не делаем» показан рядом', async (t) => {
  const catalog = (override) => ({
    profiles: ['project-alpha', 'project-beta'],
    routes: ['small'],
    defaultRoute: 'small',
    routeOptions: { small: { deliveryMode: 'publish', instrumentationRequired: false } },
    repositories: [{ name: 'repo', targetBranch: 'main' }],
    scopeSuggestion: {
      criteria: ['Пустая ячейка подсказывает, как снять выбранный тип', 'Окно называет тип и число фраз'],
      skip: ['Раздел «Частота» — по ответу человека'],
    },
    ...override,
  });
  const { wrapper, flushPromises, launchCalls } = await mountLaunchForm(t, {
    launchOptions: async (id, profile = '') => (profile === 'project-beta'
      ? catalog({ profile: 'project-beta' })
      : catalog({ profile: 'project-alpha' })),
  });

  await wrapper.get('[data-role="task-launch-open"]').trigger('click');
  await flushPromises();
  const criteria = wrapper.get('[data-role="task-launch-note"]');
  assert.equal(
    criteria.element.value,
    'Пустая ячейка подсказывает, как снять выбранный тип\nОкно называет тип и число фраз',
  );
  assert.match(wrapper.get('[data-role="task-launch-scope-skip"]').text(), /Раздел «Частота» — по ответу человека/);

  // Человек стёр подсказку — смена профиля не возвращает её.
  await criteria.setValue('');
  await wrapper.get('#launch-profile').setValue('project-beta');
  await flushPromises();
  assert.equal(wrapper.get('[data-role="task-launch-note"]').element.value, '');

  await wrapper.get('[data-role="task-launch-note"]').setValue('Своя формулировка');
  await wrapper.get('[data-role="task-launch-submit"]').trigger('click');
  await flushPromises();
  assert.equal(launchCalls.length, 1);
  assert.deepEqual(launchCalls[0][1].acceptanceCriteria, ['Своя формулировка']);
});
