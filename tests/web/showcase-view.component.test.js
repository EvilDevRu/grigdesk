// Страница «Презентации»: список роликов и экран ролика.
//
// Сеть страницы не касается: подменяется слой операций раздела, а проверяется то,
// что страница показывает и что передаёт службе. Главное здесь — не дать человеку
// принять за готовое то, что готовым не является: собранный из прошлой редакции
// ролик помечен предыдущим, несохранённая правка видна и уходит вместе со сборкой,
// а необратимое спрашивается.
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';

const VIEW = webFile('src/views/ShowcaseView.vue');

const UI_STUB = `
export { default as UiActionLink } from '${webFile('src/components/primitives/UiActionLink.vue')}';
export { default as UiAudio } from '${webFile('src/components/primitives/UiAudio.vue')}';
export { default as UiButton } from '${webFile('src/components/primitives/UiButton.vue')}';
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
  return globalThis.__showcaseViewHarness.confirmed;
};
export const promptDialog = async (options) => {
  globalThis.__showcaseViewHarness.prompts.push(options);
  return globalThis.__showcaseViewHarness.promptValue;
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
  return 'project-new';
};
export const deleteShowcaseProject = async (store, id) => {
  harness().calls.push(['delete', id]);
  return true;
};
export const renameShowcaseProject = async (store, title) => {
  harness().calls.push(['rename', title]);
  return true;
};
export const cancelShowcaseJob = async (store, id) => { harness().calls.push(['cancel', id]); };
export const openShowcaseProject = async (store, id) => {
  harness().calls.push(['open', id]);
  return true;
};
export const closeShowcaseProject = () => { harness().calls.push(['close']); };
export const analyzeShowcase = async () => { harness().calls.push(['analyze']); };
export const generateShowcaseBindings = async () => {
  harness().calls.push(['generate-bindings']);
  return true;
};
export const buildShowcaseFilm = async () => {
  harness().calls.push(['build']);
  return true;
};
export const cancelShowcaseBuild = async (store, id) => {
  harness().calls.push(['cancel-build', id]);
  return true;
};
export const loadShowcaseManifest = async () => {
  harness().calls.push(['manifest']);
  return true;
};
export const loadSeedStatus = async () => harness().seed;
export const prepareShowcaseData = async (store, recipe) => { harness().calls.push(['seed', recipe]); };
export const markShowcaseDataUpdated = async () => { harness().calls.push(['data-updated']); };
export const addShowcaseScene = async (store, draft) => { harness().calls.push(['add-scene', draft]); };
export const updateShowcaseScene = async (store, id, patch) => {
  harness().calls.push(['update-scene', id, patch]);
  return harness().updateResult;
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
export const loadShowcaseVoicePreview = async (voiceRef) => {
  harness().calls.push(['preview', voiceRef]);

  return harness().preview(voiceRef);
};
export const loadShowcaseNarrationPreview = async (input, signal) => {
  harness().calls.push(['preview-narration', input]);

  return harness().narrationPreview(input, signal);
};
export const loadShowcaseDictionary = async (store) => {
  harness().calls.push(['dictionary']);
  store.setDictionary(harness().dictionary);
};
export const saveShowcaseDictionary = async (store, text) => {
  harness().calls.push(['save-dictionary', text]);
  return true;
};
export const SCRIPT_GAPS_INTRO = 'Эти пункты показаны ближайшим объявленным экраном:';
export const SCRIPT_GAPS_HINT = 'Ролик от этого не страдает.';
export const SCRIPT_OUTDATED_TEXT = 'Карта экранов профиля изменилась после разбора.';
export const showcaseScriptOutdated = (project) => Boolean(
  project && project.target.status === 'ready' && project.scenes.length
  && project.scriptMapRevision && project.target.scope.mapRevision
  && project.scriptMapRevision !== project.target.scope.mapRevision,
);
`;

const API_STUB = `
export const showcaseApi = {
  artifactUrl: (projectId, artifactId) => '/api/showcase/' + projectId + '/artifacts/' + artifactId,
  doctor: async () => globalThis.__showcaseViewHarness.doctor
    ?? { operations: [], checkedAt: '2026-09-09T10:00:00.000Z' },
  voicePreviewUrl: (voiceRef) => '/api/showcase/voices/preview?voiceRef=' + voiceRef,
};
export const showcaseErrorMessage = (error, fallback) => fallback;
`;

// Маршрут — реактивный объект двойника: страница читает из него открытый ролик, а
// переходы записываются как вызовы, чтобы тест видел, куда ушёл адрес.
const ROUTER_STUB = `
export const useRoute = () => globalThis.__showcaseViewHarness.route;
export const useRouter = () => globalThis.__showcaseViewHarness.router;
`;

const CONTEXT_STUB = `
const harness = () => globalThis.__showcaseViewHarness;
export const useUiContextSource = () => ({
  update(next) { harness().calls.push(['context-update', next]); return true; },
  focus(next) { harness().calls.push(['context-focus', next]); return true; },
  blur(next) { harness().calls.push(['context-blur', next]); return true; },
  dispose() { return true; },
});
`;

// Один и тот же граф ShowcaseView не компилируется и не импортируется заново для
// каждого из десятков сценариев. Data-URL модули V8 не выгружает до завершения
// процесса; прежний harness накапливал полные копии графа и уходил в swap.
let compiledViewPromise = null;

function showcaseViewComponent() {
  compiledViewPromise ??= compileVue(VIEW, {
    stubs: {
      '../actions/showcase': ACTIONS_STUB,
      '../../actions/showcase': ACTIONS_STUB,
      '../shared/showcaseApi': API_STUB,
      '../composables/useUiContextSource.ts': CONTEXT_STUB,
      'vue-router': ROUTER_STUB,
      '../ui': UI_STUB,
      '../../ui': UI_STUB,
    },
  });

  return compiledViewPromise;
}

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

// Каталог с готовым движком: голос есть, установку на списке показывать незачем.
function readyVoiceCatalog() {
  return voiceCatalog({
    engines: [
      {
        id: 'piper',
        name: 'Piper (локально)',
        kind: 'local',
        doctor: { status: 'ready', reason: 'Голос установлен.', install: '' },
        voices: [{
          id: 'irina',
          name: 'Ирина',
          language: 'ru',
          available: true,
          reason: '',
          capabilities: { pace: true, pause: true, stress: true },
        }],
      },
    ],
  });
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

function summary(overrides = {}) {
  return {
    id: 'project-1',
    title: 'Ролик о готовой работе',
    ref: { kind: 'sandbox', id: '990001' },
    targetLabel: 'стенд 990001',
    revision: 3,
    sceneCount: 1,
    state: 'ready',
    hasFinal: false,
    updatedAt: '2026-09-09T11:00:00.000Z',
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

/**
 * Страница монтируется на двойнике стора: проверяется, что она показывает человеку
 * и что передаёт операциям. Настоящих роликов и сети здесь нет.
 */
async function mountView(t, {
  opened = project(),
  projects = [],
  jobs = [],
  buildRuns = [],
  manifest = null,
  manifestStatus = 'idle',
  confirmed = true,
  promptValue = null,
  seed = null,
  voices = voiceCatalog(),
  dictionary = { text: '', entries: [], errors: [] },
  targets = [targetChoice()],
  loaded = true,
  error = '',
  analyzing = '',
  doctor = null,
  routeId = opened?.id ?? '',
  url = 'http://cockpit.test/#/showcase',
  preview = async () => new Blob(),
  narrationPreview = async () => new Blob(),
  updateResult = true,
} = {}) {
  const browser = await createUiBrowser(url);
  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const calls = [];
  const route = reactive({ params: { id: routeId } });
  const harness = {
    confirmed,
    preview,
    narrationPreview,
    updateResult,
    confirmations: [],
    promptValue,
    prompts: [],
    calls,
    seed,
    voices,
    dictionary,
    doctor,
    route,
    router: {
      async replace(to) {
        calls.push(['route', to]);
        route.params.id = String(to).replace(/^\/showcase\/?/, '');
      },
      async push(to) {
        calls.push(['route', to]);
        route.params.id = String(to).replace(/^\/showcase\/?/, '');
      },
    },
    store: {
      targets,
      projects,
      jobs,
      buildRuns,
      limits: {
        maxScenes: 20, maxSceneSeconds: 120, maxTotalSeconds: 600, retentionDays: 30,
      },
      opened,
      loading: false,
      loaded,
      error,
      analyzing,
      busyProjects: [],
      readyTargets: targets.filter((item) => item.status === 'ready'),
      activeJobs: jobs.filter((job) => job.state === 'running'),
      blockedProjects: [],
      jobsOf: () => jobs,
      latestBuildOf: () => buildRuns[0] ?? null,
      activeBuildOf: () => buildRuns.find((run) => (
        run.state === 'queued' || run.state === 'running' || run.state === 'cancelling'
      )) ?? null,
      isBusy: () => buildRuns.some((run) => (
        run.state === 'queued' || run.state === 'running' || run.state === 'cancelling'
      )),
      setOpened: () => {},
      setError: () => {},
      currentManifest: manifest,
      manifestStatus,
      voices,
      voiceBusy: false,
      setVoices(catalog) {
        this.voices = catalog;
      },
      dictionary,
      setDictionary(next) {
        this.dictionary = next;
      },
    },
  };

  globalThis.__showcaseViewHarness = harness;

  const component = await showcaseViewComponent();
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, { attachTo: browser.document.querySelector('#mount') });

  // Сначала снимаем Vue-наблюдатели и только потом закрываем DOM. Обратный порядок
  // оставлял runtime-dom с узлами уже закрытого Window и постепенно раздувал suite.
  // Тест может смонтировать страницу дважды, поэтому harness удаляется лишь своим
  // последним живым экземпляром.
  t.after(() => {
    wrapper.unmount();
    browser.close();

    if (globalThis.__showcaseViewHarness === harness) {
      delete globalThis.__showcaseViewHarness;
    }
  });

  await flushPromises();

  return {
    wrapper, flushPromises, calls, harness,
  };
}

function buttonByText(wrapper, text) {
  return wrapper.findAll('button').find((button) => button.text().includes(text));
}

function hasButton(wrapper, text) {
  return Boolean(buttonByText(wrapper, text));
}

function sceneRows(wrapper) {
  return wrapper.findAll('.board__row');
}

async function selectRow(wrapper, index) {
  await sceneRows(wrapper)[index].find('.ui-selectable-row__primary').trigger('click');
  await wrapper.vm.$nextTick();
}

test('без доступных стендов список ведёт в песочницы без ручных полей', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: null,
    targets: [],
  });

  assert.match(wrapper.text(), /Нет стендов для записи/);
  assert.doesNotMatch(wrapper.text(), /Профиль показа|Номер стенда/);
  assert.equal(wrapper.find('a[href="#/sandboxes"]').text(), 'Открыть песочницы');
});

test('у живого стенда одна кнопка «Снять ролик», а в операцию уходит только ссылка цели', async (t) => {
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
  const links = wrapper.findAll('.picker__link');

  assert.equal(
    links[0].attributes('href'),
    'http://127.0.0.1:13000',
    'постоянный стенд сохраняет опубликованный сервером адрес',
  );
  assert.equal(
    links[1].attributes('href'),
    'https://p5192.cockpit.test/',
    'адрес песочницы строится через шлюз хоста, на котором открыт Cockpit',
  );
  assert.equal(wrapper.find('select').exists(), false, 'выбор стенда — строки, а не список с «Далее»');

  await wrapper.find('[data-testid="showcase-create-sandbox:990001"]').trigger('click');
  await flushPromises();

  assert.deepEqual(calls.filter(([name]) => name === 'create'), [[
    'create',
    { ref: { kind: 'sandbox', id: '990001' } },
  ]]);
  assert.ok(calls.some(([name]) => name === 'build'), 'после создания сразу стартует полный run');
  assert.equal(
    calls.some(([name]) => name === 'analyze'),
    false,
    'разбор нового ролика выполняет серверная сборка, а не вторая команда браузера',
  );
  assert.equal(
    wrapper.find('input[data-testid="showcase-create-title"]').exists(),
    false,
    'имя ролику даёт сервер: поля названия нет',
  );
});

test('ролик про тот же стенд предлагается открыть, а не заводить второй', async (t) => {
  const { wrapper, flushPromises, calls } = await mountView(t, {
    opened: null,
    projects: [summary({
      ref: { kind: 'project', id: 'parser' },
      title: 'Проект parser',
      state: 'done',
    })],
  });
  const chip = wrapper.find('.picker__chip');

  assert.equal(chip.text(), 'ролик собран', 'состояние ролика названо чипом прямо у стенда');
  assert.equal(chip.attributes('data-tone'), 'good');
  assert.equal(hasButton(wrapper, 'Снять ролик'), false, 'главное действие — открыть ролик');
  assert.ok(buttonByText(wrapper, 'Снять новый'), 'второй ролик остаётся тихим действием');

  await wrapper.find('[data-testid="showcase-open-project:parser"]').trigger('click');
  await flushPromises();

  assert.deepEqual(calls.filter(([name]) => name === 'open'), [['open', 'project-1']]);
  assert.ok(
    calls.some(([name, to]) => name === 'route' && to === '/showcase/project-1'),
    'открытый ролик попадает в адрес — после F5 человек увидит его же',
  );
});

test('стенд без ролика так и подписан, а стенд задачи назван её названием', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: null,
    targets: [
      targetChoice(),
      targetChoice({
        ref: { kind: 'sandbox', id: '990001' },
        profile: 'arsenkin',
        label: 'arsenkin · стенд 990001 · ждёт приёмки',
        taskTitle: 'Массовый съём частотности по проектам',
        viewUrl: null,
        viewPort: 5192,
      }),
    ],
  });
  const rows = wrapper.findAll('.picker__item');

  assert.equal(rows.length, 2);
  assert.equal(rows[0].find('.picker__chip').text(), 'ролика нет');
  assert.equal(rows[0].find('.picker__label').text(), 'parser · постоянный стенд');
  assert.equal(
    rows[1].find('.picker__label').text(),
    'Массовый съём частотности по проектам',
    'по номеру человек задачу не узнаёт — первой строкой стоит её название',
  );
  assert.match(
    rows[1].find('.picker__meta').text(),
    /arsenkin · стенд 990001 · ждёт приёмки · карта: 2 экр\./,
    'подпись стенда с состоянием попытки переезжает во вторую строку',
  );
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

test('причина недоступности стенда видна рядом с самим стендом', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: null,
    targets: [targetChoice({
      status: 'blocked',
      reason: 'Стенд сейчас не отвечает.',
    })],
  });

  assert.match(wrapper.text(), /parser · постоянный стенд/);
  assert.match(wrapper.text(), /Стенд сейчас не отвечает/);
  assert.equal(hasButton(wrapper, 'Снять ролик'), false, 'снимать с мёртвого стенда нечего');
  assert.equal(wrapper.find('a[href="#/sandboxes"]').text(), 'Открыть песочницы');
});

test('цель без карты экранов остаётся доступной для базовой записи', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: null,
    targets: [targetChoice({ screenCount: 0 })],
  });

  assert.match(wrapper.text(), /только начальный экран/);
  assert.match(wrapper.text(), /Можно записать начальный экран/);
  assert.equal(
    buttonByText(wrapper, 'Снять ролик').attributes('aria-disabled'),
    undefined,
    'отсутствие карты не блокирует запись',
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

// Зелёные списки «всё установлено» ничего не решают: на списке роликов остаётся
// только то, что мешает, — неготовый голос или блокер записи с причиной.
test('готовая установка не занимает список роликов, а блокер назван одной строкой', async (t) => {
  const quiet = await mountView(t, {
    opened: null,
    voices: readyVoiceCatalog(),
    doctor: {
      operations: [
        { id: 'browser', title: 'Браузер записи', status: 'ready', reason: 'Chromium найден.', manual: false },
        { id: 'voice', title: 'Голос', status: 'ready', reason: 'Piper.', manual: false },
      ],
      checkedAt: '2026-09-09T10:00:00.000Z',
    },
  });

  assert.doesNotMatch(quiet.wrapper.text(), /Голос для озвучки не установлен/);
  assert.doesNotMatch(quiet.wrapper.text(), /Chromium найден|Всё готово|Готовность к записи/);

  const blocked = await mountView(t, {
    opened: null,
    voices: readyVoiceCatalog(),
    doctor: {
      operations: [
        {
          id: 'browser',
          title: 'Браузер записи',
          status: 'blocked',
          reason: 'Chromium не установлен.',
          manual: false,
        },
        { id: 'speech', title: 'Проверка речи', status: 'blocked', reason: 'Whisper нет.', manual: false },
      ],
      checkedAt: '2026-09-09T10:00:00.000Z',
    },
  });

  assert.match(blocked.wrapper.text(), /Записи мешает/);
  assert.match(blocked.wrapper.text(), /Браузер записи — Chromium не установлен/);
  assert.doesNotMatch(
    blocked.wrapper.text(),
    /Whisper нет/,
    'рекомендательная проверка речи блокером не считается',
  );
  assert.ok(blocked.wrapper.find('a[href="#/settings"]').exists(), 'блокер ведёт в настройки');
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

test('адрес с идентификатором открывает ролик после перезагрузки', async (t) => {
  const { calls } = await mountView(t, {
    opened: null,
    routeId: 'project-1',
  });

  assert.deepEqual(calls.filter(([name]) => name === 'open'), [['open', 'project-1']]);
});

test('«Ролики» закрывает карточку и возвращает адрес к разделу', async (t) => {
  const { wrapper, flushPromises, calls } = await mountView(t);

  await buttonByText(wrapper, 'Ролики').trigger('click');
  await flushPromises();

  assert.ok(calls.some(([name]) => name === 'close'));
  assert.ok(calls.some(([name, to]) => name === 'route' && to === '/showcase'));
});

// Разбор идёт минутами. Пока он идёт, человек видит ожидание, а не пустой план с
// предложением разобрать ещё раз.
test('идущий разбор показан ожиданием, а не пустым планом', async (t) => {
  const busy = await mountView(t, {
    opened: project({ scenes: [] }),
    analyzing: 'project-1',
  });

  assert.match(busy.wrapper.text(), /Разбираю задачу/);
  assert.doesNotMatch(busy.wrapper.text(), /Сцен пока нет/);
  assert.equal(hasButton(busy.wrapper, 'Собрать ролик'), false);

  const empty = await mountView(t, { opened: project({ scenes: [] }) });

  assert.match(empty.wrapper.text(), /Сцен пока нет/);
  assert.ok(buttonByText(empty.wrapper, 'Разобрать заново'), 'пустой план можно разобрать ещё раз');
  assert.ok(buttonByText(empty.wrapper, 'Добавить сцену'), 'или собрать сцены руками');
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
    opened: project({ latestFinal: final({ current: false }) }),
  });

  assert.match(wrapper.text(), /предыдущая сборка/);
  assert.ok(wrapper.find('video').exists(), 'ролик показывается прямо в разделе');
  assert.equal(
    wrapper.find('video').attributes('src'),
    '/api/showcase/project-1/artifacts/final-1',
    'плеер тянет файл через ручку раздела, а не по прямому пути',
  );
  assert.equal(
    buttonByText(wrapper, 'Смотреть в ролике'),
    undefined,
    'к сцене прошлой сборки переходить нельзя: её могли поменять',
  );
});

// Ролик 8665 пришлось смотреть целиком, чтобы понять, что сняла шестая сцена. Теперь
// у выбранной сцены есть своя запись и переход к ней в готовом ролике.
test('у выбранной сцены видна её запись, и к ней можно перейти в готовом ролике', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: project({
      latestFinal: final(),
      scenes: [
        scene({ id: 'scene-1', order: 1 }),
        scene({ id: 'scene-2', order: 2, clip: artifact('clip', 'clip-2') }),
      ],
    }),
  });
  const sources = wrapper.findAll('video').map((video) => video.attributes('src'));

  assert.deepEqual(sources, [
    '/api/showcase/project-1/artifacts/final-1',
    '/api/showcase/project-1/artifacts/clip-1',
  ], 'рядом с готовым роликом играет запись именно выбранной сцены');
  assert.ok(buttonByText(wrapper, 'Смотреть в ролике'));
  assert.match(sceneRows(wrapper)[1].text(), /0:04/, 'вторая сцена начинается после первой');
  assert.match(wrapper.text(), /собран .*1:25/, 'у готового ролика названа длина');

  await selectRow(wrapper, 1);

  assert.equal(
    wrapper.findAll('video')[1].attributes('src'),
    '/api/showcase/project-1/artifacts/clip-2',
    'запись следует за выбором сцены',
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

  await buttonByText(wrapper, 'Ниже').trigger('click');
  await flushPromises();

  assert.deepEqual(
    calls.filter(([name]) => name === 'reorder'),
    [['reorder', ['scene-2', 'scene-1', 'scene-3']]],
  );
});

// Правка первой сцены не должна пропасть, когда человек перешёл ко второй: список
// показывает, где правки не сохранены, а сборка сама записывает их перед съёмкой.
test('правка сцены переживает переход к другой сцене и уходит вместе со сборкой', async (t) => {
  const { wrapper, flushPromises, calls } = await mountView(t, {
    opened: project({
      scenes: [
        scene({ id: 'scene-1', order: 1, audioSource: { kind: 'tts', voiceRef: null, artifactId: null } }),
        scene({
          id: 'scene-2',
          order: 2,
          narration: 'Вторая сцена.',
          subtitleText: 'Вторая сцена.',
          audioSource: { kind: 'tts', voiceRef: null, artifactId: null },
        }),
      ],
    }),
  });

  await wrapper.find('.scene textarea').setValue('Открываем обзор и фильтр.');
  await flushPromises();

  assert.match(sceneRows(wrapper)[0].text(), /не сохранено/);

  await selectRow(wrapper, 1);

  assert.equal(wrapper.find('.scene textarea').element.value, 'Вторая сцена.');
  assert.match(sceneRows(wrapper)[0].text(), /не сохранено/, 'черновик первой сцены не потерян');
  assert.match(wrapper.text(), /несохранённые правки/);

  await buttonByText(wrapper, 'Собрать ролик').trigger('click');
  await flushPromises();

  const names = calls.map(([name]) => name);

  assert.ok(names.indexOf('update-scene') < names.indexOf('build'), 'правка уходит до съёмки');

  const [, id, patch] = calls.find(([name]) => name === 'update-scene');

  assert.equal(id, 'scene-1');
  assert.equal(patch.narration, 'Открываем обзор и фильтр.');
  assert.equal(patch.subtitleText, 'Открываем обзор и фильтр.', 'субтитр следует за речью');
});

test('ручная привязка выбирается выделением текста без миллисекунд', async (t) => {
  const narration = 'Сначала запускаем, затем показываем результат.';
  const { wrapper, flushPromises, calls } = await mountView(t, {
    opened: project({
      scenes: [scene({
        narration,
        subtitleText: narration,
        actions: [{ kind: 'click', targetId: 'run' }],
        syncBindings: null,
      })],
    }),
  });
  const canonical = wrapper.find('[data-role="binding-narration"]');
  const from = narration.indexOf('запускаем');

  canonical.element.setSelectionRange(from, from + 'запускаем'.length);
  await canonical.trigger('select');
  await flushPromises();
  await buttonByText(wrapper, 'Добавить связь').trigger('click');
  await flushPromises();

  assert.match(wrapper.text(), /«запускаем»/);
  assert.match(wrapper.text(), /начать вместе/);
  assert.match(wrapper.text(), /Привязки изменены и ещё не сохранены/);

  await wrapper.find('.scene__actions button').trigger('click');
  await flushPromises();

  const [, id, patch] = calls.find(([name]) => name === 'update-scene');

  assert.equal(id, 'scene-1');
  assert.equal('from' in patch, false, 'сырые смещения не становятся полями сцены');
  assert.deepEqual(patch.syncCues, [{
    actionIndex: 0,
    from,
    to: from + 'запускаем'.length,
    kind: 'align-start',
    manual: true,
  }]);
  assert.equal(patch.narration, narration, 'выбор связи не меняет исходный текст');
});

test('устаревшая сохранённая связь названа в редакторе', async (t) => {
  const narration = 'Показываем результат.';
  const from = narration.indexOf('результат');
  const { wrapper, flushPromises } = await mountView(t, {
    opened: project({
      scenes: [scene({
        narration,
        subtitleText: narration,
        actions: [{ kind: 'highlight', targetId: 'run' }],
        syncBindings: {
          version: 1,
          textHash: 'другая-редакция',
          actionsHash: 'другие-действия',
          cues: [{
            id: 'cue-stale',
            actionIndex: 0,
            from,
            to: from + 'результат'.length,
            kind: 'hold-through',
            origin: 'generated',
          }],
        },
      })],
    }),
  });

  await flushPromises();

  assert.match(wrapper.text(), /Привязки потеряли актуальность/);
});

test('конфликт черновика не запускает построение связей и не стирает ввод', async (t) => {
  const { wrapper, flushPromises, calls } = await mountView(t, {
    updateResult: false,
    opened: project({
      scenes: [scene({
        actions: [{ kind: 'click', targetId: 'run' }],
        syncBindings: null,
      })],
    }),
  });
  const narration = wrapper.find('.scene textarea:not([readonly])');

  await narration.setValue('Моя несохранённая реплика.');
  await flushPromises();
  await buttonByText(wrapper, 'Построить привязки').trigger('click');
  await flushPromises();

  assert.deepEqual(calls.filter(([name]) => name === 'generate-bindings'), []);
  assert.equal(
    calls.filter(([name]) => name === 'update-scene').length,
    1,
    'сначала сделана одна попытка сохранить черновик',
  );
  assert.equal(
    wrapper.find('.scene textarea:not([readonly])').element.value,
    'Моя несохранённая реплика.',
  );
  assert.match(wrapper.text(), /не сохранено/);
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

  assert.equal(hasButton(wrapper, 'Озвучить сцены'), false);

  await buttonByText(wrapper, 'Собрать ролик').trigger('click');
  await flushPromises();

  assert.deepEqual(calls.filter(([name]) => name === 'build'), [['build']]);
});

test('спорное место озвучки видно у своей сцены и в списке сцен', async (t) => {
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

  assert.match(wrapper.find('.scene').text(), /спорное место/);
  assert.match(wrapper.find('.scene').text(), /Не слышно: не/);
  assert.match(sceneRows(wrapper)[0].text(), /озвучка: Расшифровка почти совпала/);
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

// Повторный разбор заменяет сцены и уносит правки текста, поэтому при живых сценах
// он спрашивает. Текст задачи при этом не просят: связь стенда с задачей у сервера.
test('повторный разбор при живых сценах спрашивает и не просит текст задачи', async (t) => {
  const { wrapper, flushPromises, calls, harness } = await mountView(t, {
    opened: project({ brief: ['Показать обзор'] }),
  });

  assert.equal(hasButton(wrapper, 'Предложить бриф'), false);
  assert.equal(hasButton(wrapper, 'Предложить сцены'), false);
  assert.match(wrapper.text(), /Показать обзор/, 'план ролика виден');

  await buttonByText(wrapper, 'Разобрать заново').trigger('click');
  await flushPromises();

  assert.equal(harness.confirmations.length, 1);
  assert.match(harness.confirmations[0].text, /правки текста в них пропадут/);
  assert.deepEqual(calls.filter(([name]) => name === 'analyze'), [['analyze']]);

  const declined = await mountView(t, { confirmed: false });

  await buttonByText(declined.wrapper, 'Разобрать заново').trigger('click');
  await declined.flushPromises();

  assert.deepEqual(declined.calls.filter(([name]) => name === 'analyze'), []);
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

// Ролик 8665 снял шесть сцен наведения на одну ссылку, и по карточке этого было не
// видно: человек читал тексты диктора, а что запись сделает на экране — нет.
test('сцена в списке показывает свой экран и действия, а неподвижная — говорит об этом', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: project({
      scenes: [
        scene({
          id: 'scene-1',
          order: 1,
          actions: [
            { kind: 'waitVisible', targetId: 'rows' },
            { kind: 'click', targetId: 'selectPage' },
            { kind: 'wait', ms: 800 },
            { kind: 'highlight', targetId: 'bulkButton' },
          ],
        }),
        scene({ id: 'scene-2', order: 2, actions: [] }),
      ],
    }),
  });
  const plans = wrapper.findAll('.board__plan');

  assert.equal(plans.length, 2);
  assert.match(plans[0].text(), /Обзор/);
  assert.match(plans[0].text(), /клик: selectPage → подсветка: bulkButton/);
  assert.doesNotMatch(plans[0].text(), /rows|800/, 'ожидания и паузы в строку не попадают');
  assert.match(plans[1].text(), /без действий — неподвижный экран/);
  assert.match(wrapper.find('.scene__plan').text(), /клик: selectPage/, 'редактор повторяет план сцены');
});

// Пробелы карты — справка «за кадром» при плане, а не предупреждение оператору:
// ролик от них не ломается, а дополнять карту профиля — работа агента.
test('пробелы карты экранов — свёрнутая справка при плане, а не предупреждение', async (t) => {
  const opened = project({ scriptGaps: ['нет кнопки «Снять частотность» над таблицей'] });
  const { wrapper } = await mountView(t, { opened });
  const gaps = wrapper.find('.gaps');

  assert.ok(gaps.exists());
  assert.ok(wrapper.find('.film__brief .gaps').exists(), 'справка живёт при плане ролика');
  assert.equal(wrapper.find('.gaps .ui-inline-message').exists(), false, 'это не предупреждение');
  assert.match(gaps.find('button').text(), /За кадром: 1/);
  assert.equal(
    gaps.find('#showcase-script-gaps').isVisible(),
    false,
    'список свёрнут, пока человек его не открыл',
  );
  assert.match(wrapper.text(), /нет кнопки «Снять частотность» над таблицей/);
  assert.doesNotMatch(wrapper.text(), /screens\.json/, 'оператора не отправляют править JSON профиля');

  const quiet = await mountView(t, { opened: project({ scriptGaps: [] }) });

  assert.equal(quiet.wrapper.find('.gaps').exists(), false);
});

// Отказавшее задание называет причину один раз: подпись хода у него — тот же текст,
// и рядом с причиной она превращалась бы в эхо.
test('отказавшее задание показывает причину у кнопки сборки, а не повторяет её дважды', async (t) => {
  const reason = 'Вход на стенд не удался: форма входа осталась на экране.';
  const { wrapper } = await mountView(t, {
    jobs: [{
      id: 'job-record',
      projectId: 'project-1',
      kind: 'record',
      state: 'failed',
      attempt: 1,
      sequence: 4,
      progress: { index: 0, total: 6, label: reason },
      error: reason,
      startedAt: '2026-09-11T06:10:32.000Z',
      finishedAt: '2026-09-11T06:11:19.000Z',
    }],
  });
  const failure = wrapper.find('[data-role="build-failure"]');

  assert.ok(failure.exists(), 'последний отказ виден рядом с кнопкой сборки');
  assert.match(failure.text(), /запись — отказ/);
  assert.equal(failure.text().split('форма входа осталась').length - 1, 1, 'причина названа один раз');
  assert.ok(buttonByText(wrapper, 'Собрать ролик'), 'после отказа сборку можно повторить');
});

test('идущее задание показано ходом по сценам с отменой', async (t) => {
  const { wrapper, flushPromises, calls } = await mountView(t, {
    jobs: [{
      id: 'job-record',
      projectId: 'project-1',
      kind: 'record',
      state: 'running',
      attempt: 1,
      sequence: 2,
      progress: { index: 3, total: 9, label: 'пишем сцену «Позиции»' },
      error: null,
      startedAt: '2026-09-11T06:10:32.000Z',
      finishedAt: null,
    }],
  });

  assert.match(wrapper.text(), /Записываю сцены/);
  assert.match(wrapper.text(), /сцена 3 из 9 · пишем сцену «Позиции»/);
  assert.equal(hasButton(wrapper, 'Собрать ролик'), false, 'вторую сборку поверх идущей не запустить');
  assert.equal(wrapper.find('[role="progressbar"]').attributes('aria-valuenow'), '3');

  await buttonByText(wrapper, 'Отменить').trigger('click');
  await flushPromises();

  assert.deepEqual(calls.filter(([name]) => name === 'cancel'), [['cancel', 'job-record']]);
});

// «Разобрать заново» заменяет сцены целиком. Остановка сборки и отказ задания,
// случившиеся до этого, относятся к прежним сценам: их карточка читалась как новая
// ошибка сразу после разбора, хотя новую сборку ещё не запускали.
test('остановка сборки и отказ задания старше сценария не показываются как новые', async (t) => {
  const stoppedRun = {
    id: 'run-old',
    projectId: 'project-1',
    state: 'failed',
    sequence: 3,
    stage: 'record-if-needed',
    initialRevision: 1,
    children: [],
    cancelRequested: false,
    error: { code: 'child_failed', message: 'цепочка сцен «scene-old» не записалась.' },
    startedAt: '2026-09-11T06:10:00.000Z',
    updatedAt: '2026-09-11T06:12:00.000Z',
    finishedAt: '2026-09-11T06:12:00.000Z',
  };
  const failedJob = {
    id: 'job-old',
    projectId: 'project-1',
    kind: 'record',
    state: 'failed',
    attempt: 1,
    sequence: 4,
    progress: { index: 2, total: 7, label: 'сцена «scene-old» не записалась' },
    error: 'сцена «scene-old» не записалась',
    startedAt: '2026-09-11T06:10:32.000Z',
    finishedAt: '2026-09-11T06:11:19.000Z',
  };
  const reparsed = project({
    decisions: [{
      id: 'brief-1',
      kind: 'script',
      inputHash: 'showcase-script-7',
      decidedAt: '2026-09-12T03:07:20.000Z',
      note: 'Бриф предложен моделью и ждёт правки человека.',
    }],
  });
  const { wrapper } = await mountView(t, { opened: reparsed, buildRuns: [stoppedRun], jobs: [failedJob] });

  assert.equal(wrapper.find('[data-role="build-failure"]').exists(), false, 'старый отказ не показан');
  assert.ok(buttonByText(wrapper, 'Собрать ролик'), 'сборку можно запустить');

  // Тот же отказ после разбора — уже про нынешние сцены, и его видно.
  const laterRun = { ...stoppedRun, startedAt: '2026-09-12T04:00:00.000Z' };
  const current = await mountView(t, { opened: reparsed, buildRuns: [laterRun], jobs: [] });

  assert.match(current.wrapper.find('[data-role="build-failure"]').text(), /Сборка остановлена/);
});

// Карта экранов дописана после разбора: сборка переснимет прежние действия, и
// человек обязан узнать об этом до записи — прямо у кнопки сборки.
test('сцены старше карты экранов получают предупреждение у кнопки сборки', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: project({ scriptMapRevision: 'map-old' }),
  });

  assert.match(wrapper.text(), /Карта экранов профиля изменилась после разбора/);

  const fresh = await mountView(t, { opened: project({ scriptMapRevision: 'map' }) });

  assert.doesNotMatch(fresh.wrapper.text(), /изменилась после разбора/);
});

// Темп — пять ступеней на ползунке, и переводит их выбранный диктор; у голоса без
// темпа и у старого ответа без capabilities ползунка нет вовсе.
test('темп речи — ползунок из пяти ступеней, а голос без темпа его не показывает', async (t) => {
  const { wrapper, flushPromises, calls } = await mountView(t, { voices: readyVoiceCatalog() });
  const slider = wrapper.find('[data-testid="showcase-voice-pace"] input[type="range"]');

  assert.ok(slider.exists());
  assert.equal(slider.attributes('min'), '0');
  assert.equal(slider.attributes('max'), '4');
  assert.equal(slider.element.value, '2', 'без выбора ползунок стоит на обычном темпе');
  assert.match(wrapper.find('.voice__pace').text(), /Темп речи — Обычный/);

  await slider.setValue('4');
  await flushPromises();

  assert.deepEqual(
    calls.filter(([name]) => name === 'set-voice'),
    [['set-voice', { voiceRef: 'piper:irina', pace: 'fastest' }]],
  );

  const qwen = await mountView(t, {
    opened: project({
      scenes: [scene({ audioSource: { kind: 'tts', voiceRef: 'qwen:vivian', artifactId: null } })],
    }),
    voices: voiceCatalog({
      engines: [{
        id: 'qwen',
        name: 'Qwen3-TTS',
        kind: 'local',
        pace: false,
        doctor: { status: 'ready', reason: 'Установлен.', install: '' },
        voices: [{
          id: 'vivian',
          name: 'Вивиан',
          language: 'ru',
          available: true,
          reason: '',
          capabilities: { pace: false, pause: false, stress: false },
        }],
      }],
    }),
  });

  assert.equal(
    qwen.wrapper.find('[data-testid="showcase-voice-pace"]').exists(),
    false,
    'ползунок не показывается: этот движок темп не меняет',
  );
  assert.match(
    qwen.wrapper.find('[data-testid="showcase-voice-pace-note"]').text(),
    /Этот голос темп не меняет/,
  );
  assert.match(
    qwen.wrapper.find('[data-testid="showcase-voice-capabilities"]').text(),
    /Ударения: нет/,
  );

  const unknown = await mountView(t, {
    voices: voiceCatalog({
      engines: [{
        id: 'old',
        name: 'Старый backend',
        kind: 'local',
        doctor: { status: 'ready', reason: 'Готов.', install: '' },
        voices: [{
          id: 'voice', name: 'Голос', language: 'ru', available: true, reason: '',
        }],
      }],
    }),
  });

  assert.equal(unknown.wrapper.find('[data-testid="showcase-voice-pace"]').exists(), false);
  assert.match(
    unknown.wrapper.find('[data-testid="showcase-voice-pace-note"]').text(),
    /неизвестна/,
  );
  assert.match(
    unknown.wrapper.find('[data-testid="showcase-voice-capabilities"]').text(),
    /Ударения: неизвестно/,
  );
});

// Образец готовится секундами у тяжёлого движка: пока он идёт, человек читает,
// чего ждёт, а отказ движка приходит его же словами, а не «кнопка не сработала».
test('образец голоса показывает ожидание, а отказ движка называет причину', async (t) => {
  let release = () => {};
  const { wrapper, flushPromises, calls } = await mountView(t, {
    voices: readyVoiceCatalog(),
    preview: () => new Promise((resolve) => {
      release = () => resolve(new Blob());
    }),
  });
  const button = wrapper.find('[data-testid="showcase-voice-preview"]');

  await button.trigger('click');
  await flushPromises();

  assert.deepEqual(calls.filter(([name]) => name === 'preview'), [['preview', 'piper:irina']]);
  assert.match(wrapper.find('.voice__preview-note').text(), /Готовлю образец/);
  assert.equal(button.attributes('aria-busy'), 'true', 'кнопка занята, пока образец не готов');

  release();
  await flushPromises();

  assert.equal(wrapper.find('.voice__preview-note').exists(), false, 'ожидание снимается с готовностью');
  assert.equal(wrapper.find('.voice__error').exists(), false);

  const failed = await mountView(t, {
    voices: readyVoiceCatalog(),
    preview: async () => {
      throw new Error('Не хватило видеопамяти: выгрузите модель Ollama и повторите.');
    },
  });

  await failed.wrapper.find('[data-testid="showcase-voice-preview"]').trigger('click');
  await failed.flushPromises();

  assert.equal(
    failed.wrapper.find('.voice__error').text(),
    'Не хватило видеопамяти: выгрузите модель Ollama и повторите.',
  );
  assert.equal(failed.wrapper.find('.voice__preview-note').exists(), false);

  await failed.wrapper.find('[data-testid="showcase-voice-select"]').setValue('');
  await failed.flushPromises();

  assert.equal(
    failed.wrapper.find('.voice__error').exists(),
    false,
    'ошибка прежнего голоса не остаётся после смены выбора',
  );
});

test('своя реплика слушается с dirty-текстом, а явное произношение сохраняется отдельно', async (t) => {
  const narration = 'Это замок у реки.';
  const { wrapper, flushPromises, calls } = await mountView(t, {
    voices: readyVoiceCatalog(),
    opened: project({
      scenes: [scene({
        narration,
        subtitleText: narration,
        audioSource: { kind: 'tts', voiceRef: 'piper:irina', artifactId: null },
        pronunciationOverrides: [],
      })],
    }),
  });
  const canonical = wrapper.find('[data-role="pronunciation-narration"]');
  const from = narration.indexOf('замок');

  canonical.element.setSelectionRange(from, from + 'замок'.length);
  await canonical.trigger('select');
  await wrapper.find('[data-role="pronunciation-value"]').setValue('зам+ок');
  await wrapper.find('[data-role="add-pronunciation"]').trigger('click');
  await flushPromises();

  assert.match(wrapper.find('.scene__pronunciation-list').text(), /«замок» → «зам\+ок»/);
  assert.equal(
    wrapper.find('.scene textarea:not([readonly])').element.value,
    narration,
    'экранный текст не заменяется фонетической строкой',
  );

  await wrapper.find('[data-role="preview-narration"]').trigger('click');
  await flushPromises();

  const [, previewInput] = calls.find(([name]) => name === 'preview-narration');

  assert.equal(previewInput.voiceRef, 'piper:irina');
  assert.equal(previewInput.narration, narration);
  assert.deepEqual(previewInput.direction, {
    tone: null, pace: null, emphasis: [], pauses: [], stresses: [],
  });
  assert.deepEqual(previewInput.pronunciationOverrides, [{
    from,
    to: from + 'замок'.length,
    pronunciation: 'зам+ок',
    voiceRef: 'piper:irina',
  }]);

  await wrapper.find('.scene__actions button').trigger('click');
  await flushPromises();

  const [, id, patch] = calls.find(([name]) => name === 'update-scene');

  assert.equal(id, 'scene-1');
  assert.equal(patch.narration, narration);
  assert.equal(patch.subtitleText, narration);
  assert.deepEqual(patch.pronunciationOverrides, [{
    from,
    to: from + 'замок'.length,
    pronunciation: 'зам+ок',
    voiceRef: 'piper:irina',
    refresh: true,
  }]);
});

test('правка реплики отменяет незавершённое предпрослушивание', async (t) => {
  let signal;
  const { wrapper, flushPromises } = await mountView(t, {
    voices: readyVoiceCatalog(),
    opened: project({
      scenes: [scene({
        audioSource: { kind: 'tts', voiceRef: 'piper:irina', artifactId: null },
      })],
    }),
    narrationPreview: async (_input, currentSignal) => {
      signal = currentSignal;

      return new Promise((resolve, reject) => {
        currentSignal.addEventListener('abort', () => reject(
          Object.assign(new Error('aborted'), { name: 'AbortError' }),
        ), { once: true });
      });
    },
  });

  await wrapper.find('[data-role="preview-narration"]').trigger('click');
  await flushPromises();
  assert.equal(signal.aborted, false);

  await wrapper.find('.scene textarea:not([readonly])').setValue('Новая реплика.');
  await flushPromises();

  assert.equal(signal.aborted, true);
  assert.equal(wrapper.find('[data-role="preview-narration"]').attributes('aria-busy'), undefined);
});

test('словарь ударений правится в панели голоса и уходит текстом целиком', async (t) => {
  const { wrapper, flushPromises, calls } = await mountView(t, {
    dictionary: {
      text: 'зам+ок\nплохо\n',
      entries: ['зам+ок'],
      errors: [{ line: 2, text: 'плохо', reason: 'нет знака ударения «+»' }],
    },
  });

  assert.ok(calls.some(([name]) => name === 'dictionary'), 'словарь читается при открытии');
  assert.match(wrapper.text(), /з\+амок/, 'подсказка показывает нотацию ударения');
  assert.match(wrapper.text(), /Строка 2: «плохо» — нет знака ударения «\+»/);
  assert.match(wrapper.text(), /Действует: 1 слово/);

  const field = wrapper.find('[data-testid="showcase-voice-dictionary"]');
  const save = wrapper.find('[data-testid="showcase-voice-dictionary-save"]');

  assert.equal(field.element.value, 'зам+ок\nплохо\n');
  assert.equal(save.attributes('disabled') !== undefined, true, 'без правок сохранять нечего');

  await field.setValue('зам+ок\nдин+амика\n');
  await flushPromises();
  assert.equal(save.attributes('disabled'), undefined);

  await save.trigger('click');
  await flushPromises();

  assert.deepEqual(
    calls.filter(([name]) => name === 'save-dictionary'),
    [['save-dictionary', 'зам+ок\nдин+амика\n']],
  );
});

test('субтитр следует за речью без знаков ударения', async (t) => {
  const { wrapper, flushPromises, calls } = await mountView(t, {
    opened: project({
      scenes: [scene({
        narration: 'Это з+амок.',
        subtitleText: 'Это замок.',
        audioSource: { kind: 'tts', voiceRef: null, artifactId: null },
      })],
    }),
  });
  const narration = wrapper.find('.scene textarea');
  const save = wrapper.findAll('.scene button').find((button) => button.text().trim() === 'Сохранить');

  await narration.setValue('Это зам+ок на двери.');
  await flushPromises();
  await save.trigger('click');
  await flushPromises();

  const [, id, patch] = calls.find(([name]) => name === 'update-scene');

  assert.equal(id, 'scene-1');
  assert.equal(patch.narration, 'Это зам+ок на двери.', 'текст уходит как набран, со знаком');
  assert.equal(patch.subtitleText, 'Это замок на двери.', 'субтитр без знака');
});

test('переименование идёт через общий диалог, а не по месту', async (t) => {
  const { wrapper, flushPromises, calls, harness } = await mountView(t, {
    promptValue: 'Массовый съём частотности',
  });

  await wrapper.find('button[aria-label="Переименовать ролик"]').trigger('click');
  await flushPromises();

  assert.equal(harness.prompts[0].value, 'Ролик о готовой работе', 'диалог открывается с текущим именем');
  assert.deepEqual(
    calls.filter(([name]) => name === 'rename'),
    [['rename', 'Массовый съём частотности']],
  );
});

test('удаление ролика с его экрана спрашивает и возвращает к списку', async (t) => {
  const { wrapper, flushPromises, calls, harness } = await mountView(t);

  await buttonByText(wrapper, 'Удалить ролик').trigger('click');
  await flushPromises();

  assert.equal(harness.confirmations.length, 1);
  assert.match(harness.confirmations[0].text, /Удалить ролик «Ролик о готовой работе»/);
  assert.deepEqual(calls.filter(([name]) => name === 'delete'), [['delete', 'project-1']]);
  assert.ok(calls.some(([name, to]) => name === 'route' && to === '/showcase'));
});

// Агент в чате получает контекст страницы: «эта сцена» разрешается без пересказа.
test('агент получает контекст открытого ролика и выбранной сцены', async (t) => {
  const { calls } = await mountView(t, {
    opened: project({
      scenes: [scene({ id: 'scene-1', order: 1 }), scene({ id: 'scene-2', order: 2 })],
    }),
  });
  const focus = calls.filter(([name]) => name === 'context-focus').at(-1);

  assert.deepEqual(focus[1].details, {
    projectId: 'project-1',
    title: 'Ролик о готовой работе',
    sceneId: 'scene-1',
  });

  const list = await mountView(t, { opened: null });

  assert.ok(list.calls.some(([name]) => name === 'context-blur'), 'без ролика контекст снимается');
});

// Опытный ролик пять раз подряд открывал один и тот же диалог: каждая сцена начинала
// с нуля. Продолжение начинает там, где закончилась предыдущая, — и человек обязан
// видеть это в списке, а решать — переключателем, без кнопки «Сохранить».
test('сцена-продолжение помечена в списке, а переключатель уходит отдельной правкой', async (t) => {
  const { wrapper, flushPromises, calls } = await mountView(t, {
    opened: project({
      scenes: [
        // Флаг у первой сцены — оговорка: продолжать ей нечего, и списку он не виден.
        scene({ id: 'scene-1', order: 1, continuesPrevious: true }),
        scene({ id: 'scene-2', order: 2, continuesPrevious: true }),
        scene({ id: 'scene-3', order: 3 }),
      ],
    }),
  });
  const plans = wrapper.findAll('.board__plan');

  assert.doesNotMatch(plans[0].text(), /продолжает предыдущую/);
  assert.match(plans[1].text(), /продолжает предыдущую/);
  assert.doesNotMatch(plans[2].text(), /продолжает предыдущую/);

  const firstSwitch = wrapper.find('[data-role="scene-continues"]');

  assert.equal(firstSwitch.element.disabled, true, 'первой сцене продолжать нечего');
  assert.equal(firstSwitch.element.checked, false);
  assert.match(wrapper.find('.scene__start').text(), /всегда открывает свой экран сама/);

  await selectRow(wrapper, 2);

  const thirdSwitch = wrapper.find('[data-role="scene-continues"]');

  assert.equal(thirdSwitch.element.disabled, false);
  assert.equal(thirdSwitch.element.checked, false);

  thirdSwitch.element.checked = true;
  await thirdSwitch.trigger('change');
  await flushPromises();

  assert.deepEqual(
    calls.filter(([name]) => name === 'update-scene'),
    [['update-scene', 'scene-3', { continuesPrevious: true }]],
  );
  assert.equal(
    buttonByText(wrapper, 'Сохранить').attributes('disabled'),
    '',
    'переключатель не заводит черновик текста',
  );
});

// Продолжение нельзя переснять без головы, поэтому подпись у кнопки считает
// цепочками: одна устаревшая сцена из трёх в цепочке — три сцены на запись.
test('счётчик пересъёмки считает всю цепочку устаревшей сцены', async (t) => {
  const { wrapper } = await mountView(t, {
    opened: project({
      scenes: [
        scene({ id: 'scene-1', order: 1 }),
        scene({ id: 'scene-2', order: 2, continuesPrevious: true, stale: true }),
        scene({ id: 'scene-3', order: 3, continuesPrevious: true }),
        scene({ id: 'scene-4', order: 4 }),
      ],
    }),
  });

  assert.match(wrapper.find('.build__note').text(), /Нужна запись: 3 сцен/);
});
