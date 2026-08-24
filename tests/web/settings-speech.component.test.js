import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { compileSettingsView as compileSettingsViewFixture } from './helpers/settings-view.js';

process.env.NODE_ENV = 'test';

async function compileSettingsView() {
  return compileSettingsViewFixture({ prefix: '__speechSettings' });
}

async function installBrowser(t) {
  globalThis.__COCKPIT_VERSION__ = '0.0.0-test';
  globalThis.__COCKPIT_SHA__ = 'testsha';
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'https://cockpit.test/#/settings' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    SVGElement: browser.SVGElement,
    Document: browser.Document,
    ShadowRoot: browser.ShadowRoot,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  browser.localStorage.setItem('cockpit-settings-tab', 'speech');
  browser.document.body.innerHTML = '<div id="mount"></div>';
  t.after(() => browser.close());
  return browser;
}

function speechResponse(overrides = {}, revision = 'sha256:first-revision') {
  return {
    settings: {
      engine: 'browser',
      browserProcessing: 'auto',
      browserAutoConsent: false,
      language: 'auto',
      dictionary: 'Cockpit',
      quality: 'balanced',
      videoQuality: 'balanced',
      model: null,
      videoModel: null,
      device: 'auto',
      computeType: null,
      beamSize: null,
      vadSilenceMs: 500,
      conditionOnPreviousText: true,
      resident: false,
      keepAliveMin: 5,
      ...overrides,
    },
    revision,
    capabilities: {
      local: {
        ready: true,
        reason: '',
        checks: [{ name: 'ffmpeg', ok: true }],
      },
      models: [
        { modelId: 'small', repo: 'Systran/faster-whisper-small', revision: 'main', cached: true, sizeMb: 244.5 },
        { modelId: 'medium', repo: 'Systran/faster-whisper-medium', revision: 'main', cached: false, sizeMb: null },
      ],
      cuda: { state: 'missing_library', reason: 'libcublas не найден' },
      languages: ['ru', 'en', 'auto'],
      lastDictionaryMeasure: { hotwordsTokens: 7, hotwordsTruncated: false },
      resident: { loaded: false },
      benchmark: { available: true, reason: '' },
    },
  };
}

function stores(chatStore) {
  return {
    useProvidersStore: () => ({
      providers: [], usage: {}, mcp: {}, loaded: true, showAllModels: false,
      visibleModels: () => [], async load() {}, async loadUsage() {},
    }),
    useUiContextStore: () => ({ set() {}, clear() {} }),
    useAuthStore: () => ({ login: 'me', async logoutAll() {} }),
    usePluginsStore: () => ({ loaded: true, list: [], enabled: () => true, async load() {}, async setEnabled() {} }),
    useChatStore: () => chatStore,
    useCompanionStore: () => ({ deviceEnabled: true, setDeviceEnabled() {} }),
    usePwaStore: () => ({ canInstall: false, wakeLock: false, notificationSupported: false, async install() {} }),
    useCockpitUpdateStore: () => ({ state: null, async load() {} }),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function mountSpeechSettings(t, {
  recognition = true,
  response = speechResponse(),
  apiOverrides = {},
} = {}) {
  const browser = await installBrowser(t);
  if (recognition) {
    class Recognition {
      static async available(options) {
        Recognition.availableOptions = options;
        return 'available';
      }
    }
    Object.defineProperty(Recognition.prototype, 'processLocally', { value: false, writable: true });
    browser.SpeechRecognition = Recognition;
  } else {
    browser.SpeechRecognition = undefined;
    browser.webkitSpeechRecognition = undefined;
  }
  const posts = [];
  const gets = [];
  const deletes = [];
  const snapshots = [];
  const jobs = new Map();
  let jobSequence = 0;
  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const chatStore = reactive({
    compactWindow: 0,
    speech: null,
    setSpeechSnapshot(snapshot) {
      snapshots.push(JSON.parse(JSON.stringify(snapshot)));
      const raw = snapshot?.settings || snapshot?.speech || snapshot || {};
      this.speech = {
        ...(this.speech || {}),
        ...raw,
        revision: raw.revision ?? snapshot?.revision ?? this.speech?.revision ?? '',
        capabilities: snapshot?.capabilities || raw.capabilities || this.speech?.capabilities,
      };
    },
  });
  globalThis.__speechSettingsApi = {
    async get(path) {
      gets.push(path);
      if (apiOverrides.get) {
        const overridden = await apiOverrides.get(path);
        if (overridden !== undefined) return overridden;
      }
      if (path === '/api/settings/speech' || path === '/api/settings/speech?refresh=1') {
        return structuredClone(response);
      }
      const match = path.match(/^\/api\/settings\/speech\/jobs\/([^/]+)$/);
      if (match) return structuredClone(jobs.get(decodeURIComponent(match[1])));
      return {};
    },
    async post(path, body) {
      posts.push({ path, body: structuredClone(body) });
      if (apiOverrides.post) {
        const overridden = await apiOverrides.post(path, body);
        if (overridden !== undefined) return overridden;
      }
      if (path === '/api/settings/speech') {
        return speechResponse(body, 'sha256:saved-revision');
      }
      const modelMatch = path.match(/^\/api\/settings\/speech\/models\/([^/]+)\/(download|copy)$/);
      const isBenchmark = path === '/api/settings/speech/benchmark';
      if (modelMatch || isBenchmark) {
        const kind = isBenchmark ? 'benchmark' : modelMatch[2];
        const modelId = isBenchmark ? body.modelId : decodeURIComponent(modelMatch[1]);
        const jobId = `job-${++jobSequence}`;
        jobs.set(jobId, {
          jobId,
          kind,
          modelId,
          status: isBenchmark ? 'done' : 'running',
          createdAt: '2026-08-08T10:00:00.000Z',
          startedAt: '2026-08-08T10:00:01.000Z',
          finishedAt: isBenchmark ? '2026-08-08T10:00:02.000Z' : null,
          progress: isBenchmark ? null : { done: 25, total: 100, file: 'model.bin' },
          result: isBenchmark
            ? { modelId, audioSec: 4, elapsedSec: 1.25, realtimeFactor: 0.31 }
            : null,
          error: null,
        });
        return { jobId, status: 'queued' };
      }
      return {};
    },
    async del(path) {
      deletes.push(path);
      if (apiOverrides.del) {
        const overridden = await apiOverrides.del(path);
        if (overridden !== undefined) return overridden;
      }
      const match = path.match(/^\/api\/settings\/speech\/jobs\/([^/]+)$/);
      if (!match) return {};
      const jobId = decodeURIComponent(match[1]);
      const current = jobs.get(jobId);
      const cancelled = {
        ...current,
        status: 'cancelled',
        finishedAt: '2026-08-08T10:00:03.000Z',
        progress: current?.progress || null,
        result: null,
        error: null,
      };
      jobs.set(jobId, cancelled);
      return structuredClone(cancelled);
    },
  };
  globalThis.__speechSettingsStores = stores(chatStore);
  const [{ mount, flushPromises }, SettingsView] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileSettingsView(),
  ]);
  const wrapper = mount(SettingsView, {
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__speechSettingsApi;
    delete globalThis.__speechSettingsStores;
  });
  for (let index = 0; index < 5; index++) await flushPromises();
  return { wrapper, chatStore, posts, gets, deletes, jobs, snapshots, flushPromises };
}

test('вкладка речи сохраняет выбор и opaque SHA revision', async (t) => {
  const { wrapper, posts, snapshots, flushPromises } = await mountSpeechSettings(t);
  const section = wrapper.get('[data-testid="speech-settings"]');

  assert.match(section.get('[data-testid="speech-cloud-warning"]').text(), /может передать звук/);
  assert.equal(snapshots[0].revision, 'sha256:first-revision');
  assert.deepEqual(snapshots[0].settings.local, { ready: true, reason: '' });
  assert.equal(snapshots[0].capabilities.local.ready, true);

  await section.get('[data-testid="speech-processing-local"]').setValue(true);
  await section.get('select').setValue('en');
  await section.get('[data-testid="speech-dictionary"]').setValue('Codex\nBitrix24');
  await section.get('[data-testid="speech-save"]').trigger('click');
  await flushPromises();

  assert.deepEqual(posts.at(-1), {
    path: '/api/settings/speech',
    body: {
      browserProcessing: 'local', language: 'en', dictionary: 'Codex\nBitrix24',
    },
  });
  assert.equal(snapshots.at(-1).revision, 'sha256:saved-revision');
  assert.match(section.get('[data-testid="speech-effective"]').text(), /браузер/);
});

test('стилевая подсказка видео правится и сбрасывается на серверный дефолт', async (t) => {
  const { wrapper, posts, flushPromises } = await mountSpeechSettings(t);
  const section = wrapper.get('[data-testid="speech-settings"]');

  await section.get('[data-testid="speech-video-prompt"]').setValue('Стенограмма созвона.');
  await section.get('[data-testid="speech-save"]').trigger('click');
  await flushPromises();
  assert.deepEqual(posts.at(-1), {
    path: '/api/settings/speech',
    body: { videoInitialPrompt: 'Стенограмма созвона.' },
  });

  // Сброс шлёт null, а не текст: дефолт живёт на сервере, и копия во фронте разошлась бы
  // с ней при первой правке формулировки.
  await section.get('[data-testid="speech-video-prompt-reset"]').trigger('click');
  await flushPromises();
  assert.deepEqual(posts.at(-1), {
    path: '/api/settings/speech',
    body: { videoInitialPrompt: null },
  });
});

test('save отправляет только diff и не откатывает более новый SSE snapshot', async (t) => {
  const save = deferred();
  const { wrapper, chatStore, posts, snapshots, flushPromises } = await mountSpeechSettings(t, {
    apiOverrides: {
      async post(path) {
        if (path === '/api/settings/speech') return save.promise;
        return undefined;
      },
    },
  });
  const section = wrapper.get('[data-testid="speech-settings"]');
  await section.get('[data-testid="speech-quality-accurate"]').setValue(true);
  await section.get('[data-testid="speech-save"]').trigger('click');
  await flushPromises();

  assert.deepEqual(posts.at(-1), {
    path: '/api/settings/speech',
    body: { quality: 'accurate' },
  });

  const remote = speechResponse({ language: 'en' }, 'sha256:remote-r2');
  chatStore.setSpeechSnapshot(remote);
  await flushPromises();
  assert.equal(section.get('select').element.value, 'en', 'незатронутое поле принимает SSE');
  assert.equal(
    section.get('[data-testid="speech-quality-accurate"]').element.checked,
    true,
    'локальная dirty-правка сохраняется поверх нового baseline',
  );

  save.resolve(speechResponse({ quality: 'accurate', language: 'auto' }, 'sha256:stale-r1'));
  await flushPromises();

  assert.equal(section.get('select').element.value, 'en', 'поздний HTTP не откатывает язык');
  assert.equal(chatStore.speech.revision, 'sha256:remote-r2');
  assert.equal(chatStore.speech.language, 'en');
  assert.equal(snapshots.at(-1).revision, 'sha256:remote-r2');
  assert.match(section.text(), /изменились в другом окне/i);
});

test('save без изменений не отправляет пустой patch', async (t) => {
  const { wrapper, posts, flushPromises } = await mountSpeechSettings(t);
  await wrapper.get('[data-testid="speech-save"]').trigger('click');
  await flushPromises();
  assert.equal(posts.some((item) => item.path === '/api/settings/speech'), false);
  assert.match(wrapper.get('[data-testid="speech-settings"]').text(), /Изменений нет/);
});

test('пресеты, advanced overrides, CUDA gate и шаблон словаря входят в server contract', async (t) => {
  const { wrapper, posts, flushPromises } = await mountSpeechSettings(t);
  const section = wrapper.get('[data-testid="speech-settings"]');
  const quality = section.get('[data-testid="speech-quality"]');

  await quality.get('[data-testid="speech-quality-accurate"]').setValue(true);
  await quality.get('[data-testid="speech-video-quality-fast"]').setValue(true);
  await quality.get('[data-testid="speech-advanced-toggle"]').trigger('click');

  const advanced = quality.get('[data-testid="speech-advanced"]');
  const selects = advanced.findAll('select');
  await selects[0].setValue('large-v3');
  await selects[1].setValue('large-v3-turbo');
  await selects[2].setValue('cpu');
  await selects[3].setValue('float32');
  const numbers = advanced.findAll('input[type="number"]');
  await numbers[0].setValue('7');
  await numbers[1].setValue('900');
  await advanced.get('input[type="checkbox"]').setValue(false);

  const cudaOption = advanced.get('[data-testid="speech-device"] option[value="cuda"]');
  assert.equal(cudaOption.element.disabled, true);
  assert.match(section.get('[data-testid="speech-cuda-command"]').text(), /deploy\/install\.sh --with-cuda/);

  await section.get('[data-testid="speech-dictionary-template"]').trigger('click');
  assert.match(section.get('[data-testid="speech-dictionary"]').element.value, /кокпит/);
  assert.match(section.get('[data-testid="speech-dictionary"]').element.value, /Битрикс24/);
  await section.get('[data-testid="speech-save"]').trigger('click');
  await flushPromises();

  assert.deepEqual(posts.at(-1).body, {
    dictionary: section.get('[data-testid="speech-dictionary"]').element.value,
    quality: 'accurate', videoQuality: 'fast', model: 'large-v3', videoModel: 'large-v3-turbo',
    device: 'cpu', computeType: 'float32', beamSize: 7, vadSilenceMs: 900,
    conditionOnPreviousText: false,
  });
});

test('модели запускают download/copy jobs, poll, cancel и benchmark result', async (t) => {
  const { wrapper, posts, gets, deletes, flushPromises } = await mountSpeechSettings(t);
  const section = wrapper.get('[data-testid="speech-settings"]');

  assert.match(section.get('[data-testid="speech-models"]').text(), /245 МБ/);
  assert.match(section.get('[data-testid="speech-models"]').text(), /не скачана/);

  await section.get('[data-testid="speech-download-medium"]').trigger('click');
  await flushPromises();
  assert.deepEqual(posts.at(-1), {
    path: '/api/settings/speech/models/medium/download',
    body: {},
  });
  assert.ok(gets.some((path) => path === '/api/settings/speech/jobs/job-1'));
  assert.match(section.get('[data-testid="speech-models"]').text(), /Скачивание: выполняется · 25%/);

  await section.get('[data-testid="speech-cancel-medium"]').trigger('click');
  await flushPromises();
  assert.deepEqual(deletes, ['/api/settings/speech/jobs/job-1']);
  assert.match(section.get('[data-testid="speech-models"]').text(), /отменено/);

  await section.get('[data-testid="speech-copy-medium"]').trigger('click');
  await flushPromises();
  assert.deepEqual(posts.at(-1), {
    path: '/api/settings/speech/models/medium/copy',
    body: {},
  });

  await section.get('[data-testid="speech-benchmark"]').trigger('click');
  await flushPromises();
  assert.deepEqual(posts.at(-1), {
    path: '/api/settings/speech/benchmark',
    body: { modelId: 'medium', language: 'auto', device: 'cpu', computeType: 'int8' },
  });
  assert.match(section.get('[data-testid="speech-benchmark-result"]').text(), /4\.0 с речи/);
  assert.match(section.get('[data-testid="speech-benchmark-result"]').text(), /1\.25 с обработки/);
  assert.match(section.get('[data-testid="speech-benchmark-result"]').text(), /RTF 0\.31/);
});

test('benchmark capability не запускает заведомо failed job без эталонного WAV', async (t) => {
  const response = speechResponse();
  response.capabilities.benchmark = { available: false, reason: 'Эталонная запись отсутствует.' };
  const { wrapper, posts } = await mountSpeechSettings(t, { response });
  const section = wrapper.get('[data-testid="speech-settings"]');
  const button = section.get('[data-testid="speech-benchmark"]');

  assert.equal(button.element.disabled, true);
  assert.match(section.get('[data-testid="speech-benchmark-unavailable"]').text(), /Эталонная запись отсутствует/);
  assert.match(section.get('[data-testid="speech-benchmark-unavailable"]').text(), /COCKPIT_SPEECH_BENCHMARK_AUDIO/);
  await button.trigger('click');
  assert.equal(posts.some((item) => item.path === '/api/settings/speech/benchmark'), false);
});

test('частичные capabilities старого сервера безопасны', async (t) => {
  const legacy = speechResponse();
  legacy.capabilities = { local: { ready: true, reason: '' } };
  const legacyMount = await mountSpeechSettings(t, { response: legacy });
  const legacySection = legacyMount.wrapper.get('[data-testid="speech-settings"]');
  await legacySection.get('[data-testid="speech-advanced-toggle"]').trigger('click');
  assert.equal(legacySection.get('[data-testid="speech-device"] option[value="cuda"]').element.disabled, true);
  assert.match(legacySection.get('[data-testid="speech-models"]').text(), /не сообщил каталог/);
});

test('CUDA override включается только при capability ready', async (t) => {
  const ready = speechResponse();
  ready.capabilities.cuda = { state: 'ready', reason: null };
  const readyMount = await mountSpeechSettings(t, { response: ready });
  const readySection = readyMount.wrapper.get('[data-testid="speech-settings"]');
  await readySection.get('[data-testid="speech-advanced-toggle"]').trigger('click');
  assert.equal(readySection.get('[data-testid="speech-device"] option[value="cuda"]').element.disabled, false);
  assert.match(readySection.get('[data-testid="speech-environment"]').text(), /auto → cuda · float16/);
  await readySection.get('[data-testid="speech-benchmark"]').trigger('click');
  await readyMount.flushPromises();
  assert.deepEqual(readyMount.posts.at(-1), {
    path: '/api/settings/speech/benchmark',
    body: { modelId: 'medium', language: 'auto', device: 'cuda', computeType: 'float16' },
  });
});

test('окружение и cache state можно явно перепроверить', async (t) => {
  const { wrapper, gets, flushPromises } = await mountSpeechSettings(t);
  await wrapper.get('[data-testid="speech-refresh"]').trigger('click');
  await flushPromises();
  assert.equal(gets.filter((path) => path === '/api/settings/speech?refresh=1').length, 1);
  assert.match(wrapper.get('[data-testid="speech-settings"]').text(), /окружение и кэши моделей перепроверены/i);
});

test('hello после загрузки делает deduplicated resync снимка речи', async () => {
  const source = await readFile(new URL('../../web/src/stores/chat.js', import.meta.url), 'utf8');
  assert.match(source, /if \(name === 'hello'\)[\s\S]*if \(this\.loaded\)[\s\S]*this\._resyncSpeech\(\)/);
  assert.match(source, /_resyncSpeech\(\)[\s\S]*api\.get\('\/api\/settings\/speech'\)[\s\S]*setSpeechSnapshot/);
  assert.match(source, /speechSyncPromise/);
});

test('фактический путь отличает browser-выбор от Whisper fallback', async (t) => {
  const { wrapper } = await mountSpeechSettings(t, { recognition: false });
  const section = wrapper.get('[data-testid="speech-settings"]');
  assert.match(section.text(), /Выбрано:\s*браузер/);
  assert.match(section.text(), /Whisper \(fallback:/);
  assert.match(section.text(), /SpeechRecognition/);
});
