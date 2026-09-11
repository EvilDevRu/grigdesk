// Страница «Презентации»: карточка ролика.
//
// Сеть страницы не касается: подменяется слой операций раздела, а проверяется то,
// что страница показывает и что передаёт службе. Главное здесь — не дать человеку
// принять за готовое то, что готовым не является: собранный из прошлой редакции
// ролик помечен предыдущим, а сборка недоступна, пока сцены не свежие.
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const VIEW = webFile('src/views/ShowcaseView.vue');

const UI_STUB = `
export { default as UiActionLink } from '${webFile('src/components/primitives/UiActionLink.vue')}';
export { default as UiAudio } from '${webFile('src/components/primitives/UiAudio.vue')}';
export { default as UiButton } from '${webFile('src/components/primitives/UiButton.vue')}';
export { default as UiInput } from '${webFile('src/components/primitives/UiInput.vue')}';
export { default as UiSelect } from '${webFile('src/components/primitives/UiSelect.vue')}';
export { default as UiSpinner } from '${webFile('src/components/primitives/UiSpinner.vue')}';
export { default as UiTextarea } from '${webFile('src/components/primitives/UiTextarea.vue')}';
export { default as UiVideo } from '${webFile('src/components/primitives/UiVideo.vue')}';
export { default as UiField } from '${webFile('src/components/composites/UiField.vue')}';
export { default as UiFilePicker } from '${webFile('src/components/composites/UiFilePicker.vue')}';
export { default as UiFormActions } from '${webFile('src/components/composites/UiFormActions.vue')}';
export { default as UiTab } from '${webFile('src/components/composites/UiTab.vue')}';
export {
  default as UiDisclosureButton,
} from '${webFile('src/components/composites/UiDisclosureButton.vue')}';
export { default as UiTabs } from '${webFile('src/components/composites/UiTabs.vue')}';
export {
  default as UiSegmentedControl,
} from '${webFile('src/components/composites/UiSegmentedControl.vue')}';
export { default as UiInlineMessage } from '${webFile('src/components/feedback/UiInlineMessage.vue')}';
export const confirmDialog = async (text, options) => {
  globalThis.__showcaseViewHarness.confirmations.push({ text, options });
  return globalThis.__showcaseViewHarness.confirmed;
};
`;

const ACTIONS_STUB = `
const harness = () => globalThis.__showcaseViewHarness;
export const useShowcaseStore = () => harness().store;
export const watchShowcase = () => {
  harness().calls.push(['watch']);
  return () => harness().calls.push(['unwatch']);
};
export const loadShowcase = async () => { harness().calls.push(['load']); };
export const createShowcaseProject = async (store, input) => {
  harness().calls.push(['create', input]);
};
export const deleteShowcaseProject = async (store, id) => { harness().calls.push(['delete', id]); };
export const cancelShowcaseJob = async (store, id) => { harness().calls.push(['cancel', id]); };
export const openShowcaseProject = async (store, id) => { harness().calls.push(['open', id]); };
export const closeShowcaseProject = () => { harness().calls.push(['close']); };
export const analyzeShowcase = async () => { harness().calls.push(['analyze']); };
export const buildShowcaseFilm = async (store, onStage) => {
  harness().calls.push(['build']);
  onStage?.('Записываю сцены');
  onStage?.('');
  return true;
};
export const loadSeedStatus = async () => harness().seed;
export const prepareShowcaseData = async (store, recipe) => { harness().calls.push(['seed', recipe]); };
export const markShowcaseDataUpdated = async () => { harness().calls.push(['data-updated']); };
export const addShowcaseScene = async (store, draft) => { harness().calls.push(['add-scene', draft]); };
export const updateShowcaseScene = async (store, id, patch) => {
  harness().calls.push(['update-scene', id, patch]);
};
export const removeShowcaseScene = async (store, id) => { harness().calls.push(['remove-scene', id]); };
export const reorderShowcaseScenes = async (store, order) => {
  harness().calls.push(['reorder', order]);
};
export const importShowcaseAudio = async (store, id, file) => {
  harness().calls.push(['audio', id, file.name]);
};
export const loadShowcaseVoices = async (store) => {
  harness().calls.push(['voices']);
  store.setVoices(harness().voices);
};

export const installShowcaseVoice = async (store, voiceId) => {
  harness().calls.push(['install-voice', voiceId]);
};
export const cancelShowcaseVoiceInstall = async () => {
  harness().calls.push(['cancel-voice-install']);
};
export const setShowcaseVoice = async (store, choice) => {
  harness().calls.push(['set-voice', choice]);
};
`;

const API_STUB = `
export const showcaseApi = {
  artifactUrl: (projectId, artifactId) => '/api/showcase/' + projectId + '/artifacts/' + artifactId,
  doctor: async () => ({ operations: [], checkedAt: '2026-09-09T10:00:00.000Z' }),
  voicePreviewUrl: (voiceRef) => '/api/showcase/voices/preview?voiceRef=' + voiceRef,
};
export const showcaseErrorMessage = (error, fallback) => fallback;
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
      tone: null, pace: null, emphasis: [], pauses: [], stresses: [],
    },
    timing: null,
    audioSource: { kind: 'recorded', voiceRef: null, artifactId: 'audio-1' },
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

function targetChoice(overrides = {}) {
  return {
    ref: { kind: 'project', id: 'parser' },
    profile: 'parser',
    label: 'parser · постоянный стенд',
    viewUrl: 'http://127.0.0.1:13000',
    viewPort: null,
    status: 'ready',
    reason: '',
    screenCount: 2,
    ...overrides,
  };
}

function project(overrides = {}) {
  return {
    schemaVersion: 1,
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
        screens: [{ id: 'overview', title: 'Обзор', path: '/' }],
        targetFingerprint: 'target',
        policyRevision: 'policy',
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

/**
 * Страница монтируется на двойнике стора: проверяется, что она показывает человеку
 * и что передаёт операциям. Настоящих роликов и сети здесь нет.
 */
async function mountView(t, {
  opened = project(),
  jobs = [],
  confirmed = true,
  seed = null,
  voices = voiceCatalog(),
  targets = [targetChoice()],
  loaded = true,
  error = '',
  url = 'http://cockpit.test/#/showcase',
} = {}) {
  const browser = await installUiBrowser(t, url);
  const calls = [];
  const harness = {
    confirmed,
    confirmations: [],
    calls,
    seed,
    voices,
    store: {
      targets,
      projects: [],
      jobs,
      limits: {
        maxScenes: 20, maxSceneSeconds: 120, maxTotalSeconds: 600, retentionDays: 30,
      },
      opened,
      loading: false,
      loaded,
      error,
      busyProjects: [],
      readyTargets: targets.filter((item) => item.status === 'ready'),
      activeJobs: jobs.filter((job) => job.state === 'running'),
      blockedProjects: [],
      jobsOf: () => jobs,
      isBusy: () => false,
      setOpened: () => {},
      setError: () => {},
      voices,
      voiceBusy: false,
      setVoices(catalog) {
        this.voices = catalog;
      },
    },
  };

  globalThis.__showcaseViewHarness = harness;

  const component = await compileVue(VIEW, {
    stubs: {
      '../actions/showcase': ACTIONS_STUB,
      '../shared/showcaseApi': API_STUB,
      '../ui': UI_STUB,
      '../../ui': UI_STUB,
    },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, { attachTo: browser.document.querySelector('#mount') });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__showcaseViewHarness;
  });

  await flushPromises();

  return {
    wrapper, flushPromises, calls, harness,
  };
}

function buttonByText(wrapper, text) {
  return wrapper.findAll('button').find((button) => button.text().includes(text));
}

test('без доступных стендов форма ведёт в песочницы без ручных полей', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: null,
    targets: [],
  });

  assert.match(wrapper.text(), /Нет стендов для записи/);
  assert.doesNotMatch(wrapper.text(), /Профиль показа|Номер стенда/);
  assert.equal(wrapper.find('a[href="#/sandboxes"]').text(), 'Открыть песочницы');
});

test('форма выбирает живую цель и не отправляет профиль или номер отдельными полями', async (t) => {
  const targets = [
    targetChoice(),
    targetChoice({
      ref: { kind: 'sandbox', id: '990001' },
      profile: 'arsenkin',
      label: 'arsenkin · стенд t990001',
      viewUrl: null,
      viewPort: 5192,
      screenCount: 0,
    }),
  ];
  const { wrapper, flushPromises, calls } = await mountView(t, {
    opened: null,
    targets,
    url: 'https://cockpit.test/#/showcase',
  });

  assert.equal(
    wrapper.get('.showcase-create__target-link').attributes('href'),
    'http://127.0.0.1:13000',
    'постоянный стенд сохраняет опубликованный сервером адрес',
  );

  await wrapper.find('select[data-testid="showcase-create-target"]').setValue('sandbox:990001');

  assert.equal(
    wrapper.get('.showcase-create__target-link').attributes('href'),
    'https://p5192.cockpit.test/',
    'адрес песочницы строится через шлюз хоста, на котором открыт Cockpit',
  );

  await wrapper.find('.showcase-create__form').trigger('submit');
  await flushPromises();

  assert.deepEqual(calls.filter(([name]) => name === 'create'), [[
    'create',
    { ref: { kind: 'sandbox', id: '990001' } },
  ]]);
  assert.equal(
    wrapper.find('input[data-testid="showcase-create-title"]').exists(),
    false,
    'имя ролику даёт сервер: поля названия в мастере нет',
  );
});

test('при готовом постоянном стенде форма всё равно ведёт к подъёму песочницы', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: null,
    targets: [targetChoice()],
  });

  assert.equal(wrapper.find('a[href="#/sandboxes"]').text(), 'Открыть песочницы');
});

test('ошибка загрузки не остаётся бесконечным поиском стендов', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: null,
    targets: [],
    loaded: false,
    error: 'Сервер не ответил.',
  });

  assert.match(wrapper.text(), /Не удалось загрузить стенды/);
  assert.doesNotMatch(wrapper.text(), /Ищем доступные стенды/);
});

test('причина недоступности стенда видна вне отключённого пункта списка', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: null,
    targets: [targetChoice({
      status: 'blocked',
      reason: 'Стенд сейчас не отвечает.',
    })],
  });

  assert.match(wrapper.text(), /parser · постоянный стенд/);
  assert.match(wrapper.text(), /Стенд сейчас не отвечает/);
  assert.equal(wrapper.find('a[href="#/sandboxes"]').text(), 'Открыть песочницы');
});

test('цель без карты экранов остаётся доступной для базовой записи', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: null,
    targets: [targetChoice({ screenCount: 0 })],
  });

  assert.match(wrapper.text(), /Только начальный экран/);
  assert.match(wrapper.text(), /Можно записать начальный экран/);
  assert.equal(
    buttonByText(wrapper, 'Далее').attributes('aria-disabled'),
    undefined,
    'отсутствие карты не блокирует первый шаг мастера',
  );
});

test('предположенная привязка песочницы называет безопасные ограничения', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: null,
    targets: [targetChoice({
      ref: { kind: 'sandbox', id: '990001' },
      profile: 'arsenkin',
      profileBinding: 'inferred',
      label: 'arsenkin · стенд t990001',
      viewUrl: null,
      viewPort: 5192,
      screenCount: 0,
    })],
  });

  assert.match(wrapper.text(), /Привязка профиля к песочнице не подтверждена/);
  assert.match(wrapper.text(), /подготовка данных отключены/);
  assert.doesNotMatch(wrapper.text(), /Карта экранов не настроена/);
});

test('неготовый голос виден с причиной, а поставить его можно кнопкой', async (t) => {
  const { wrapper, calls } = await mountView(t, { opened: null });

  assert.match(wrapper.text(), /Локальный синтез не установлен/);
  assert.match(wrapper.text(), /56 МБ/, 'размер назван до нажатия');

  const install = wrapper.find('[data-testid="showcase-voice-install-irina"]');

  assert.ok(install.exists(), 'кнопка установки обязана быть у недоступного голоса');

  await install.trigger('click');
  await wrapper.vm.$nextTick();

  assert.deepEqual(
    calls.filter(([name]) => name === 'install-voice'),
    [['install-voice', 'irina']],
  );
});

test('идущая установка показывает шаг и даёт её отменить', async (t) => {
  const { wrapper, calls } = await mountView(t, {
    opened: null,
    voices: voiceCatalog({
      install: {
        available: [
          {
            id: 'irina',
            engineId: 'piper',
            name: 'Ирина',
            language: 'ru',
            timbre: 'женский',
            byteSize: 58_340_190,
            license: 'GPLv2',
            voices: ['Ирина'],
            installed: false,
          },
        ],
        job: {
          id: 'attempt-1',
          engineId: 'piper',
          voiceId: 'irina',
          state: 'running',
          step: 'voice',
          label: 'скачано 40%',
          error: null,
          startedAt: '2026-09-09T10:00:00.000Z',
          finishedAt: null,
        },
      },
    }),
  });

  assert.match(wrapper.text(), /Идёт установка/);
  assert.match(wrapper.text(), /скачано 40%/);

  const cancel = buttonByText(wrapper, 'Отменить');

  assert.ok(cancel, 'у идущей установки должна быть отмена');

  await cancel.trigger('click');
  await wrapper.vm.$nextTick();

  assert.ok(calls.some(([name]) => name === 'cancel-voice-install'));
});

test('оборвавшаяся установка называет причину, а не молчит', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: null,
    voices: voiceCatalog({
      install: {
        available: [
          {
            id: 'irina',
            engineId: 'piper',
            name: 'Ирина',
            language: 'ru',
            timbre: 'женский',
            byteSize: 58_340_190,
            license: 'GPLv2',
            voices: ['Ирина'],
            installed: false,
          },
        ],
        job: {
          id: 'attempt-1',
          engineId: 'piper',
          voiceId: 'irina',
          state: 'interrupted',
          step: 'packages',
          label: 'установка оборвалась',
          error: 'процесс установки исчез: повторите её, скачанное сохранено',
          startedAt: '2026-09-09T10:00:00.000Z',
          finishedAt: '2026-09-09T10:04:00.000Z',
        },
      },
    }),
  });

  assert.match(wrapper.text(), /Установка оборвалась/);
  assert.match(wrapper.text(), /скачанное сохранено/);
  assert.ok(
    wrapper.find('[data-testid="showcase-voice-install-irina"]').exists(),
    'повторить установку можно тем же нажатием',
  );
});

test('устаревшая сцена не гасит сборку: её снимут заново в той же команде', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: project({ scenes: [scene({ stale: true })] }),
  });
  const build = buttonByText(wrapper, 'Собрать ролик');

  assert.ok(build, 'кнопка сборки должна быть на экране ролика');
  assert.equal(build.attributes('disabled'), undefined);
  assert.match(wrapper.text(), /Нужна запись/);
});

test('сцена без звука не пускает в сборку и говорит почему', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: project({
      scenes: [
        scene({
          audio: null,
          audioSource: { kind: 'tts', voiceRef: null, artifactId: null },
        }),
      ],
    }),
  });

  assert.match(wrapper.text(), /Без звука/);
});

test('готовый ролик прошлой редакции помечен предыдущей сборкой', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: project({
      latestFinal: {
        video: artifact('final', 'final-1'),
        subtitles: artifact('subtitles', 'subtitles-1'),
        manifestId: 'manifest',
        builtAt: '2026-09-09T11:30:00.000Z',
        current: false,
      },
    }),
  });

  assert.match(wrapper.text(), /предыдущая сборка/);
  assert.ok(wrapper.find('video').exists(), 'ролик показывается прямо в разделе');
  assert.equal(
    wrapper.find('video').attributes('src'),
    '/api/showcase/project-1/artifacts/final-1',
    'плеер тянет файл через ручку раздела, а не по прямому пути',
  );
});

test('сборка уходит в операции без подтверждения, удаление сцены — с ним', async (t) => {
  const { wrapper, flushPromises, calls, harness } = await mountView(t, {
    opened: project({ scenes: [scene({ stale: true })] }),
  });

  await buttonByText(wrapper, 'Собрать ролик').trigger('click');
  await flushPromises();

  assert.deepEqual(calls.filter(([name]) => name === 'build'), [['build']]);
  assert.equal(harness.confirmations.length, 0, 'сборка ничего необратимого не делает');

  await buttonByText(wrapper, 'Удалить сцену').trigger('click');
  await flushPromises();

  assert.equal(harness.confirmations.length, 1, 'удаление сцены необратимо и спрашивается');
  assert.deepEqual(calls.filter(([name]) => name === 'remove-scene'), [['remove-scene', 'scene-1']]);
});

test('отказ от подтверждения не удаляет сцену', async (t) => {
  const { wrapper, flushPromises, calls } = await mountView(t, { confirmed: false });

  await buttonByText(wrapper, 'Удалить сцену').trigger('click');
  await flushPromises();

  assert.deepEqual(calls.filter(([name]) => name === 'remove-scene'), []);
});

test('перестановка отправляет ПОЛНЫЙ новый порядок', async (t) => {
  const { wrapper, flushPromises, calls } = await mountView(t, {
    opened: project({
      scenes: [
        scene({ id: 'scene-1', order: 1 }),
        scene({ id: 'scene-2', order: 2 }),
        scene({ id: 'scene-3', order: 3 }),
      ],
    }),
  });
  const down = wrapper.findAll('button').filter((button) => button.text() === 'Ниже');

  await down[0].trigger('click');
  await flushPromises();

  assert.deepEqual(
    calls.filter(([name]) => name === 'reorder'),
    [['reorder', ['scene-2', 'scene-1', 'scene-3']]],
  );
});

test('стадии озвучки нет отдельной кнопкой: она входит в сборку ролика', async (t) => {
  const { wrapper, flushPromises, calls } = await mountView(t, {
    opened: project({
      scenes: [scene({
        audioSource: { kind: 'tts', voiceRef: null, artifactId: null },
        audio: null,
        stale: true,
      })],
    }),
  });

  assert.equal(buttonByText(wrapper, 'Озвучить сцены'), undefined);

  await buttonByText(wrapper, 'Собрать ролик').trigger('click');
  await flushPromises();

  assert.deepEqual(calls.filter(([name]) => name === 'build'), [['build']]);
});

test('спорное место озвучки видно у своей сцены', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: project({
      scenes: [scene({
        checks: [{
          id: 'speech-1',
          kind: 'speech',
          status: 'warning',
          inputHash: 'input',
          artifactId: 'audio-1',
          reason: 'Расшифровка почти совпала, но отдельные слова не слышны.',
          textRange: null,
          suggestions: ['Не слышно: не'],
        }],
      })],
    }),
  });

  assert.match(wrapper.text(), /спорное место/);
  assert.match(wrapper.text(), /Не слышно: не/);
});

test('пропущенная проверка речи не выдаётся за пройденную', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: project({
      scenes: [scene({
        checks: [{
          id: 'speech-2',
          kind: 'speech',
          status: 'skipped',
          inputHash: 'input',
          artifactId: 'audio-1',
          reason: 'Распознавание недоступно: место придётся послушать самому.',
          textRange: null,
          suggestions: [],
        }],
      })],
    }),
  });

  assert.match(wrapper.text(), /проверка пропущена/);
  assert.ok(!/речь проверена/.test(wrapper.text()), 'пропуск не должен читаться как успех');
});

test('текст задачи в мастере не спрашивают: разбор берёт его сам', async (t) => {
  const { wrapper, flushPromises, calls } = await mountView(t, {
    opened: project({ brief: ['Показать обзор'] }),
  });

  assert.equal(buttonByText(wrapper, 'Предложить бриф'), undefined);
  assert.equal(buttonByText(wrapper, 'Предложить сцены'), undefined);

  await buttonByText(wrapper, 'Разобрать заново').trigger('click');
  await flushPromises();

  assert.deepEqual(
    calls.filter(([name]) => name === 'analyze'),
    [['analyze']],
    'связь стенда с задачей принадлежит серверу: браузер её не присылает',
  );
});

test('без объявленного рецепта кнопки подготовки нет, а причина названа', async (t) => {
  const { wrapper } = await mountView(t, {
    seed: {
      available: false,
      reason: 'Подготовка данных возможна только на изолированной демо-копии.',
      recipeFingerprint: '',
      profile: '',
      targetLabel: '',
    },
  });

  assert.match(wrapper.text(), /только на изолированной демо-копии/);
  assert.equal(
    buttonByText(wrapper, 'Подготовить данные'),
    undefined,
    'кнопки, которая ничего не может сделать, быть не должно',
  );
  assert.ok(buttonByText(wrapper, 'Данные обновлены'), 'отметка человека доступна всегда');
});

test('подготовка данных запускается только после подтверждения', async (t) => {
  const seed = {
    available: true,
    reason: '',
    recipeFingerprint: 'a'.repeat(32),
    profile: 'demo-profile',
    targetLabel: 'стенд 990001',
  };
  const denied = await mountView(t, { seed, confirmed: false });

  await buttonByText(denied.wrapper, 'Подготовить данные').trigger('click');
  await denied.flushPromises();

  assert.deepEqual(denied.calls.filter(([name]) => name === 'seed'), []);
  assert.match(denied.harness.confirmations[0].text, /изменит данные стенда/);
});

test('заблокированная цель объясняет причину и не даёт собирать', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: project({
      target: {
        status: 'blocked',
        ref: { kind: 'task', id: '990002' },
        reason: 'Стенд 990002 не найден в реестре.',
        nextAction: {
          kind: 'open-sandboxes',
          label: 'Открыть «Песочницы»',
          hint: 'Поднимите стенд задачи.',
        },
      },
      scenes: [scene({ stale: true })],
    }),
  });
  const build = buttonByText(wrapper, 'Собрать ролик');

  assert.match(wrapper.text(), /не найден в реестре/);
  assert.match(wrapper.text(), /Поднимите стенд задачи/);
  assert.ok(
    build.attributes('disabled') !== undefined
      || build.attributes('aria-disabled') === 'true',
    'без доступной цели записывать нечего',
  );
});
