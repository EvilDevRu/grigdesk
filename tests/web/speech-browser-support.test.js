import assert from 'node:assert/strict';
import test from 'node:test';

import { probeLocalSpeech } from '../../web/src/features/settings/speechBrowser.ts';
import { loadProductModule } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { settingsHarness } from './helpers/settings-harness.js';

const WEBVIEW_UA = 'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Version/4.0 Chrome/156.0.0.0 Mobile Safari/537.36';
const CHROME_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36';

/**
 * WebView объявляет API, но вызов available завершает его renderer без JS-исключения.
 * Счётчик проверяет отсутствие самого вызова; тест не пытается имитировать native crash.
 */
function advertisedRecognition(win, userAgent) {
  const calls = [];

  Object.defineProperty(win.navigator, 'userAgent', { value: userAgent, configurable: true });
  Object.defineProperty(win, 'isSecureContext', { value: true, configurable: true });
  win.SpeechRecognition = {
    prototype: { processLocally: false },
    available: async (options) => {
      calls.push(options);

      return 'available';
    },
  };

  return calls;
}

test('WebView: проверка настроек не вызывает объявленный on-device API', async (t) => {
  const win = await installUiBrowser(t);
  const calls = advertisedRecognition(win, WEBVIEW_UA);

  assert.equal(await probeLocalSpeech(win, 'ru'), 'unavailable');
  assert.equal(calls.length, 0);
});

test('Chrome Android: проверка локальной модели сохраняет язык и возможности', async (t) => {
  const win = await installUiBrowser(t);
  const calls = advertisedRecognition(win, CHROME_UA);

  assert.equal(await probeLocalSpeech(win, 'en'), 'available');
  assert.deepEqual(calls, [{ langs: ['en-US'], processLocally: true }]);
});

test('WebView: настоящая страница диктовки открывается без on-device вызова и записей', async (t) => {
  const win = await installUiBrowser(t);
  const calls = advertisedRecognition(win, WEBVIEW_UA);
  const h = await settingsHarness(t, 'speech.dictation', 'SpeechPage', {
    browser: win,
    prepare({ control }) {
      control.data.speech.settings.browserProcessing = 'local';
    },
  });

  assert.equal(h.wrapper.attributes('data-ready'), 'true');
  assert.match(h.wrapper.text(), /Недоступно/);
  assert.equal(calls.length, 0);
  assert.equal(h.settings.getValue('speech', 'browserProcessing'), 'local');
  assert.equal(h.settings.snapshot.dirtyCount, 0);
  assert.equal(h.writes().length, 0);
});

test('WebView: запуск local не вызывает тот же опасный API и не меняет настройки', async (t) => {
  const win = await installUiBrowser(t);
  const calls = advertisedRecognition(win, WEBVIEW_UA);
  const { createDictationController } = await loadProductModule('src/features/speech/controller.ts');
  const prefs = {
    engine: 'browser',
    browserProcessing: 'local',
    browserAutoConsent: false,
    language: 'ru',
    dictionary: '',
    revision: 'sha256:webview-fixture',
    local: { ready: false, reason: 'Сервер не подготовлен' },
  };
  const controller = createDictationController({ settings: { read: () => prefs } });
  const lease = controller.acquire(Symbol('webview-speech'));

  t.after(() => controller.dispose());
  await lease.start();

  assert.equal(calls.length, 0);
  assert.equal(lease.state.busy, false);
  assert.match(lease.state.error.message, /Сервер не подготовлен/);
  assert.equal(prefs.browserProcessing, 'local');
  assert.equal(prefs.browserAutoConsent, false);
});
