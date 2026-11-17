// Настоящие View, Pinia, actions и SSE: подменены только HTTP и внешняя оболочка.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const UI_STUB = `
export * from './src/ui.ts';
export { default as UiLoadingState } from './src/components/feedback/UiLoadingState.vue';
export { default as UiActionLink } from '${webFile('src/components/primitives/UiActionLink.vue')}';
export { default as UiAudio } from '${webFile('src/components/primitives/UiAudio.vue')}';
export { default as UiButton } from '${webFile('src/components/primitives/UiButton.vue')}';
export { default as UiCheckbox } from '${webFile('src/components/primitives/UiCheckbox.vue')}';
export { default as UiIconButton } from '${webFile('src/components/primitives/UiIconButton.vue')}';
export { default as UiInput } from '${webFile('src/components/primitives/UiInput.vue')}';
export { default as UiSelect } from '${webFile('src/components/primitives/UiSelect.vue')}';
export { default as UiSpinner } from '${webFile('src/components/primitives/UiSpinner.vue')}';
export { default as UiSwitch } from '${webFile('src/components/primitives/UiSwitch.vue')}';
export { default as UiTextarea } from '${webFile('src/components/primitives/UiTextarea.vue')}';
export { default as UiVideo } from '${webFile('src/components/primitives/UiVideo.vue')}';
export { default as UiField } from '${webFile('src/components/composites/UiField.vue')}';
export { default as UiFilePicker } from '${webFile('src/components/composites/UiFilePicker.vue')}';
export {
  default as UiDisclosureButton,
} from '${webFile('src/components/composites/UiDisclosureButton.vue')}';
export {
  default as UiDiscreteSlider,
} from '${webFile('src/components/composites/UiDiscreteSlider.vue')}';
export {
  default as UiSelectableRow,
} from '${webFile('src/components/composites/UiSelectableRow.vue')}';
export { default as UiInlineMessage } from '${webFile('src/components/feedback/UiInlineMessage.vue')}';
export { default as UiProgress } from '${webFile('src/components/feedback/UiProgress.vue')}';
export const confirmDialog = async (text, options) => {
  globalThis.__showcaseViewHarness.confirmations.push({ text, options });
  await globalThis.__showcaseViewHarness.confirmGate;
  return globalThis.__showcaseViewHarness.confirmed;
};
export const promptDialog = async (options) => {
  globalThis.__showcaseViewHarness.prompts.push(options);
  return globalThis.__showcaseViewHarness.promptValue;
};
`;

function artifact(kind, id) {
  return {
    id,
    kind,
    inputHash: 'input',
    contentHash: 'content',
    producerVersion: 'v1',
    durationMs: 3000,
    byteSize: 2048,
  };
}

function scene(overrides = {}) {
  return {
    id: 'scene-1',
    order: 1,
    title: 'Обзор',
    screenId: 'overview',
    startState: null,
    readyCondition: null,
    actions: [],
    narration: 'Открываем обзор.',
    caption: 'Обзор',
    subtitleText: 'Открываем обзор.',
    direction: {
      tone: null,
      pace: null,
      emphasis: [],
      pauses: [],
      stresses: [],
    },
    timing: null,
    audioSource: {
      kind: 'recorded',
      voiceRef: null,
      artifactId: 'audio-1',
    },
    audio: artifact('audio', 'audio-1'),
    clip: artifact('clip', 'clip-1'),
    frame: null,
    checks: [],
    stale: false,
    ...overrides,
  };
}

/**
 * Каталог голосов: движок неготов, а поставить его можно. Это и есть состояние
 * свежей установки, ради которого в разделе появилась кнопка.
 */
function voiceCatalog(overrides = {}) {
  return {
    engines: [
      {
        id: 'piper',
        name: 'Piper (локально)',
        kind: 'local',
        doctor: {
          status: 'blocked',
          reason: 'Локальный синтез не установлен.',
          install: 'Установите голос кнопкой в разделе.',
        },
        voices: [],
      },
    ],
    install: {
      available: [
        {
          id: 'irina',
          engineId: 'piper',
          name: 'Ирина',
          language: 'ru',
          timbre: 'женский',
          byteSize: 58_340_190,
          license: 'GPLv2 (обучен на корпусе RHVoice)',
          voices: ['Ирина'],
          installed: false,
        },
      ],
      job: null,
    },
    ...overrides,
  };
}

// Каталог с готовым движком: голос есть, установку на списке показывать незачем.
function readyVoiceCatalog() {
  return voiceCatalog({
    engines: [
      {
        id: 'piper',
        name: 'Piper (локально)',
        kind: 'local',
        doctor: {
          status: 'ready',
          reason: 'Голос установлен.',
          install: '',
        },
        voices: [{
          id: 'irina',
          name: 'Ирина',
          language: 'ru',
          available: true,
          reason: '',
          capabilities: {
            pace: true,
            pause: true,
            stress: true,
          },
        }],
      },
    ],
  });
}

function project(overrides = {}) {
  return {
    schemaVersion: 2,
    id: 'project-1',
    title: 'Ролик о готовой работе',
    revision: 3,
    ref: { kind: 'sandbox', id: '990001' },
    target: {
      status: 'ready',
      ref: { kind: 'sandbox', id: '990001' },
      scope: {
        targetKind: 'sandbox',
        targetLabel: 'стенд 990001',
        profile: 'demo-profile',
        viewUrl: 'http://127.0.0.1:5192',
        environment: 'read-only',
        capabilities: ['record'],
        screens: [{
          id: 'overview',
          title: 'Обзор',
          path: '/',
        }],
        targetFingerprint: 'target',
        policyRevision: 'policy',
        mapRevision: 'map',
        dataRevision: 'data',
        buildRevision: null,
      },
    },
    brief: [],
    scenes: [scene()],
    decisions: [],
    latestFinal: null,
    createdAt: '2026-09-09T10:00:00.000Z',
    updatedAt: '2026-09-09T11:00:00.000Z',
    ...overrides,
  };
}

function final(overrides = {}) {
  return {
    video: { ...artifact('final', 'final-1'), durationMs: 85_000 },
    subtitles: artifact('subtitles', 'subtitles-1'),
    manifestId: 'manifest',
    builtAt: '2026-09-09T11:30:00.000Z',
    current: true,
    ...overrides,
  };
}


let compiled;

/**
 * Настоящий редактор получает проверенные DTO через двойник общего транспорта.
 * Никакой owner/helper/action здесь не заменяется, router сохраняет реактивный intent.
 */
async function fixture(t) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/showcase/project-1');
  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const { createPinia, setActivePinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');
  const a = project({
    voiceRef: 'piper:irina', scenes: [scene({
      audioSource: {
        kind: 'tts',
        voiceRef: 'piper:irina',
        artifactId: null,
      },
    })]
  });
  const b = project({ id: 'project-2', title: 'Второй ролик' });
  const records = new Map([[a.id, a], [b.id, b]]);
  const route = reactive({ params: { id: a.id } });
  const listeners = new Set();
  const calls = [];
  const h = {
    calls,
    targets: [{
      ref: { kind: 'project', id: 'demo-profile' },
      profile: 'demo-profile',
      label: 'Проект',
      viewUrl: 'http://127.0.0.1:5173',
      viewPort: null,
      status: 'ready',
      reason: '',
      screenCount: 1,
    }],
    route,
    confirmed: true,
    confirmations: [],
    prompts: [],
    get: null,
    put: null,
    api: {
      url: (url) => url,
      get: async (url) => {
        calls.push(['get', url]);

        if (h.get) {
          const pending = h.get(url);

          if (pending) {
            return pending;
          }
        }

        if (url === '/api/showcase') {
          return {
            projects: [],
            targets: h.targets,
            profiles: [],
            jobs: [],
            buildRuns: [],
            limits: {
              maxScenes: 20,
              maxSceneSeconds: 120,
              maxTotalSeconds: 600,
              retentionDays: 30,
            },
          };
        }

        if (url === '/api/showcase/voices') {
          return readyVoiceCatalog();
        }

        if (url.endsWith('/dictionary')) {
          return {
            text: '',
            entries: [],
            errors: [],
          };
        }

        if (url.includes('/doctor')) {
          return { operations: [], checkedAt: new Date().toISOString() };
        }

        if (url.endsWith('/seed')) {
          return {
            available: false,
            reason: '',
            recipeFingerprint: '',
            profile: '',
            targetLabel: '',
          };
        }

        return records.get(url.split('/')[3]);
      },
      put: async (url, body) => {
        calls.push(['put', url, body]);

        if (h.put) {
          return h.put(url, body);
        }

        return records.get(url.split('/')[3]);
      },
      post: async (url) => {
        calls.push(['post', url]);

        return records.get(url.split('/')[3]);
      },
    },
    router: {
      replace: async (url) => {
        calls.push(['route', url]);
        route.params.id = url.replace('/showcase/', '');
      },
    },
  };

  globalThis.__showcaseViewHarness = h;
  globalThis.__showcaseOwnerHarness = { h, listeners };

  const stubs = {
    './apiClient.ts': `export const api = new Proxy({}, { get: (_, key) =>
      (...args) => globalThis.__showcaseOwnerHarness.h.api[key](...args) });`,
    '../../composables/useSse.ts': `export const sseSubscribe = (fn) => {
      const list = globalThis.__showcaseOwnerHarness.listeners;
      list.add(fn); return () => list.delete(fn);
    };`,
    'vue-router': `export const useRoute = () => globalThis.__showcaseViewHarness.route;
      export const useRouter = () => globalThis.__showcaseViewHarness.router;`,
    '../composables/useUiContextSource.ts': `export const useUiContextSource = () => ({
      focus() {}, blur() {}, clear() {}, update() {},
    });`,
    '../../stores/tasks': 'export const useTasksStore = () => ({ load: async () => {}, title: () => null });',
    '../ui': UI_STUB,
    '../../ui': UI_STUB,
  };

  compiled ??= compileModule(new URL('./helpers/showcaseOwnerGraph.js', import.meta.url).pathname, { stubs });

  const module = await compiled;
  const component = module.View;
  const dataActions = module;
  const buildActions = module;
  const pinia = createPinia();

  setActivePinia(pinia);

  const store = module.useShowcaseStore(pinia);

  store.setOpened(a);

  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [pinia] },
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__showcaseOwnerHarness;
    delete globalThis.__showcaseViewHarness;
  });
  await flushPromises();

  const emit = (name, data) => {
    for (const listener of listeners) {
      listener(name, data);
    }
  };

  return {
    h,
    a,
    b,
    route,
    store,
    dataActions,
    buildActions,
    wrapper,
    flushPromises,
    emit,
  };
}

for (const outcome of ['success', 'error']) {
  test(`реальный route intent A→B pending→A отвергает поздний ${outcome}`, { timeout: 10000 }, async (t) => {
    const { h, a, b, store, wrapper, route, emit, flushPromises } = await fixture(t);
    const old = Promise.withResolvers();
    const pendingB = Promise.withResolvers();
    let firstA = true;

    h.get = (url) => {
      if (url === '/api/showcase/project-1' && firstA) {
        firstA = false;

        return old.promise;
      }

      return url === '/api/showcase/project-2' ? pendingB.promise : null;
    };

    try {
      emit('showcase-changed', { projectId: a.id, revision: a.revision });
      await flushPromises();
      route.params.id = b.id;
      await flushPromises();
      assert.equal(store.opened.id, a.id);
      route.params.id = a.id;
      await flushPromises();
      await wrapper.find('.scene textarea:not([readonly])').setValue('Новый ввод');

      if (outcome === 'error') {
        old.reject(new Error('Поздний отказ A'));
      } else {
        old.resolve({ ...a, title: 'Устаревшее чтение' });
      }

      await flushPromises();
      pendingB.resolve(b);
      await flushPromises();
      assert.equal(store.opened.id, a.id);
      assert.equal(store.opened.title, a.title);
      assert.equal(store.error, '');
      assert.equal(wrapper.find('.scene textarea:not([readonly])').element.value, 'Новый ввод');
      assert.equal(h.calls.some(([name]) => name === 'route'), false);
    } finally {
      old.resolve(a);
      pendingB.resolve(b);
    }
  });
}

for (const operation of ['pending-save', 'set-voice']) {
  test(`реальная цепочка ${operation} не запускает адаптацию после перехода`, {
    timeout: 10000,
  }, async (t) => {
    const { h, a, b, store, wrapper, route, flushPromises } = await fixture(t);
    const answer = Promise.withResolvers();
    const entered = Promise.withResolvers();

    h.put = async () => {
      entered.resolve();

      return answer.promise;
    };

    try {
      if (operation === 'pending-save') {
        await wrapper.find('.scene textarea:not([readonly])').setValue('Моя реплика');
        await wrapper.find('[data-testid="showcase-adapt-retry"]').trigger('click');
      } else {
        await wrapper.find('[data-testid="showcase-voice-pace"] input[type="range"]').setValue('4');
      }

      await entered.promise;
      route.params.id = b.id;
      await flushPromises();
      await wrapper.find('.scene textarea:not([readonly])').setValue('Черновик B');
      answer.resolve({ ...a, revision: a.revision + 1 });
      await flushPromises();
      assert.equal(store.opened.id, b.id);
      assert.equal(wrapper.find('.scene textarea:not([readonly])').element.value, 'Черновик B');
      assert.equal(h.calls.some(([name, url]) => name === 'post' && url.endsWith('/adapt-narration')), false);
      assert.equal(store.error, '');
    } finally {
      answer.resolve(a);
    }
  });
}

for (const outcome of ['success', 'error', 'reload']) {
  test(`реальный attach ${outcome} сохраняет черновик B`, { timeout: 10000 }, async (t) => {
    const { h, a, b, store, wrapper, route, flushPromises } = await fixture(t);
    const answer = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const reload = Promise.withResolvers();
    const readEntered = Promise.withResolvers();

    h.put = async () => {
      entered.resolve();

      return answer.promise;
    };

    try {
      await wrapper.find('[data-testid="showcase-stand-attach"]').trigger('click');
      await entered.promise;

      if (outcome === 'reload') {
        h.get = (url) => {
          if (url === '/api/showcase/project-1') {
            readEntered.resolve();

            return reload.promise;
          }

          return null;
        };
        answer.reject({ data: { error: 'revision_conflict', message: 'Конфликт' } });
        await readEntered.promise;
      }

      route.params.id = b.id;
      await flushPromises();
      await wrapper.find('.scene textarea:not([readonly])').setValue('Черновик B');

      if (outcome === 'success') {
        answer.resolve({ ...a, revision: a.revision + 1 });
      } else if (outcome === 'error') {
        answer.reject(new Error('Отказ прежнего подключения'));
      } else {
        reload.resolve(a);
      }

      await flushPromises();
      assert.equal(store.opened.id, b.id);
      assert.equal(store.error, '');
      assert.equal(wrapper.find('.scene textarea:not([readonly])').element.value, 'Черновик B');
    } finally {
      answer.resolve(a);
      reload.resolve(a);
    }
  });
}

test('реальное создание с главной не навигирует поверх выбранного B', async (t) => {
  const { h, a, b, store, wrapper, route, flushPromises } = await fixture(t);
  const answer = Promise.withResolvers();
  const entered = Promise.withResolvers();

  route.params.id = '';
  await flushPromises();
  h.api.post = async () => {
    entered.resolve();

    return answer.promise;
  };

  try {
    await wrapper.find('[data-testid="showcase-new-film"]').trigger('click');
    await entered.promise;
    route.params.id = b.id;
    await flushPromises();
    await wrapper.find('.scene textarea:not([readonly])').setValue('Черновик B');
    answer.resolve({ ...a, id: 'project-new' });
    await flushPromises();
    assert.equal(route.params.id, b.id);
    assert.equal(store.opened.id, b.id);
    assert.equal(wrapper.find('.scene textarea:not([readonly])').element.value, 'Черновик B');
  } finally {
    answer.resolve(a);
  }
});


for (const action of ['prepare', 'mark', 'assemble']) {
  test(`поздний ${action} не отменяет открытие другого ролика`, { timeout: 10000 }, async (t) => {
    const { h, a, b, store, route, dataActions, buildActions, flushPromises } = await fixture(t);
    const response = Promise.withResolvers();
    const pendingB = Promise.withResolvers();
    let operation;

    h.api.post = async () => response.promise;
    h.get = (url) => url === '/api/showcase/project-2' ? pendingB.promise : null;

    try {
      operation = action === 'prepare'
        ? dataActions.prepareShowcaseData(store, 'recipe')
        : action === 'mark'
          ? dataActions.markShowcaseDataUpdated(store)
          : buildActions.assembleShowcase(store);
      await flushPromises();
      route.params.id = b.id;
      await flushPromises();
      response.resolve(action === 'assemble' ? {
        id: 'assemble-a',
        projectId: a.id,
        kind: 'assemble',
        state: 'queued',
        attempt: 1,
        sequence: 1,
        progress: {
          index: 0,
          total: 1,
          label: '',
        },
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      } : { state: 'succeeded', reason: 'Готово' });
      await operation;
      pendingB.resolve(b);
      await flushPromises();
      assert.equal(store.opened.id, b.id);
      assert.equal(store.error, '');
    } finally {
      response.resolve({ state: 'succeeded', reason: '' });
      pendingB.resolve(b);
      await operation;
    }
  });
}

test('поздняя готовность данных A не стирает готовность B', { timeout: 10000 }, async (t) => {
  const { h, a, b, store, route, wrapper, flushPromises } = await fixture(t);
  const oldSeed = Promise.withResolvers();
  const seedB = {
    available: true,
    reason: '',
    recipeFingerprint: 'recipe-b',
    profile: 'demo-profile',
    targetLabel: 'Стенд B',
  };

  h.get = (url) => url === '/api/showcase/project-1/seed' ? oldSeed.promise
    : url === '/api/showcase/project-2/seed' ? Promise.resolve(seedB) : null;

  try {
    store.setOpened(null);
    await flushPromises();
    store.setOpened(a);
    await flushPromises();
    route.params.id = b.id;
    await flushPromises();
    assert.equal(wrapper.findComponent({ name: 'ShowcaseFilm' }).props('seed').recipeFingerprint, 'recipe-b');
    oldSeed.resolve({ ...seedB, recipeFingerprint: 'recipe-a' });
    await flushPromises();
    assert.equal(wrapper.findComponent({ name: 'ShowcaseFilm' }).props('seed').recipeFingerprint, 'recipe-b');
  } finally {
    oldSeed.resolve(seedB);
  }
});

test('подключение другого стенда перечитывает его подготовку данных', { timeout: 10000 }, async (t) => {
  const { h, a, store, wrapper, flushPromises } = await fixture(t);

  h.get = (url) => url.endsWith('/seed') ? Promise.resolve({
    available: true,
    reason: '',
    recipeFingerprint: 'new-target-recipe',
    profile: 'other-profile',
    targetLabel: 'Другой стенд',
  }) : null;
  store.setOpened({
    ...a,
    revision: a.revision + 1,
    ref: { kind: 'project', id: 'other-profile' },
    target: {
      ...a.target,
      ref: { kind: 'project', id: 'other-profile' },
      scope: {
        ...a.target.scope,
        profile: 'other-profile',
        targetFingerprint: 'other-target',
      },
    },
  });
  await flushPromises();
  assert.equal(wrapper.findComponent({ name: 'ShowcaseFilm' }).props('seed').recipeFingerprint,
    'new-target-recipe');
});

test('ожидание рецепта новой цели скрывает прежний рецепт', { timeout: 10000 }, async (t) => {
  const { h, a, store, wrapper, flushPromises } = await fixture(t);
  const response = Promise.withResolvers();

  h.get = (url) => url.endsWith('/seed') ? response.promise : null;

  try {
    store.setOpened({
      ...a,
      revision: a.revision + 1,
      ref: { kind: 'project', id: 'other-profile' },
      target: {
        ...a.target,
        ref: { kind: 'project', id: 'other-profile' },
        scope: {
          ...a.target.scope,
          profile: 'other-profile',
          targetFingerprint: 'other-target',
        },
      },
    });
    await flushPromises();
    assert.equal(wrapper.findComponent({ name: 'ShowcaseFilm' }).props('seed'), null);
  } finally {
    response.resolve({
      available: false,
      reason: '',
      recipeFingerprint: '',
      profile: 'other-profile',
      targetLabel: 'Другой стенд',
    });
    await flushPromises();
  }
});
