import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpeechResource } from '../../web/src/features/settings/resources/speech.ts';
import { createSettingsSession } from '../../web/src/features/settings/session.ts';
import { SETTINGS_FIELDS } from '../../web/src/features/settings/catalog.ts';
import { installUiBrowser } from './helpers/ui-components.js';
import { compileModule, webFile } from './helpers/compile-vue.js';
import { assertSettingsFields } from './helpers/settings-consistency.js';

/**
 * Фикстура содержит настройки и read-only возможности раздельно.
 * Opaque revision никогда не переводится в число или порядок версий.
 */
function speechResponse(patch = {}, revision = 'sha256:initial') {
  return {
    settings: {
      engine: 'browser',
      browserProcessing: 'local',
      browserAutoConsent: false,
      language: 'auto',
      dictionary: 'исходный словарь',
      quality: 'balanced',
      videoQuality: 'balanced',
      videoInitialPrompt: 'Серверная подсказка.',
      model: null,
      videoModel: null,
      device: 'auto',
      computeType: null,
      beamSize: null,
      vadSilenceMs: 500,
      conditionOnPreviousText: true,
      ...patch,
    },
    revision,
    capabilities: {
      local: {
        ready: true,
        reason: '',
        checks: [{ name: 'ffmpeg', ok: true }],
      },
      cuda: { state: 'missing_library', reason: 'libcublas отсутствует' },
      models: [{
        modelId: 'medium',
        sizeMb: 700,
        cached: false,
        canCopy: true,
      }],
      benchmark: { available: true, reason: '' },
      languages: ['ru', 'en', 'auto'],
    },
  };
}

test('SP01/SP03/SP09: общий patch речи, null reset и conditionOnPreviousText', async () => {
  const posts = [];
  const session = createSettingsSession();
  const resource = createSpeechResource({
    get: async () => speechResponse(),
    async post(_path, patch) {
      posts.push(patch);

      return speechResponse({ ...patch, videoInitialPrompt: 'Новый серверный дефолт.' }, 'sha256:saved');
    },
  });

  session.begin();
  session.register(resource.adapter, ['engine', 'dictionary', 'videoInitialPrompt', 'conditionOnPreviousText']
    .map((key) => ({ key, address: { pageId: 'speech.advanced', fieldPath: [key] } })));
  await session.load('speech');
  session.setField('speech', 'engine', 'whisper');
  session.setField('speech', 'dictionary', 'термины');
  session.setField('speech', 'videoInitialPrompt', null);
  session.setField('speech', 'conditionOnPreviousText', false);

  assert.equal(posts.length, 0);
  await session.apply();

  assert.deepEqual(posts, [{
    engine: 'whisper',
    dictionary: 'термины',
    videoInitialPrompt: null,
    conditionOnPreviousText: false,
  }]);
  assert.equal(session.getValue('speech', 'videoInitialPrompt'), 'Новый серверный дефолт.');
  assert.equal(session.getSnapshot().dirtyCount, 0);
});

test('SP02: SSE сохраняет dirty; старый GET и POST не откатывают новый opaque snapshot', async () => {
  const oldRead = Promise.withResolvers();
  const oldWrite = Promise.withResolvers();
  const writeStarted = Promise.withResolvers();
  const session = createSettingsSession();
  let reads = 0;
  const resource = createSpeechResource({
    get: async () => ++reads === 1 ? speechResponse() : oldRead.promise,
    post: async () => {
      writeStarted.resolve();

      return oldWrite.promise;
    },
  }, (snapshot) => session.acceptSnapshot('speech', snapshot.values));

  session.begin();
  session.register(resource.adapter, ['dictionary', 'language'].map((key) => ({
    key,
    address: { pageId: 'speech.language', fieldPath: [key] },
  })));
  await session.load('speech');
  session.setField('speech', 'dictionary', 'черновик');

  const reading = resource.refresh();
  const applying = session.apply();

  await writeStarted.promise;
  resource.accept(speechResponse({ language: 'en', dictionary: 'снаружи' }, 'sha256:external'));
  oldRead.resolve(speechResponse({ language: 'ru' }, 'sha256:old'));
  oldWrite.resolve(speechResponse({ dictionary: 'черновик' }, 'sha256:old-save'));
  await reading;

  const result = await applying;

  assert.equal(result.status, 'conflict');
  assert.equal(session.getValue('speech', 'dictionary'), 'черновик');
  assert.equal(session.getValue('speech', 'language'), 'en');
  assert.equal(session.getSnapshot().dirtyCount, 1);
});

test('SP02b (guard): старый GET после save не откатывает подтверждённый baseline', async () => {
  const oldRead = Promise.withResolvers();
  const session = createSettingsSession();
  let firstRead = true;
  const resource = createSpeechResource({
    async get() {
      if (firstRead) {
        firstRead = false;

        return speechResponse();
      }

      return oldRead.promise;
    },
    post: async () => speechResponse({ dictionary: 'сохранено' }, 'sha256:saved-new'),
  }, (snapshot) => session.acceptSnapshot('speech', snapshot.values));

  session.begin();
  session.register(resource.adapter, [{
    key: 'dictionary',
    address: { pageId: 'speech.language', fieldPath: ['dictionary'] },
  }]);
  await session.load('speech');

  const reading = resource.refresh();

  session.setField('speech', 'dictionary', 'сохранено');
  await session.apply();
  oldRead.resolve(speechResponse());
  await reading;

  assert.equal(resource.getSnapshot().revision, 'sha256:saved-new');
  assert.equal(session.getBaseline('speech').dictionary, 'сохранено');
  assert.equal(session.getSnapshot().dirtyCount, 0);
});

test('Новые страницы речи и операции', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ createPinia, setActivePinia }, { mount, flushPromises }, module] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileModule(webFile('../tests/web/helpers/settings-pages.ts'), {
      stubs: {
        '../router.ts': 'export const router = { push: async () => {} };',
        '../../../composables/useSse.ts': 'export const sseSubscribe = () => () => {};',
      },
    }),
  ]);
  const originalFetch = globalThis.fetch;
  const posts = [];
  const gets = [];
  const deletes = [];
  let finished = false;
  let speech = speechResponse();

  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    const method = options.method ?? 'GET';

    if (path.includes('/jobs/')) {
      if (method === 'DELETE') {
        deletes.push(path);
      } else {
        gets.push(path);
      }

      return new Response(JSON.stringify({
        jobId: 'job-fixture',
        kind: 'download',
        modelId: 'medium',
        status: method === 'DELETE' ? 'cancelled' : finished ? 'done' : 'running',
        progress: { percent: 45 },
      }));
    }
    if (method === 'POST') {
      const body = JSON.parse(options.body);

      posts.push({ path, body });

      if (path.endsWith('/speech')) {
        speech = speechResponse({
          ...body,
          videoInitialPrompt: body.videoInitialPrompt === null ? 'Текст сервера.' : body.videoInitialPrompt,
        }, 'sha256:saved-ui');

        return new Response(JSON.stringify(speech));
      }

      return new Response(JSON.stringify({ jobId: 'job-fixture', status: 'queued' }));
    }

    gets.push(path);

    return new Response(JSON.stringify(speech));
  };

  const pinia = createPinia();

  setActivePinia(pinia);

  const settings = module.useSettingsStore();

  settings.setAuthenticated(true);
  settings.requestOpen({ pageId: 'speech.dictation' });

  const wrapper = mount(module.SpeechPage, {
    props: { active: true },
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [pinia] },
  });

  t.after(() => {
    wrapper.unmount();
    settings.dispose();
    globalThis.fetch = originalFetch;
  });
  await flushPromises();

  await t.test('SP04/SP05: недоступный browser-local не включает облако и не даёт согласие', async () => {
    assert.match(wrapper.text(), /Whisper|Недоступно/);
    assert.equal(settings.getValue('speech', 'browserProcessing'), 'local');
    assert.equal(posts.length, 0);
    assert.equal(module.useChatStore().speech.browserAutoConsent, false);
  });

  await t.test('CONS-speech.*: каталог и смонтированные поля совпадают', async () => {
    for (const pageId of ['speech.dictation', 'speech.video', 'speech.language',
      'speech.models', 'speech.advanced']) {
      settings.selectPage(pageId);
      await flushPromises();

      assertSettingsFields(wrapper.element, SETTINGS_FIELDS, pageId);
    }
  });

  await t.test('SP01/SP03/SP09: ввод разных страниц и сброс ждут общего Apply', async () => {
    settings.selectPage('speech.dictation');
    await flushPromises();
    await wrapper.find('select').setValue('whisper');
    settings.selectPage('speech.language');
    await flushPromises();
    await wrapper.find('textarea').setValue('новые термины');
    settings.selectPage('speech.video');
    await flushPromises();
    await wrapper.find('[data-speech-prompt-reset]').trigger('click');
    settings.selectPage('speech.advanced');
    await flushPromises();
    await wrapper.find('[role="switch"]').setValue(false);

    assert.equal(posts.length, 0);
    assert.equal(wrapper.find('option[value="cuda"]').attributes('disabled'), '');
    assert.match(wrapper.text(), /libcublas/);
    await settings.apply();

    assert.deepEqual(posts[0], {
      path: '/api/settings/speech',
      body: {
        engine: 'whisper',
        dictionary: 'новые термины',
        videoInitialPrompt: null,
        conditionOnPreviousText: false,
      },
    });
    assert.equal(settings.getValue('speech', 'videoInitialPrompt'), 'Текст сервера.');
    assert.equal(settings.snapshot.dirtyCount, 0);
  });

  await t.test('SP06/SP07: job стартует один раз, уход снимает опрос, возврат перечитывает', async () => {
    settings.selectPage('speech.models');
    await flushPromises();

    const download = wrapper.find('[data-download="medium"]');

    await download.trigger('click');
    await download.trigger('click');
    await flushPromises();

    assert.equal(posts.filter((entry) => entry.path.endsWith('/download')).length, 1);
    settings.selectPage('speech.language');
    await flushPromises();

    const reads = gets.length;

    await new Promise((resolve) => setTimeout(resolve, 1000));

    assert.equal(gets.length, reads);
    finished = true;
    settings.selectPage('speech.models');
    await flushPromises();

    assert.equal(gets.length > reads, true);
    assert.match(wrapper.text(), /готово/);
    finished = false;
    await wrapper.find('[data-copy="medium"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-cancel="medium"]').trigger('click');
    await flushPromises();

    assert.equal(deletes.length, 1);
  });

  await t.test('SP08: замер использует неприменённые параметры и не пишет настройки', async () => {
    settings.selectPage('speech.advanced');
    await flushPromises();
    settings.setField('speech', 'model', 'small');
    settings.setField('speech', 'language', 'en');
    settings.setField('speech', 'device', 'cpu');
    settings.setField('speech', 'computeType', 'float32');
    await flushPromises();

    assert.match(wrapper.text(), /small.*en.*cpu.*float32/);
    await wrapper.find('[data-benchmark]').trigger('click');
    await flushPromises();

    assert.deepEqual(posts.at(-1), {
      path: '/api/settings/speech/benchmark',
      body: {
        modelId: 'small',
        language: 'en',
        device: 'cpu',
        computeType: 'float32',
      },
    });
    assert.equal(posts.filter((entry) => entry.path.endsWith('/speech')).length, 1);
    assert.equal(settings.snapshot.dirtyCount, 4);
  });
});
