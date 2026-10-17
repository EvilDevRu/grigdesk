import assert from 'node:assert/strict';

globalThis.__sharedChatContextFill = (await import('../../shared/chat/chatContext.ts')).contextFill;
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  CHAT_SESSION_PATH as VIEW_PATH,
  compileChatSession as compileChatSessionHarness,
} from './helpers/chat-session.js';
import { webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const ACTIONS_PATH = webFile('src/styles/components/actions.css');
const compileChatSession = () => compileChatSessionHarness('__dictation');

async function installBrowser(t) {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'https://cockpit.test/#/chats' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Document: browser.Document,
    ShadowRoot: browser.ShadowRoot,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    KeyboardEvent: browser.KeyboardEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  browser.document.documentElement.lang = 'ru';
  browser.document.body.innerHTML = '<div id="mount"></div>';
  t.after(() => browser.close());
  return browser;
}

function makeSession() {
  return {
    id: 'dictation-chat', taskId: null, title: 'Диктовка', model: '', modelRef: null,
    effort: '', mode: '', messages: [], steps: [], draft: '', sessionId: null,
    contextTokens: 0, sending: false, compacting: false, sessionResetting: false,
  };
}

function makeChatStore(speech) {
  const session = makeSession();
  return {
    sessions: [session], speech: structuredClone(speech), compactWindow: 0, sent: [],
    loadConveyor() {}, markRead() {}, setDraft() {}, setEffort() {}, setMode() {}, setTask() {}, setTitle() {},
    permFor() { return null; }, questionFor() { return null; }, isOnConveyor() { return false; },
    tabLabel() { return session.title; },
    async send(...args) { this.sent.push(structuredClone(args)); return true; },
    async resetContext() { return true; },
    async stop() {},
    setSpeechSnapshot(payload) {
      const snapshot = payload?.settings || payload?.speech || payload || {};
      this.speech = {
        ...this.speech,
        ...snapshot,
        revision: snapshot.revision ?? payload?.revision ?? this.speech.revision,
        local: { ...(this.speech.local || {}), ...(snapshot.local || payload?.capabilities?.local || {}) },
      };
      return this.speech;
    },
  };
}

async function mountChat(t, {
  speech, apiOverrides = {}, configureBrowser, streamFactory = null,
} = {}) {
  const browser = await installBrowser(t);
  configureBrowser?.(browser);
  const [
    { reactive, watch },
    { createDictationController, speechExecutionFingerprint },
  ] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/src/features/speech/controller.js'),
  ]);
  const chatStore = reactive(makeChatStore(speech));
  const posts = [];
  const uploads = [];
  const deletes = [];
  globalThis.__dictationApi = {
    url: (path) => path,
    async get(path) { return path === '/api/tasks' ? { tasks: [] } : {}; },
    async post(path, body) {
      posts.push({ path, body: structuredClone(body) });
      if (apiOverrides.post) return apiOverrides.post(path, body);
      return {};
    },
    async upload(path, body, options) {
      uploads.push({ path, body, options });
      if (apiOverrides.upload) return apiOverrides.upload(path, body, options);
      return { text: '' };
    },
    async del(path) {
      deletes.push(path);
      if (apiOverrides.del) return apiOverrides.del(path);
      return {};
    },
  };
  globalThis.__dictationChatStore = () => chatStore;
  globalThis.__dictationTasksStore = () => ({ async load() {} });
  globalThis.__dictationUiStore = () => ({ openTaskLaunch() {} });
  const controller = createDictationController({
    settings: {
      read: () => chatStore.speech,
      apply: (payload) => chatStore.setSpeechSnapshot(payload),
    },
    apiClient: globalThis.__dictationApi,
    localStream: {
      supported: () => typeof streamFactory === 'function',
      open: streamFactory || (async () => null),
    },
  });
  const stopSettingsWatch = watch(
    () => speechExecutionFingerprint(chatStore.speech),
    () => controller.syncSettings(chatStore.speech),
    { flush: 'sync' },
  );
  globalThis.__dictationUseController = () => controller;
  globalThis.__dictationProvidersStore = () => ({
    providers: [], load() {}, visibleModels: () => [], modesOf: () => [],
    modelOf: () => ({ id: '', model: null, provider: null }),
  });
  const [{ mount, flushPromises }, ChatSession] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileChatSession(),
  ]);
  const wrapper = mount(ChatSession, {
    attachTo: browser.document.querySelector('#mount'),
    props: { sid: 'dictation-chat' },
  });
  t.after(() => {
    wrapper.unmount();
    stopSettingsWatch();
    void controller.dispose();
    delete globalThis.__dictationApi;
    delete globalThis.__dictationChatStore;
    delete globalThis.__dictationTasksStore;
    delete globalThis.__dictationUiStore;
    delete globalThis.__dictationUseController;
    delete globalThis.__dictationProvidersStore;
  });
  await flushPromises();
  return { browser, wrapper, chatStore, posts, uploads, deletes, flushPromises };
}

function speech(overrides = {}) {
  return {
    engine: 'browser', browserProcessing: 'auto', browserAutoConsent: false,
    language: 'ru', dictionary: '', local: { ready: true, reason: '' },
    quality: 'balanced', videoQuality: 'balanced', model: null, videoModel: null,
    device: 'auto', computeType: null, beamSize: null, vadSilenceMs: 500,
    conditionOnPreviousText: true,
    revision: 'sha256:consent-revision', ...overrides,
  };
}

function recognitionResult(text, isFinal) {
  const result = [{ transcript: text }];
  result.isFinal = isFinal;
  return result;
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

test('индикация записи — красная пульсация кнопки Stop без нижнего meter', async () => {
  const [source, actions] = await Promise.all([
    readFile(VIEW_PATH, 'utf8'),
    readFile(ACTIONS_PATH, 'utf8'),
  ]);
  assert.doesNotMatch(source, /data-testid=["']speech-meter["']/);
  assert.match(actions, /data-context='chat-microphone'\]\.rec::before\s*\{/);
  assert.match(actions, /animation:\s*ui-chat-mic-pulse\b/);
  assert.match(actions, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(source, /:label="recording \? 'Остановить диктовку'/);
});

test('consent перед start, prefixed API, interim/final и generation после Stop', async (t) => {
  const instances = [];
  class Recognition {
    constructor() { instances.push(this); }
    start() { this.startCalls = (this.startCalls || 0) + 1; }
    stop() { this.stopCalls = (this.stopCalls || 0) + 1; }
    abort() { this.abortCalls = (this.abortCalls || 0) + 1; }
  }
  const { browser, wrapper, posts, flushPromises } = await mountChat(t, {
    speech: speech(),
    configureBrowser(browser) {
      browser.SpeechRecognition = undefined;
      browser.webkitSpeechRecognition = Recognition;
    },
    apiOverrides: {
      async post(path) {
        if (path === '/api/settings/speech/browser-consent') {
          return {
            settings: { ...speech(), browserAutoConsent: true },
            revision: 'sha256:consented-revision',
            capabilities: { local: { ready: true, reason: '' } },
          };
        }
        return {};
      },
    },
  });

  const mic = wrapper.get('.tool.mic');
  await mic.trigger('click');
  assert.equal(instances.length, 0, 'SpeechRecognition не создаётся до consent');
  assert.equal(wrapper.get('[data-testid="speech-consent"]').exists(), true);

  await wrapper.get('[data-testid="speech-consent-browser"]').trigger('click');
  await flushPromises();
  assert.deepEqual(posts[0], {
    path: '/api/settings/speech/browser-consent',
    body: { confirm: true, revision: 'sha256:consent-revision' },
  });
  assert.equal(instances.length, 1);
  assert.equal(instances[0].startCalls, 1);
  assert.equal(instances[0].lang, 'ru-RU');

  const textarea = wrapper.get('textarea');
  await textarea.setValue('ручной текст');
  instances[0].onresult({ resultIndex: 0, results: [recognitionResult('промежуток', false)] });
  await flushPromises();
  assert.equal(textarea.element.value, 'ручной текст', 'interim не затирает ввод');
  const interim = wrapper.get('[data-testid="speech-interim"]');
  assert.match(interim.text(), /промежуток/);
  assert.equal(interim.element.nextElementSibling === wrapper.get('.composer').element, true,
    'растущая строка «Слышу» остаётся над полем ввода');

  const finalEvent = { resultIndex: 0, results: [recognitionResult('финал', true)] };
  instances[0].onresult(finalEvent);
  instances[0].onresult(finalEvent);
  await flushPromises();
  assert.equal(textarea.element.value, 'ручной текст финал', 'final дописан ровно один раз');

  instances[0].onresult({ resultIndex: 1, results: [finalEvent.results[0], recognitionResult('хвост', false)] });
  const lateResult = instances[0].onresult;
  const lateEnd = instances[0].onend;
  await mic.trigger('click');
  lateResult({ resultIndex: 1, results: [recognitionResult('старый', true), recognitionResult('поздний', true)] });
  lateEnd();
  await flushPromises();
  assert.equal(textarea.element.value, 'ручной текст финал поздний', 'штатный Stop принимает последний final до onend');
  assert.equal(instances[0].stopCalls, 1);

  await mic.trigger('click');
  await flushPromises();
  assert.equal(instances.length, 2);
  const cancelledResult = instances[1].onresult;
  browser.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape' }));
  cancelledResult({ resultIndex: 0, results: [recognitionResult('после отмены', true)] });
  await flushPromises();
  assert.equal(textarea.element.value, 'ручной текст финал поздний', 'Esc инвалидирует даже сохранённый callback');
  assert.equal(instances[1].abortCalls, 1);
});

test('normal Stop блокирует submit до late final/onend', async (t) => {
  const instances = [];
  class Recognition {
    constructor() { instances.push(this); }
    start() {}
    stop() { this.stopCalls = (this.stopCalls || 0) + 1; }
    abort() {}
  }
  const current = speech({ browserAutoConsent: true, revision: 'sha256:drain-r1' });
  const { wrapper, chatStore, flushPromises } = await mountChat(t, {
    speech: current,
    configureBrowser(browser) { browser.SpeechRecognition = Recognition; },
    apiOverrides: {
      async post(path) {
        if (path === '/api/settings/speech/browser-consent') {
          return { settings: { ...current }, revision: current.revision };
        }
        return {};
      },
    },
  });
  const mic = wrapper.get('.tool.mic');
  const textarea = wrapper.get('textarea');

  await textarea.setValue('начало');
  await mic.trigger('click');
  await flushPromises();
  assert.equal(wrapper.findAll('button.send').at(-1).element.disabled, true);
  await textarea.trigger('keydown', { key: 'Enter' });
  await flushPromises();
  assert.equal(chatStore.sent.length, 0, 'активная browser-диктовка не дробит сообщение');
  await mic.trigger('click');
  await flushPromises();
  assert.equal(instances[0].stopCalls, 1);
  assert.equal(wrapper.findAll('button.send').at(-1).element.disabled, true);

  await textarea.trigger('keydown', { key: 'Enter' });
  await flushPromises();
  assert.equal(chatStore.sent.length, 0, 'неполный draft не отправлен во время drain');
  assert.equal(textarea.element.value, 'начало');

  instances[0].onresult({ resultIndex: 0, results: [recognitionResult('финал', true)] });
  instances[0].onend();
  await flushPromises();
  assert.equal(textarea.element.value, 'начало финал');
  assert.equal(wrapper.findAll('button.send').at(-1).element.disabled, false);

  await textarea.trigger('keydown', { key: 'Enter' });
  await flushPromises();
  assert.equal(chatStore.sent.length, 1);
  assert.deepEqual(chatStore.sent[0].slice(0, 3), ['dictation-chat', 'начало финал', []]);
});

test('remote speech snapshot сильнее позднего HTTP ответа browser consent', async (t) => {
  const instances = [];
  const consent = deferred();
  class Recognition {
    constructor() { instances.push(this); }
    start() {}
    stop() {}
    abort() {}
  }
  const { wrapper, chatStore, flushPromises } = await mountChat(t, {
    speech: speech(),
    configureBrowser(browser) { browser.SpeechRecognition = Recognition; },
    apiOverrides: {
      async post(path) {
        if (path === '/api/settings/speech/browser-consent') return consent.promise;
        return {};
      },
    },
  });

  await wrapper.get('.tool.mic').trigger('click');
  await wrapper.get('[data-testid="speech-consent-browser"]').trigger('click');
  await flushPromises();

  chatStore.setSpeechSnapshot({
    settings: { ...speech(), engine: 'whisper', revision: 'sha256:remote-r2' },
    revision: 'sha256:remote-r2',
    capabilities: { local: { ready: true, reason: '' } },
  });
  await flushPromises();
  consent.resolve({
    settings: { ...speech(), browserAutoConsent: true, revision: 'sha256:stale-r1' },
    revision: 'sha256:stale-r1',
    capabilities: { local: { ready: true, reason: '' } },
  });
  await flushPromises();

  assert.equal(instances.length, 0, 'stale consent не запускает browser recognition');
  assert.equal(chatStore.speech.engine, 'whisper');
  assert.equal(chatStore.speech.revision, 'sha256:remote-r2');
  assert.match(wrapper.text(), /Настройки речи изменились в другом окне/);
});

test('SSE собственного consent может прийти раньше HTTP и всё равно запускает запись', async (t) => {
  const instances = [];
  const consent = deferred();
  class Recognition {
    constructor() { instances.push(this); }
    start() { this.started = true; }
    stop() {}
    abort() {}
  }
  const { wrapper, chatStore, flushPromises } = await mountChat(t, {
    speech: speech(),
    configureBrowser(browser) { browser.SpeechRecognition = Recognition; },
    apiOverrides: {
      async post(path) {
        if (path === '/api/settings/speech/browser-consent') return consent.promise;
        return {};
      },
    },
  });
  const confirmed = {
    settings: { ...speech(), browserAutoConsent: true, revision: 'sha256:own-r1' },
    revision: 'sha256:own-r1',
    capabilities: { local: { ready: true, reason: '' } },
  };

  await wrapper.get('.tool.mic').trigger('click');
  await wrapper.get('[data-testid="speech-consent-browser"]').trigger('click');
  await flushPromises();
  chatStore.setSpeechSnapshot(confirmed);
  await flushPromises();
  consent.resolve(confirmed);
  await flushPromises();

  assert.equal(instances.length, 1);
  assert.equal(instances[0].started, true);
});

test('browser:auto с уже данным consent всё равно валидирует current revision перед start', async (t) => {
  const instances = [];
  class Recognition {
    constructor() { instances.push(this); }
    start() { this.started = true; }
    stop() {}
    abort() {}
  }
  const current = speech({ browserAutoConsent: true, revision: 'sha256:validated-r1' });
  const { wrapper, posts, flushPromises } = await mountChat(t, {
    speech: current,
    configureBrowser(browser) { browser.SpeechRecognition = Recognition; },
    apiOverrides: {
      async post(path) {
        if (path === '/api/settings/speech/browser-consent') {
          return { settings: { ...current }, revision: current.revision };
        }
        return {};
      },
    },
  });

  await wrapper.get('.tool.mic').trigger('click');
  await flushPromises();

  assert.deepEqual(posts, [{
    path: '/api/settings/speech/browser-consent',
    body: { confirm: true, revision: 'sha256:validated-r1' },
  }]);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].started, true);
});

test('browser:auto fail-closed при ошибке server validation', async (t) => {
  const instances = [];
  class Recognition {
    constructor() { instances.push(this); }
    start() {}
    stop() {}
    abort() {}
  }
  const { wrapper, flushPromises } = await mountChat(t, {
    speech: speech({ browserAutoConsent: true, revision: 'sha256:offline-r1' }),
    configureBrowser(browser) { browser.SpeechRecognition = Recognition; },
    apiOverrides: {
      async post(path) {
        if (path === '/api/settings/speech/browser-consent') {
          throw Object.assign(new Error('offline'), { status: 503 });
        }
        return {};
      },
    },
  });

  await wrapper.get('.tool.mic').trigger('click');
  await flushPromises();

  assert.equal(instances.length, 0);
  assert.match(wrapper.text(), /Не удалось проверить согласие/);
});

test('browser:auto не стартует после remote revision во время validation', async (t) => {
  const instances = [];
  const validation = deferred();
  class Recognition {
    constructor() { instances.push(this); }
    start() {}
    stop() {}
    abort() {}
  }
  const current = speech({ browserAutoConsent: true, revision: 'sha256:auto-r1' });
  const { wrapper, chatStore, flushPromises } = await mountChat(t, {
    speech: current,
    configureBrowser(browser) { browser.SpeechRecognition = Recognition; },
    apiOverrides: {
      async post(path) {
        if (path === '/api/settings/speech/browser-consent') return validation.promise;
        return {};
      },
    },
  });

  await wrapper.get('.tool.mic').trigger('click');
  await flushPromises();
  chatStore.setSpeechSnapshot({
    settings: { ...current, engine: 'whisper', revision: 'sha256:remote-r2' },
    revision: 'sha256:remote-r2',
  });
  await flushPromises();
  validation.resolve({ settings: { ...current }, revision: current.revision });
  await flushPromises();

  assert.equal(instances.length, 0);
  assert.equal(chatStore.speech.engine, 'whisper');
  assert.equal(chatStore.speech.revision, 'sha256:remote-r2');
});

test('browser:auto retry повторно валидируется и не стартует при reject', async (t) => {
  const instances = [];
  let validations = 0;
  class Recognition {
    constructor() { instances.push(this); }
    start() { this.started = true; }
    stop() {}
    abort() {}
  }
  const current = speech({ browserAutoConsent: true, revision: 'sha256:retry-r1' });
  const { wrapper, flushPromises } = await mountChat(t, {
    speech: current,
    configureBrowser(browser) { browser.SpeechRecognition = Recognition; },
    apiOverrides: {
      async post(path) {
        if (path !== '/api/settings/speech/browser-consent') return {};
        validations++;
        if (validations === 1) return { settings: { ...current }, revision: current.revision };
        throw Object.assign(new Error('stale'), { status: 409 });
      },
    },
  });

  await wrapper.get('.tool.mic').trigger('click');
  await flushPromises();
  assert.equal(instances.length, 1);
  instances[0].onerror({ error: 'network' });
  await new Promise((resolve) => setTimeout(resolve, 360));
  await flushPromises();

  assert.equal(validations, 2);
  assert.equal(instances.length, 1, 'retry reject не создаёт второй recognition');
  assert.match(wrapper.text(), /не запущена/);
});

test('remote settings закрывают prompt установки browser-local без старта recognition', async (t) => {
  const instances = [];
  let installCalls = 0;
  class Recognition {
    static async available() { return 'downloadable'; }
    static async install() { installCalls++; return true; }
    constructor() { instances.push(this); }
    start() {}
    stop() {}
    abort() {}
  }
  Object.defineProperty(Recognition.prototype, 'processLocally', { value: false, writable: true });
  const current = speech({
    browserProcessing: 'local', browserAutoConsent: false, revision: 'sha256:local-r1',
  });
  const { wrapper, chatStore, flushPromises } = await mountChat(t, {
    speech: current,
    configureBrowser(browser) { browser.SpeechRecognition = Recognition; },
  });

  await wrapper.get('.tool.mic').trigger('click');
  await flushPromises();
  assert.equal(wrapper.get('[data-testid="speech-browser-install"]').exists(), true);
  chatStore.setSpeechSnapshot({
    settings: { ...current, engine: 'whisper', revision: 'sha256:remote-whisper-r2' },
    revision: 'sha256:remote-whisper-r2',
  });
  await flushPromises();

  assert.equal(wrapper.find('[data-testid="speech-browser-install"]').exists(), false);
  assert.equal(installCalls, 0);
  assert.equal(instances.length, 0);
});

test('завершение browser-local install не запускает устаревший режим', async (t) => {
  const instances = [];
  const install = deferred();
  class Recognition {
    static async available() { return 'downloadable'; }
    static async install() { return install.promise; }
    constructor() { instances.push(this); }
    start() {}
    stop() {}
    abort() {}
  }
  Object.defineProperty(Recognition.prototype, 'processLocally', { value: false, writable: true });
  const current = speech({
    browserProcessing: 'local', browserAutoConsent: false, revision: 'sha256:install-r1',
  });
  const { wrapper, chatStore, flushPromises } = await mountChat(t, {
    speech: current,
    configureBrowser(browser) { browser.SpeechRecognition = Recognition; },
  });

  await wrapper.get('.tool.mic').trigger('click');
  await flushPromises();
  await wrapper.get('[data-testid="speech-install-browser"]').trigger('click');
  await flushPromises();
  chatStore.setSpeechSnapshot({
    settings: { ...current, engine: 'whisper', revision: 'sha256:install-r2' },
    revision: 'sha256:install-r2',
  });
  await flushPromises();
  install.resolve(true);
  await flushPromises();

  assert.equal(instances.length, 0);
  assert.equal(chatStore.speech.engine, 'whisper');
});

test('browser-local capability gate ставит processLocally, phrases и ограничивает no-speech retry', async (t) => {
  const instances = [];
  class Phrase {
    constructor(text, boost) { this.text = text; this.boost = boost; }
  }
  class Recognition {
    static async available(options) { Recognition.availableOptions = options; return 'available'; }
    constructor() { this.phrases = []; instances.push(this); }
    start() {}
    stop() {}
    abort() {}
  }
  Object.defineProperty(Recognition.prototype, 'processLocally', { value: false, writable: true });
  const { browser, wrapper, flushPromises } = await mountChat(t, {
    speech: speech({
      browserProcessing: 'local', browserAutoConsent: false, language: 'en', dictionary: 'Codex\nBitrix24',
    }),
    configureBrowser(currentBrowser) {
      currentBrowser.SpeechRecognition = Recognition;
      currentBrowser.SpeechRecognitionPhrase = Phrase;
    },
  });

  await wrapper.get('.tool.mic').trigger('click');
  await flushPromises();
  assert.deepEqual(Recognition.availableOptions, { langs: ['en-US'], processLocally: true });
  assert.equal(instances[0].processLocally, true);
  assert.deepEqual(instances[0].phrases.map((item) => [item.text, item.boost]), [['Codex', 5], ['Bitrix24', 5]]);

  instances[0].onerror({ error: 'phrases-not-supported' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(instances.length, 2, 'phrases-not-supported даёт один повтор');
  assert.deepEqual(instances[1].phrases, [], 'повтор идёт без phrases');

  instances[1].onerror({ error: 'no-speech' });
  await new Promise((resolve) => setTimeout(resolve, 280));
  instances[2].onerror({ error: 'no-speech' });
  await new Promise((resolve) => setTimeout(resolve, 530));
  instances[3].onerror({ error: 'no-speech' });
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(instances.length, 4, 'после двух no-speech повторов FSM останавливается');
  assert.match(wrapper.text(), /Речь не услышана/);
  assert.equal(browser.SpeechRecognition, Recognition);
});

test('выбор Whisper из consent prompt не отменяется собственным server snapshot', async (t) => {
  const recorders = [];
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      this.onstop?.();
    }
  }
  const { browser, wrapper, posts, flushPromises } = await mountChat(t, {
    speech: speech(),
    configureBrowser(currentBrowser) {
      currentBrowser.MediaRecorder = Recorder;
      Object.defineProperty(currentBrowser.navigator, 'mediaDevices', {
        configurable: true,
        value: {
          async getUserMedia() {
            return { getTracks: () => [{ stop() {} }] };
          },
        },
      });
    },
    apiOverrides: {
      async post(path) {
        if (path === '/api/settings/speech') {
          return {
            settings: { ...speech(), engine: 'whisper' },
            revision: 'sha256:whisper-choice',
            capabilities: { local: { ready: true, reason: '' } },
          };
        }
        if (path === '/api/chat/transcribe/warmup') return { warmupId: 'warm-whisper-choice' };
        return {};
      },
    },
  });

  await wrapper.get('.tool.mic').trigger('click');
  await wrapper.get('[data-testid="speech-consent-whisper"]').trigger('click');
  await flushPromises();
  assert.deepEqual(posts[0], { path: '/api/settings/speech', body: { engine: 'whisper' } });
  assert.equal(recorders.length, 1);
  assert.equal(recorders[0].state, 'recording');

  browser.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape' }));
  await flushPromises();
});

test('remote speech snapshot сильнее позднего HTTP ответа выбора Whisper', async (t) => {
  const recorders = [];
  const choice = deferred();
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
  }
  const { wrapper, chatStore, flushPromises } = await mountChat(t, {
    speech: speech(),
    configureBrowser(browser) {
      browser.MediaRecorder = Recorder;
      Object.defineProperty(browser.navigator, 'mediaDevices', {
        configurable: true,
        value: { async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; } },
      });
    },
    apiOverrides: {
      async post(path) {
        if (path === '/api/settings/speech') return choice.promise;
        return {};
      },
    },
  });

  await wrapper.get('.tool.mic').trigger('click');
  await wrapper.get('[data-testid="speech-consent-whisper"]').trigger('click');
  await flushPromises();
  chatStore.setSpeechSnapshot({
    settings: {
      ...speech(), browserProcessing: 'local', browserAutoConsent: false,
      revision: 'sha256:remote-local-r2',
    },
    revision: 'sha256:remote-local-r2',
    capabilities: { local: { ready: true, reason: '' } },
  });
  await flushPromises();
  choice.resolve({
    settings: { ...speech(), engine: 'whisper', revision: 'sha256:stale-whisper-r1' },
    revision: 'sha256:stale-whisper-r1',
    capabilities: { local: { ready: true, reason: '' } },
  });
  await flushPromises();

  assert.equal(recorders.length, 0, 'stale Whisper response не открывает микрофон');
  assert.equal(chatStore.speech.engine, 'browser');
  assert.equal(chatStore.speech.browserProcessing, 'local');
  assert.equal(chatStore.speech.revision, 'sha256:remote-local-r2');
  assert.match(wrapper.text(), /Настройки речи изменились в другом окне/);
});

test('MediaRecorder: кнопка пульсирует как Stop, upload один, Esc/unmount выбрасывают blob', async (t) => {
  const tracks = [];
  const recorders = [];
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(stream, options) {
      this.stream = stream;
      this.mimeType = options?.mimeType || '';
      this.state = 'inactive';
      recorders.push(this);
    }
    start() { this.state = 'recording'; }
    stop() {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  let warmupSequence = 0;
  const { browser, wrapper, uploads, deletes, flushPromises } = await mountChat(t, {
    speech: speech({ engine: 'whisper' }),
    configureBrowser(currentBrowser) {
      currentBrowser.MediaRecorder = Recorder;
      Object.defineProperty(currentBrowser.navigator, 'mediaDevices', {
        configurable: true,
        value: {
          async getUserMedia() {
            const track = { stopped: false, stop() { this.stopped = true; } };
            tracks.push(track);
            return { getTracks: () => [track] };
          },
        },
      });
    },
    apiOverrides: {
      async post(path) {
        if (path === '/api/chat/transcribe/warmup') return { warmupId: `warm-${++warmupSequence}` };
        return {};
      },
      async upload() { return { text: 'надиктовано' }; },
    },
  });
  const mic = wrapper.get('.tool.mic');

  await mic.trigger('click');
  await flushPromises();
  assert.equal(mic.classes().includes('rec'), true);
  assert.equal(mic.attributes('aria-pressed'), 'true');
  assert.equal(wrapper.find('[data-testid="speech-meter"]').exists(), false);
  await mic.trigger('click');
  await flushPromises();
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].body.get('warmupId'), 'warm-1');
  assert.equal(tracks[0].stopped, true);
  assert.equal(wrapper.get('textarea').element.value, 'надиктовано');

  await mic.trigger('click');
  await flushPromises();
  browser.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape' }));
  await flushPromises();
  assert.equal(uploads.length, 1, 'Esc не запускает transcribe');
  assert.ok(deletes.includes('/api/chat/transcribe/warmup/warm-2'));
  assert.equal(tracks[1].stopped, true);

  await mic.trigger('click');
  await flushPromises();
  wrapper.unmount();
  await flushPromises();
  assert.equal(uploads.length, 1, 'unmount не запускает transcribe');
  assert.ok(deletes.includes('/api/chat/transcribe/warmup/warm-3'));
  assert.equal(tracks[2].stopped, true);
  assert.equal(recorders.length, 3);
});

test('Whisper live: partial только preview, Stop добавляет final к текущему textarea без upload', async (t) => {
  const finish = deferred();
  const streamCalls = [];
  const tracks = [];
  let stopCalls = 0;
  let cancelCalls = 0;
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['full recording'], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  const { wrapper, posts, uploads, flushPromises } = await mountChat(t, {
    speech: speech({ engine: 'whisper', revision: 'speech:live-r1' }),
    configureBrowser(browser) {
      browser.MediaRecorder = Recorder;
      browser.WebSocket = class {};
      browser.AudioContext = class {};
      browser.AudioWorkletNode = class {};
      Object.defineProperty(browser.navigator, 'mediaDevices', {
        configurable: true,
        value: {
          async getUserMedia() {
            const track = { stopped: false, stop() { this.stopped = true; } };
            tracks.push(track);
            return { getTracks: () => [track] };
          },
        },
      });
    },
    streamFactory: async (options) => {
      streamCalls.push(options);
      return {
        async stop() { stopCalls += 1; return finish.promise; },
        async cancel() { cancelCalls += 1; },
      };
    },
  });
  const textarea = wrapper.get('textarea');
  const mic = wrapper.get('.tool.mic');
  await textarea.setValue('ручной prefix');
  await mic.trigger('click');
  await flushPromises();

  assert.equal(streamCalls.length, 1);
  assert.equal(streamCalls[0].revision, 'speech:live-r1');
  assert.equal(posts.filter(({ path }) => path === '/api/chat/transcribe/warmup').length, 0,
    'healthy live не грузит вторую копию модели через warmup');
  streamCalls[0].onEvent({ type: 'partial', text: 'предварительный текст', lagMs: 500 });
  await flushPromises();
  assert.match(wrapper.get('[data-testid="speech-interim"]').text(), /предварительный текст/);
  assert.equal(textarea.element.value, 'ручной prefix');

  await mic.trigger('click');
  await flushPromises();
  assert.equal(stopCalls, 1);
  assert.equal(wrapper.find('[data-testid="speech-interim"]').exists(), false,
    'после Stop provisional сразу исчезает, пока final ещё дренируется');
  assert.equal(wrapper.findAll('button.send').at(-1).element.disabled, true);
  streamCalls[0].onEvent({ type: 'partial', text: 'поздний provisional' });
  await textarea.setValue('ручной prefix с правкой');
  streamCalls[0].onEvent({ type: 'final', text: 'стабильный финал' });
  streamCalls[0].onEvent({ type: 'done', text: 'стабильный финал' });
  finish.resolve({ type: 'done', text: 'стабильный финал' });
  await flushPromises();

  assert.equal(textarea.element.value, 'ручной prefix с правкой стабильный финал');
  assert.equal(wrapper.find('[data-testid="speech-interim"]').exists(), false);
  assert.equal(uploads.length, 0);
  assert.equal(cancelCalls, 0);
  assert.equal(tracks[0].stopped, true);
  assert.equal(wrapper.findAll('button.send').at(-1).element.disabled, false);
});

test('Whisper live останавливается по клику до запоздалого MediaRecorder.onstop', async (t) => {
  let recorder = null;
  let stopCalls = 0;
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() {
      this.state = 'inactive';
      this.mimeType = 'audio/webm';
      recorder = this;
    }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
  }
  const { wrapper, uploads, flushPromises } = await mountChat(t, {
    speech: speech({ engine: 'whisper' }),
    configureBrowser(browser) {
      browser.MediaRecorder = Recorder;
      browser.WebSocket = class {};
      browser.AudioContext = class {};
      browser.AudioWorkletNode = class {};
      Object.defineProperty(browser.navigator, 'mediaDevices', {
        configurable: true,
        value: { async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; } },
      });
    },
    streamFactory: async () => ({
      async stop() {
        stopCalls += 1;
        return { type: 'done', text: 'ровно до клика' };
      },
      async cancel() {},
    }),
  });

  await wrapper.get('.tool.mic').trigger('click');
  await flushPromises();
  await wrapper.get('.tool.mic').trigger('click');
  await flushPromises();
  assert.equal(stopCalls, 1, 'live Stop не ждёт recorder onstop/watchdog');
  assert.equal(uploads.length, 0);
  assert.equal(wrapper.get('textarea').element.value, '');

  recorder.ondataavailable?.({ data: new Blob(['same boundary'], { type: recorder.mimeType }) });
  recorder.onstop?.();
  await flushPromises();
  await flushPromises();
  assert.equal(stopCalls, 1, 'поздний onstop переиспользует тот же liveStopPromise');
  assert.equal(uploads.length, 0);
  assert.equal(wrapper.get('textarea').element.value, 'ровно до клика');
});

test('MediaRecorder watchdog завершает live drain, если браузер не прислал onstop', async (t) => {
  const tracks = [];
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    requestData() {
      this.ondataavailable?.({ data: new Blob(['watchdog recording'], { type: this.mimeType }) });
    }
    stop() { this.state = 'inactive'; }
  }
  const { wrapper, uploads, flushPromises } = await mountChat(t, {
    speech: speech({ engine: 'whisper' }),
    configureBrowser(browser) {
      browser.MediaRecorder = Recorder;
      browser.WebSocket = class {};
      browser.AudioContext = class {};
      browser.AudioWorkletNode = class {};
      Object.defineProperty(browser.navigator, 'mediaDevices', {
        configurable: true,
        value: {
          async getUserMedia() {
            const track = { stopped: false, stop() { this.stopped = true; } };
            tracks.push(track);
            return { getTracks: () => [track] };
          },
        },
      });
    },
    streamFactory: async () => ({
      async stop() { return { type: 'done', text: 'watchdog финал' }; },
      async cancel() {},
    }),
  });

  await wrapper.get('.tool.mic').trigger('click');
  await flushPromises();
  await wrapper.get('.tool.mic').trigger('click');
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  await flushPromises();

  assert.equal(tracks[0].stopped, true);
  assert.equal(uploads.length, 0);
  assert.equal(wrapper.get('textarea').element.value, 'watchdog финал');
  assert.equal(wrapper.findAll('button.send').at(-1).element.disabled, false);
});

test('Whisper live cold start: Stop ждёт stream и добавляет итог без batch fallback', async (t) => {
  const opening = deferred();
  const tracks = [];
  let streamOptions;
  let stopCalls = 0;
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['cold recording'], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  const { wrapper, posts, uploads, flushPromises } = await mountChat(t, {
    speech: speech({ engine: 'whisper', revision: 'speech:cold-r1' }),
    configureBrowser(browser) {
      browser.MediaRecorder = Recorder;
      browser.WebSocket = class {};
      browser.AudioContext = class {};
      browser.AudioWorkletNode = class {};
      Object.defineProperty(browser.navigator, 'mediaDevices', {
        configurable: true,
        value: {
          async getUserMedia() {
            const track = { stopped: false, stop() { this.stopped = true; } };
            tracks.push(track);
            return { getTracks: () => [track] };
          },
        },
      });
    },
    streamFactory(options) {
      streamOptions = options;
      return opening.promise;
    },
  });
  const textarea = wrapper.get('textarea');
  const mic = wrapper.get('.tool.mic');
  await textarea.setValue('ручной prefix');
  await mic.trigger('click');
  await flushPromises();
  await mic.trigger('click');
  await flushPromises();

  assert.equal(streamOptions.revision, 'speech:cold-r1');
  assert.equal(wrapper.findAll('button.send').at(-1).element.disabled, true,
    'до ready/done отправка остаётся заблокирована');
  assert.equal(uploads.length, 0);
  assert.equal(tracks[0].stopped, true);
  await textarea.setValue('ручной prefix с правкой');

  opening.resolve({
    async stop() {
      stopCalls += 1;
      return { type: 'done', text: 'cold финал' };
    },
    async cancel() {},
  });
  await flushPromises();
  await flushPromises();

  assert.equal(stopCalls, 1);
  assert.equal(textarea.element.value, 'ручной prefix с правкой cold финал');
  assert.equal(uploads.length, 0);
  assert.equal(posts.filter(({ path }) => path === '/api/chat/transcribe/warmup').length, 0);
  assert.equal(wrapper.findAll('button.send').at(-1).element.disabled, false);
});

test('Whisper live cold start: Esc снимает drain и поздний stream не меняет textarea', async (t) => {
  const opening = deferred();
  let streamOptions;
  let stopCalls = 0;
  let cancelCalls = 0;
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['cold recording'], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  const { browser, wrapper, uploads, flushPromises } = await mountChat(t, {
    speech: speech({ engine: 'whisper' }),
    configureBrowser(browser) {
      browser.MediaRecorder = Recorder;
      browser.WebSocket = class {};
      browser.AudioContext = class {};
      browser.AudioWorkletNode = class {};
      Object.defineProperty(browser.navigator, 'mediaDevices', {
        configurable: true,
        value: { async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; } },
      });
    },
    streamFactory(options) {
      streamOptions = options;
      return opening.promise;
    },
  });
  const textarea = wrapper.get('textarea');
  const mic = wrapper.get('.tool.mic');
  await textarea.setValue('ручной текст');
  await mic.trigger('click');
  await flushPromises();
  await mic.trigger('click');
  await flushPromises();
  assert.equal(wrapper.findAll('button.send').at(-1).element.disabled, true);

  browser.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape' }));
  await flushPromises();
  assert.equal(streamOptions.signal.aborted, true);
  assert.equal(wrapper.findAll('button.send').at(-1).element.disabled, false,
    'Esc немедленно снимает UI-lock даже до завершения cold start');

  streamOptions.onEvent({ type: 'final', text: 'поздний event' });
  opening.resolve({
    async stop() { stopCalls += 1; return { type: 'done', text: 'поздний stop' }; },
    async cancel() { cancelCalls += 1; },
  });
  await flushPromises();
  await flushPromises();

  assert.equal(stopCalls, 0);
  assert.equal(cancelCalls, 1, 'поздно открывшийся stream всё равно освобождается');
  assert.equal(uploads.length, 0);
  assert.equal(textarea.element.value, 'ручной текст');
});

test('смена speech-настроек во время Whisper live drain отменяет поздний final', async (t) => {
  const finish = deferred();
  let streamOptions;
  let stopCalls = 0;
  let cancelCalls = 0;
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['full recording'], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  const { wrapper, chatStore, uploads, flushPromises } = await mountChat(t, {
    speech: speech({ engine: 'whisper', revision: 'speech:settings-r1' }),
    configureBrowser(browser) {
      browser.MediaRecorder = Recorder;
      browser.WebSocket = class {};
      browser.AudioContext = class {};
      browser.AudioWorkletNode = class {};
      Object.defineProperty(browser.navigator, 'mediaDevices', {
        configurable: true,
        value: { async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; } },
      });
    },
    streamFactory: async (options) => {
      streamOptions = options;
      return {
        async stop() { stopCalls += 1; return finish.promise; },
        async cancel() { cancelCalls += 1; },
      };
    },
  });
  const textarea = wrapper.get('textarea');
  const mic = wrapper.get('.tool.mic');
  await textarea.setValue('не менять');
  await mic.trigger('click');
  await flushPromises();
  await mic.trigger('click');
  await flushPromises();
  assert.equal(stopCalls, 1);
  assert.equal(wrapper.findAll('button.send').at(-1).element.disabled, true);

  chatStore.setSpeechSnapshot({ ...chatStore.speech, revision: 'speech:settings-r2' });
  await flushPromises();
  assert.equal(streamOptions.signal.aborted, true);
  assert.equal(cancelCalls, 1);
  assert.equal(wrapper.findAll('button.send').at(-1).element.disabled, false);
  assert.match(wrapper.get('[data-testid="speech-notice"]').text(), /настройки речи изменились/);

  streamOptions.onEvent({ type: 'final', text: 'поздний event' });
  streamOptions.onEvent({ type: 'done', text: 'поздний event' });
  finish.resolve({ type: 'done', text: 'поздний stop' });
  await flushPromises();
  await flushPromises();

  assert.equal(textarea.element.value, 'не менять');
  assert.equal(uploads.length, 0, 'отменённый live drain не запускает batch fallback');
});

test('unmount во время Whisper live drain отменяет stream и игнорирует поздний итог', async (t) => {
  const finish = deferred();
  let streamOptions;
  let cancelCalls = 0;
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['full recording'], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  const { wrapper, uploads, flushPromises } = await mountChat(t, {
    speech: speech({ engine: 'whisper' }),
    configureBrowser(browser) {
      browser.MediaRecorder = Recorder;
      browser.WebSocket = class {};
      browser.AudioContext = class {};
      browser.AudioWorkletNode = class {};
      Object.defineProperty(browser.navigator, 'mediaDevices', {
        configurable: true,
        value: { async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; } },
      });
    },
    streamFactory: async (options) => {
      streamOptions = options;
      return {
        async stop() { return finish.promise; },
        async cancel() { cancelCalls += 1; },
      };
    },
  });
  const textarea = wrapper.get('textarea');
  await textarea.setValue('до unmount');
  await wrapper.get('.tool.mic').trigger('click');
  await flushPromises();
  await wrapper.get('.tool.mic').trigger('click');
  await flushPromises();

  wrapper.unmount();
  await flushPromises();
  assert.equal(streamOptions.signal.aborted, true);
  assert.equal(cancelCalls, 1);

  streamOptions.onEvent({ type: 'done', text: 'поздний event' });
  finish.resolve({ type: 'done', text: 'поздний stop' });
  await flushPromises();
  await flushPromises();
  assert.equal(uploads.length, 0);
  assert.equal(textarea.element.value, 'до unmount');
});

test('пустой Whisper live final перепроверяется одним полным batch recording', async (t) => {
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['very short recording'], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  const { wrapper, posts, uploads, flushPromises } = await mountChat(t, {
    speech: speech({ engine: 'whisper' }),
    configureBrowser(browser) {
      browser.MediaRecorder = Recorder;
      browser.WebSocket = class {};
      browser.AudioContext = class {};
      browser.AudioWorkletNode = class {};
      Object.defineProperty(browser.navigator, 'mediaDevices', {
        configurable: true,
        value: { async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; } },
      });
    },
    streamFactory: async () => ({
      async stop() { return { type: 'done', text: '' }; },
      async cancel() {},
    }),
    apiOverrides: {
      async upload() { return { text: 'batch после пустого live' }; },
    },
  });

  await wrapper.get('.tool.mic').trigger('click');
  await flushPromises();
  await wrapper.get('.tool.mic').trigger('click');
  await flushPromises();
  await flushPromises();

  assert.equal(posts.filter(({ path }) => path === '/api/chat/transcribe/warmup').length, 0);
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].body.get('file').size > 0);
  assert.equal(wrapper.get('textarea').element.value, 'batch после пустого live');
});

test('Whisper live failure использует один полный MediaRecorder blob как batch fallback', async (t) => {
  const tracks = [];
  let liveSessionId = '';
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['audio from start to stop'], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  const streamError = Object.assign(new Error('drain timeout'), {
    code: 'speech_stream_drain_timeout',
  });
  const { wrapper, posts, uploads, flushPromises } = await mountChat(t, {
    speech: speech({ engine: 'whisper' }),
    configureBrowser(browser) {
      browser.MediaRecorder = Recorder;
      browser.WebSocket = class {};
      browser.AudioContext = class {};
      browser.AudioWorkletNode = class {};
      Object.defineProperty(browser.navigator, 'mediaDevices', {
        configurable: true,
        value: {
          async getUserMedia() {
            const track = { stopped: false, stop() { this.stopped = true; } };
            tracks.push(track);
            return { getTracks: () => [track] };
          },
        },
      });
    },
    streamFactory: async ({ onEvent, sessionId }) => {
      liveSessionId = sessionId;
      return ({
        async stop() {
          onEvent({ type: 'partial', text: 'не должен попасть в поле' });
          throw streamError;
        },
        async cancel() {},
      });
    },
    apiOverrides: {
      async upload() { return { text: 'batch финал' }; },
    },
  });
  const textarea = wrapper.get('textarea');
  const mic = wrapper.get('.tool.mic');
  await mic.trigger('click');
  await flushPromises();
  await mic.trigger('click');
  await flushPromises();
  await flushPromises();

  assert.equal(posts.filter(({ path }) => path === '/api/chat/transcribe/warmup').length, 0);
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].body.get('file').size > 0, 'fallback содержит полный recording');
  assert.equal(uploads[0].body.has('warmupId'), false);
  assert.equal(uploads[0].body.get('streamSessionId'), liveSessionId,
    'batch коррелируется с live worker для server death barrier');
  assert.equal(textarea.element.value, 'batch финал');
  assert.equal(tracks[0].stopped, true);
});

test('Whisper upload блокирует отправку prefix до готового transcript', async (t) => {
  const upload = deferred();
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  const { wrapper, chatStore, flushPromises } = await mountChat(t, {
    speech: speech({ engine: 'whisper' }),
    configureBrowser(browser) {
      browser.MediaRecorder = Recorder;
      Object.defineProperty(browser.navigator, 'mediaDevices', {
        configurable: true,
        value: { async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; } },
      });
    },
    apiOverrides: {
      async post(path) {
        if (path === '/api/chat/transcribe/warmup') return { warmupId: 'warm-pending' };
        return {};
      },
      async upload() { return upload.promise; },
    },
  });
  const textarea = wrapper.get('textarea');
  const mic = wrapper.get('.tool.mic');

  await textarea.setValue('ручной prefix');
  await mic.trigger('click');
  await flushPromises();
  await mic.trigger('click');
  await flushPromises();
  assert.equal(wrapper.findAll('button.send').at(-1).element.disabled, true);
  await textarea.trigger('keydown', { key: 'Enter' });
  await flushPromises();
  assert.equal(chatStore.sent.length, 0);
  assert.equal(textarea.element.value, 'ручной prefix');

  upload.resolve({ text: 'надиктованный хвост' });
  await flushPromises();
  assert.equal(textarea.element.value, 'ручной prefix надиктованный хвост');
  assert.equal(wrapper.findAll('button.send').at(-1).element.disabled, false);

  await textarea.trigger('keydown', { key: 'Enter' });
  await flushPromises();
  assert.deepEqual(chatStore.sent[0].slice(0, 3), [
    'dictation-chat', 'ручной prefix надиктованный хвост', [],
  ]);
});

test('смена execution-настроек во время MediaRecorder отменяет warmup и не загружает blob', async (t) => {
  const tracks = [];
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  const { wrapper, chatStore, uploads, deletes, flushPromises } = await mountChat(t, {
    speech: speech({ engine: 'whisper' }),
    configureBrowser(browser) {
      browser.MediaRecorder = Recorder;
      Object.defineProperty(browser.navigator, 'mediaDevices', {
        configurable: true,
        value: {
          async getUserMedia() {
            const track = { stopped: false, stop() { this.stopped = true; } };
            tracks.push(track);
            return { getTracks: () => [track] };
          },
        },
      });
    },
    apiOverrides: {
      async post(path) {
        if (path === '/api/chat/transcribe/warmup') return { warmupId: 'warm-settings-change' };
        return {};
      },
    },
  });

  await wrapper.get('.tool.mic').trigger('click');
  await flushPromises();
  chatStore.setSpeechSnapshot({ ...chatStore.speech, model: 'large-v3', device: 'cpu' });
  await flushPromises();

  assert.equal(uploads.length, 0);
  assert.deepEqual(deletes, ['/api/chat/transcribe/warmup/warm-settings-change']);
  assert.equal(tracks[0].stopped, true);
  assert.match(wrapper.get('[data-testid="speech-notice"]').text(), /настройки речи изменились/);
});
