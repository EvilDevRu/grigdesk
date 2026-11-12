import assert from 'node:assert/strict';
import test from 'node:test';

import { installUiBrowser } from './helpers/ui-components.js';
import { compileTaskModal } from './helpers/task-modal.js';
import { webFile } from './helpers/compile-vue.js';
import { multiCatalog, SOURCE_A, SOURCE_B } from './helpers/trackerMultiView.js';

process.env.NODE_ENV = 'test';

let nonce = 0;

/**
 * Вопросы и история имеют разные тексты при одном номере.
 * Поздний ответ A поэтому заметен в DOM карточки B без чтения внутренних refs.
 */
function detailFor(source) {
  const label = source === SOURCE_A ? 'A' : 'B';

  return {
    task: 42,
    source,
    analysis: {
      summary: `Оценка ${label}`,
      complexity: 2,
      risk: 1,
      questions: [{
        id: `q-${label}`,
        text: `Вопрос ${label}`,
        kind: 'factual',
        options: [],
      }],
    },
    status: { task: 42, state: 'done' },
    note: '',
    stale: [],
  };
}

/**
 * Каталог формы валиден и не требует инструментирования.
 * Выбор профиля и критерии остаются пользовательскими данными при перечитывании.
 */
function launchOptions(profile = 'alpha') {
  return {
    profile,
    profiles: ['alpha', 'beta'],
    routes: ['feature'],
    defaultRoute: 'feature',
    runners: ['codex'],
    defaultRunner: 'codex',
    routeOptions: { feature: { deliveryMode: 'disabled', instrumentationRequired: false } },
    repositories: [],
  };
}

/**
 * Настоящая карточка и analysisApi используют управляемый транспорт, stores и SSE.
 * Только ответ модели и серверное выполнение заменены валидными DTO.
 */
async function sourceCard(t, {
  defaultSource = SOURCE_B, heldA = false, phone = false, compact = false,
} = {}) {
  const browser = await installUiBrowser(t);

  browser.happyDOM.setWindowSize({ width: phone ? 390 : 1440, height: phone ? 844 : 1000 });
  browser.localStorage.setItem('grigdesk-ui-density', compact ? 'compact' : 'normal');

  if (phone) {
    browser.document.documentElement.setAttribute('data-ui-touch', '');
  }

  const prefix = `__sourceCard${nonce += 1}`;
  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  const calls = [];
  const listeners = new Set();
  const pendingDetail = Promise.withResolvers();
  const pendingClarifications = Promise.withResolvers();
  let holdDetail = heldA;
  let failOptions = false;
  const useUi = defineStore(`${prefix}-ui`, {
    state: () => ({
      taskId: 42,
      taskSource: SOURCE_A,
      launchRequested: false,
    }),
    actions: { close() {}, consumeTaskLaunch() {} },
  });
  const useBoard = defineStore(`${prefix}-board`, {
    state: () => ({
      data: {
        source: defaultSource,
        tasks: [],
        toReview: [],
        created: [],
      },
    }),
    actions: { async load() {} },
  });

  globalThis[`${prefix}Api`] = {
    /**
     * Разделяет запросы истории A и B по публичному source в URL.
     * Удержанная A завершится после переключения карточки.
     */
    async get(url) {
      calls.push({ method: 'GET', url });

      const parsed = new URL(url, 'http://fixture.test');
      const source = parsed.searchParams.get('source') || useUi().taskSource;

      if (parsed.pathname.endsWith('/clarifications')) {
        if (heldA && source === SOURCE_A) {
          return pendingClarifications.promise;
        }

        return { text: '', entries: [] };
      }

      if (url === '/api/tasks') {
        return { tasks: [] };
      }

      return {};
    },
    async post(url, body) {
      calls.push({
        method: 'POST',
        url,
        body: structuredClone(body),
      });

      return url.includes('/arbitrate')
        ? {
          ok: true,
          outcome: 'nothing_to_do',
          answered: 0,
        }
        : { text: 'Ответ сохранён', entries: [] };
    },
    async upload() {
      return {};
    },
  };
  globalThis[`${prefix}UiStore`] = useUi;
  globalThis[`${prefix}BoardStore`] = useBoard;
  globalThis[`${prefix}TasksStore`] = defineStore(`${prefix}-tasks`, {
    actions: {
      async load() {
        return {
          id: 42,
          title: 'Постановка',
          description: 'Описание карточки',
          status: 3,
        };
      },
      async launchOptions(id, profile, source) {
        calls.push({
          method: 'OPTIONS',
          id,
          profile,
          source,
        });

        if (failOptions) {
          throw new Error('Сеть недоступна');
        }

        return launchOptions(profile);
      },
      async launch(id, body) {
        calls.push({
          method: 'LAUNCH',
          id,
          body: structuredClone(body),
        });

        return { outcome: 'launched' };
      },
    },
  });
  globalThis[`${prefix}AnalysisStore`] = defineStore(`${prefix}-analysis`, {
    actions: {
      /**
       * Сохраняет аргумент source, переданный настоящей карточкой.
       * Поздняя оценка A выдаётся отдельно от уже загруженной B.
       */
      async detail(id, source) {
        calls.push({
          method: 'DETAIL',
          id,
          source,
        });

        const target = source || useUi().taskSource;

        if (holdDetail && target === SOURCE_A) {
          return pendingDetail.promise;
        }

        return detailFor(target);
      },
      async analyze(id, options) {
        calls.push({
          method: 'ANALYZE',
          id,
          options,
        });

        return { outcome: 'queued' };
      },
    },
  });

  for (const suffix of ['FavoritesStore', 'SeenStore']) {
    globalThis[`${prefix}${suffix}`] = defineStore(`${prefix}-${suffix}`, {
      state: () => ({
        loaded: true,
        initialized: true,
        error: null,
        pending: {},
      }),
      getters: {
        ready: () => true,
        isFavorite: () => () => false,
        isPending: () => () => false,
        isSeen: () => () => true,
      },
      actions: {
        async load() {},
        async toggle() {},
        async markSeen() {},
      },
    });
  }

  globalThis[`${prefix}PluginsStore`] = () => ({
    loaded: true,
    enabled: (id) => id === 'analysis',
    byId: () => ({ enabled: true, values: { autoArbitrate: false } }),
  });
  globalThis[`${prefix}Trackers`] = {
    catalog: multiCatalog(),
    epoch: 1,
    async load() {},
    invalidate() {},
  };
  globalThis[`${prefix}Subscribe`] = (handler) => {
    listeners.add(handler);

    return () => listeners.delete(handler);
  };

  const component = await compileTaskModal(prefix, {
    compilerStubs: {
      '../stores/trackers.ts': `export const useTrackersStore = () => globalThis.${prefix}Trackers;`,
      '../shared/analysisApi.ts':
        `export { analysisApi } from ${JSON.stringify(webFile('src/shared/analysisApi.ts'))};`,
      './apiClient.ts': `export const api = globalThis.${prefix}Api;`,
    },
  });
  const wrapper = mount(component, {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()], stubs: { teleport: true } },
  });

  t.after(async () => {
    pendingDetail.resolve(detailFor(SOURCE_A));
    pendingClarifications.resolve({ text: '', entries: [] });
    await flushPromises();
    wrapper.unmount();

    for (const key of Object.keys(globalThis).filter((key) => key.startsWith(prefix))) {
      delete globalThis[key];
    }
  });
  await flushPromises();
  await flushPromises();

  return {
    wrapper,
    calls,
    flushPromises,
    ui: useUi(),
    board: useBoard(),
    failOptions(value) {
      failOptions = value;
    },
    emit(name) {
      listeners.forEach((listener) => listener(name, {}));
    },
    releaseDetail() {
      holdDetail = false;
      pendingDetail.resolve(detailFor(SOURCE_A));
    },
    releaseClarifications(failed = false) {
      if (failed) {
        pendingClarifications.reject(new Error('Старый запрос A отклонён'));
      } else {
        pendingClarifications.resolve({ text: 'Чужая история A', entries: [] });
      }
    },
  };
}

/**
 * Находит публичную кнопку по смыслу текста и проверяет доступность до клика.
 * Отсутствие кнопки остаётся обычным assertion нового поведения.
 */
async function clickText(fx, pattern) {
  const button = fx.wrapper.findAll('button').find((candidate) => pattern.test(candidate.text()));

  assert.ok(button, `Не найдена кнопка ${pattern}`);
  assert.equal(button.element.disabled, false);
  await button.trigger('click');
  await fx.flushPromises();
}

for (const phone of [false, true]) {
  for (const compact of [false, true]) {
    test(`SOURCE-CARD-01: A42 при default B, phone=${phone}, compact=${compact}`, async (t) => {
      const fx = await sourceCard(t, { phone, compact });
      const analyze = fx.wrapper.findAll('button')
        .find((button) => /[Пп]ереоценить|Оценить задачу/u.test(button.text()));

      assert.ok(analyze, 'Оценка включённой A доступна при default B');
      assert.equal(analyze.element.disabled, false);
      await analyze.trigger('click');
      await fx.flushPromises();

      const field = fx.wrapper.get('[data-role="task-clarification"]');

      await field.setValue('Ответ A');
      await clickText(fx, /Уточнить и переоценить/);
      await clickText(fx, /[Аа]рбитр/);

      const details = fx.calls.filter((call) => call.method === 'DETAIL');
      const analysisCalls = fx.calls.filter((call) => call.url?.includes('/clarifications')
        || call.url?.includes('/arbitrate'));

      assert.ok(details.length > 0);
      assert.ok(details.every((call) => call.source === SOURCE_A));
      assert.ok(analysisCalls.some((call) => call.method === 'POST' && call.body?.answers?.length === 1));

      for (const call of analysisCalls) {
        assert.equal(new URL(call.url, 'http://fixture.test').searchParams.get('source'), SOURCE_A);
      }

      assert.ok(fx.calls.filter((call) => call.method === 'ANALYZE')
        .every((call) => call.options?.source === SOURCE_A));
      await fx.wrapper.get('[data-role="task-launch-open"]').trigger('click');
      await fx.flushPromises();
      await fx.wrapper.get('[data-role="task-launch-note"]').setValue('Критерии A');
      await fx.wrapper.get('#launch-profile-native').setValue('beta');
      await fx.flushPromises();
      fx.emit('hello');
      await fx.flushPromises();

      const options = fx.calls.filter((call) => call.method === 'OPTIONS');

      assert.ok(options.length >= 3, 'initial, profile-change и refresh перечитывают параметры');
      assert.ok(options.every((call) => call.source === SOURCE_A));
      assert.equal(fx.wrapper.get('[data-role="task-launch-note"]').element.value, 'Критерии A');
      await fx.wrapper.get('[data-role="task-launch-submit"]').trigger('click');
      await fx.flushPromises();

      const launches = fx.calls.filter((call) => call.method === 'LAUNCH');

      assert.equal(launches.length, 1);
      assert.equal(launches[0].body.source, SOURCE_A);
    });
  }
}

test('SOURCE-CARD-RACE-01: поздняя оценка и история A не меняют B и черновик ответа', async (t) => {
  for (const rejected of [false, true]) {
    await t.test(rejected ? 'старый отказ истории' : 'старый успешный ответ', async (st) => {
      const fx = await sourceCard(st, { defaultSource: SOURCE_A, heldA: true });

      assert.ok(fx.calls.some((call) => call.method === 'DETAIL'), 'Запрос A удержан до смены карточки');
      fx.board.data.source = SOURCE_B;
      fx.ui.taskSource = SOURCE_B;
      await fx.flushPromises();
      await fx.flushPromises();

      const field = fx.wrapper.get('[data-role="task-clarification"]');

      await field.setValue('Черновик B');
      fx.releaseDetail();
      fx.releaseClarifications(rejected);
      await fx.flushPromises();

      assert.ok(fx.wrapper.text().includes('Вопрос B'));
      assert.equal(fx.wrapper.text().includes('Вопрос A'), false, 'Поздняя A не подменяет оценку B');
      assert.equal(fx.wrapper.get('[data-role="task-clarification"]').element.value, 'Черновик B');
      assert.equal(fx.wrapper.text().includes('Чужая история A'), false);
    });
  }
});

test('SOURCE-CARD-RACE-01: ошибка и retry сохраняют критерии и пару без повторного POST', async (t) => {
  const fx = await sourceCard(t);

  await fx.wrapper.get('[data-role="task-launch-open"]').trigger('click');
  await fx.flushPromises();
  await fx.wrapper.get('[data-role="task-launch-note"]').setValue('Критерии человека');
  fx.failOptions(true);
  fx.emit('hello');
  await fx.flushPromises();
  assert.equal(fx.wrapper.get('[data-role="task-launch-submit"]').element.disabled, true);
  fx.failOptions(false);
  fx.emit('hello');
  await fx.flushPromises();
  assert.equal(fx.wrapper.get('[data-role="task-launch-note"]').element.value, 'Критерии человека');
  assert.equal(fx.calls.some((call) => call.method === 'LAUNCH'), false);
  assert.ok(fx.calls.filter((call) => call.method === 'OPTIONS').every((call) => call.source === SOURCE_A));
});
