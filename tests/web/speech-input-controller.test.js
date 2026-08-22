// Проверяет единый контроллер диктовки и отсутствие дублирующего автомата речи в UI.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { createDictationController } from '../../web/src/features/speech/controller.js';

function speech(overrides = {}) {
  return {
    engine: 'browser',
    browserProcessing: 'local',
    browserAutoConsent: false,
    language: 'ru',
    dictionary: '',
    local: { ready: true, reason: '' },
    revision: 'speech:test-r1',
    ...overrides,
  };
}

function recognitionResult(text, isFinal) {
  const result = [{ transcript: text }];
  result.isFinal = isFinal;
  return result;
}

test('COMP-STT-01/12: root provider — единственная точка factory, UI не содержит второго speech FSM', async () => {
  const [controller, provider, app, chatSession] = await Promise.all([
    readFile(new URL('../../web/src/features/speech/controller.js', import.meta.url), 'utf8'),
    readFile(new URL('../../web/src/features/speech/provider.js', import.meta.url), 'utf8'),
    readFile(new URL('../../web/src/App.vue', import.meta.url), 'utf8'),
    readFile(new URL('../../web/src/views/chat/ChatSession.vue', import.meta.url), 'utf8'),
  ]);

  assert.match(provider, /controllerFactory\(\{/);
  assert.match(app, /<SpeechProvider\s+v-else>/);
  assert.match(chatSession, /useDictationController\(\)/);
  assert.doesNotMatch(chatSession, /createDictationController|createSpeechStream|getUserMedia|SpeechRecognition|MediaRecorder|speechGeneration/);
  assert.doesNotMatch(controller, /from\s+['"][^'"]*(?:stores\/chat|features\/companion)/);
  for (const callback of ['onState', 'onInterim', 'onCommit', 'onFinal', 'onError']) {
    assert.match(controller, new RegExp(`handlers\\.${callback}`));
  }
});

function browserHarness(settings, { apiClient = null } = {}) {
  const instances = [];
  class Recognition {
    static async available() { return 'available'; }
    constructor() { instances.push(this); }
    start() { this.startCalls = (this.startCalls || 0) + 1; }
    stop() { this.stopCalls = (this.stopCalls || 0) + 1; }
    abort() { this.abortCalls = (this.abortCalls || 0) + 1; }
  }
  Object.defineProperty(Recognition.prototype, 'processLocally', {
    value: false,
    writable: true,
  });
  const controller = createDictationController({
    settings: {
      read: () => settings.value,
      apply(payload) {
        const raw = payload?.settings || payload?.speech || payload || {};
        settings.value = { ...settings.value, ...raw, revision: raw.revision || payload?.revision };
        return settings.value;
      },
    },
    apiClient: apiClient || {
      async get() { return {}; },
      async post() { return {}; },
      async upload() { return {}; },
      async del() { return {}; },
    },
    browser: {
      isSecureContext: () => true,
      recognitionCtor: () => Recognition,
      phraseCtor: () => null,
      uiLanguage: () => 'ru-RU',
    },
  });
  return { controller, instances, Recognition };
}

test('COMP-STT-02: acquire не занимает микрофон, второй start получает speech_busy до browser API', async () => {
  const settings = { value: speech() };
  const { controller, instances } = browserHarness(settings);
  const first = controller.acquire(Symbol('first'));
  const second = controller.acquire(Symbol('second'));

  assert.equal(instances.length, 0);
  await first.start();
  assert.equal(instances.length, 1);
  await assert.rejects(second.start(), { code: 'speech_busy' });
  assert.equal(instances.length, 1, 'busy consumer не создаёт второй recognition');

  await first.cancel();
  first.release();
  second.release();
  controller.dispose();
});

test('COMP-STT-03/04/07: interim не коммитится, stable chunks и terminal final приходят ровно один раз', async () => {
  const settings = { value: speech() };
  const { controller, instances } = browserHarness(settings);
  const commits = [];
  const finals = [];
  const lease = controller.acquire(Symbol('chat'), {
    onCommit: (text) => commits.push(text),
    onFinal: (text) => finals.push(text),
  });

  await lease.start();
  const recognition = instances[0];
  recognition.onresult({ resultIndex: 0, results: [recognitionResult('только preview', false)] });
  assert.deepEqual(commits, []);
  const first = recognitionResult('первая часть', true);
  recognition.onresult({ resultIndex: 0, results: [first] });
  recognition.onresult({ resultIndex: 0, results: [first] });
  recognition.onresult({ resultIndex: 1, results: [first, recognitionResult('вторая часть', true)] });
  assert.deepEqual(commits, ['первая часть', 'вторая часть']);
  assert.deepEqual(finals, [], 'устойчивый browser chunk ещё не завершает voice-turn');

  const lateEnd = recognition.onend;
  lateEnd();
  lateEnd();
  assert.deepEqual(finals, ['первая часть вторая часть']);

  lease.release();
  controller.dispose();
});

test('COMP-STT-05/08: cancel инвалидирует поздние result/onend и не выпускает terminal onFinal', async () => {
  const settings = { value: speech() };
  const { controller, instances } = browserHarness(settings);
  const commits = [];
  const finals = [];
  const lease = controller.acquire(Symbol('companion'), {
    onCommit: (text) => commits.push(text),
    onFinal: (text) => finals.push(text),
  });

  await lease.start();
  const recognition = instances[0];
  const lateResult = recognition.onresult;
  const lateEnd = recognition.onend;
  await lease.cancel();
  lateResult({ resultIndex: 0, results: [recognitionResult('слишком поздно', true)] });
  lateEnd();

  assert.deepEqual(commits, []);
  assert.deepEqual(finals, []);
  assert.equal(recognition.abortCalls, 1);
  lease.release();
  controller.dispose();
});

test('COMP-STT-09: browser-auto consent остаётся prompt action и стартует только после server revision', async () => {
  const settings = { value: speech({ browserProcessing: 'auto' }) };
  const posts = [];
  const confirmed = speech({
    browserProcessing: 'auto',
    browserAutoConsent: true,
    revision: 'speech:consented-r2',
  });
  const { controller, instances } = browserHarness(settings, {
    apiClient: {
      async get() { return {}; },
      async post(path, body) {
        posts.push({ path, body });
        return { settings: confirmed, revision: confirmed.revision };
      },
      async upload() { return {}; },
      async del() { return {}; },
    },
  });
  const lease = controller.acquire(Symbol('chat'));

  await lease.start();
  assert.equal(lease.state.prompt, 'browser-consent');
  assert.equal(instances.length, 0);
  await lease.confirmBrowserConsent();
  assert.deepEqual(posts[0], {
    path: '/api/settings/speech/browser-consent',
    body: { confirm: true, revision: 'speech:test-r1' },
  });
  assert.equal(instances.length, 1);
  assert.equal(instances[0].startCalls, 1);

  await lease.cancel();
  lease.release();
  controller.dispose();
});

test('COMP-STT-06/11: пустой browser turn не вызывает onFinal и onend сам не перезапускает mic', async () => {
  const settings = { value: speech() };
  const { controller, instances } = browserHarness(settings);
  const finals = [];
  const lease = controller.acquire(Symbol('companion'), { onFinal: (text) => finals.push(text) });

  await lease.start();
  instances[0].onresult({ resultIndex: 0, results: [recognitionResult('preview', false)] });
  instances[0].onend();
  await Promise.resolve();

  assert.deepEqual(finals, []);
  assert.equal(instances.length, 1, 'browser onend не создаёт новый recognition');
  assert.equal(lease.state.phase, 'idle');
  await lease.release();
  await controller.dispose();
});

test('COMP-STT-10: недоступный Whisper fail-closed и не включает browser recognition', async () => {
  const settings = { value: speech({ engine: 'whisper', local: { ready: false, reason: 'нет runtime' } }) };
  const { controller, instances } = browserHarness(settings);
  const errors = [];
  const lease = controller.acquire(Symbol('chat'), { onError: (error) => errors.push(error) });

  await lease.start();

  assert.equal(instances.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'speech_local_unavailable');
  assert.match(errors[0].message, /Whisper недоступен/);
  await lease.release();
  await controller.dispose();
});
