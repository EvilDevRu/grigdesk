import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
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
 * Film монтируется с настоящими controls, выбор проверяется через свойства сцены.
 * Источник задачи изолирован, чтобы проверка редактора не требовала портала.
 */
async function fixture(t, input = project()) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/showcase');

  compiled ??= compileVue(webFile('src/views/showcase/ShowcaseFilm.vue'), {
    stubs: {
      '../../ui': UI_STUB,
      '../../stores/tasks': `export const useTasksStore = () => ({
        load: async () => {}, title: () => null,
      });`,
    }
  });

  const component = await compiled;
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      project: input,
      targets: [],
      seed: null,
      jobs: [],
      buildRun: null,
      manifest: null,
      manifestStatus: 'idle',
      busy: false,
      analyzing: false,
      maxScenes: 20,
      targetUrl: null,
      artifactUrl: (id) => `/artifacts/${id}`,
    },
  });

  t.after(() => wrapper.unmount());
  await flushPromises();

  return { wrapper, flushPromises };
}

test('таймлайн упорядочивает сцены, показывает кадр и переключает свойства', async (t) => {
  const first = scene({
    id: 'first',
    order: 1,
    title: 'Первая',
    frame: artifact('frame', 'frame-1'),
  });
  const second = scene({
    id: 'second',
    order: 2,
    title: 'Вторая',
    narration: 'Реплика второй сцены.',
  });
  const { wrapper, flushPromises } = await fixture(t, project({ scenes: [second, first] }));
  const cards = wrapper.findAll('[data-testid^="showcase-timeline-"]');

  assert.deepEqual(cards.map((card) => card.attributes('data-testid')),
    ['showcase-timeline-first', 'showcase-timeline-second']);
  assert.match(cards[0].find('img').attributes('src'), /frame-1/u);
  assert.equal(cards[1].find('.timeline__frame--empty').exists(), true);
  await cards[1].trigger('click');
  await flushPromises();
  assert.equal(wrapper.find('.scene input[type="text"]').element.value, 'Вторая');
  assert.equal(wrapper.find('.scene textarea:not([readonly])').element.value, 'Реплика второй сцены.');

  const primary = wrapper.findAll('.ui-selectable-row__primary')[1];

  primary.element.focus();
  assert.equal(primary.attributes('aria-pressed'), 'true');
  assert.equal(primary.element.ownerDocument.activeElement === primary.element, true);
  await wrapper.find('[data-testid="showcase-reshoot-second"]').trigger('click');
  assert.deepEqual(wrapper.emitted('reshoot-scene'), [['second']]);
});

for (const ready of [true, false]) {
  test(`сборка без стенда учитывает recordingReady=${ready}`, async (t) => {
    const { wrapper } = await fixture(t, project({
      target: null,
      ref: null,
      recordingReady: ready,
    }));
    const build = wrapper.findAll('button').find((button) => button.text().includes('Собрать ролик'));

    assert.equal(build.attributes('disabled') !== undefined, !ready);
    assert.match(wrapper.text(), ready ? /Клипы свежие/u : /Стенд не выбран/u);
  });
}

test('новый источник без стенда требует повторного разбора', async (t) => {
  const { wrapper } = await fixture(t, project({
    target: null,
    ref: null,
    recordingReady: true,
    source: { taskId: null, note: 'Новая тема' },
    scriptSource: null,
  }));
  const build = wrapper.findAll('button').find((button) => button.text().includes('Собрать ролик'));

  assert.notEqual(build.attributes('disabled'), undefined);
  assert.match(wrapper.text(), /Источник изменён/u);
});
