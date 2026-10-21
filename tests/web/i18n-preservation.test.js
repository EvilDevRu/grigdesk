import assert from 'node:assert/strict';
import test from 'node:test';

import { createDictationController } from '../../web/src/features/speech/controller.js';
import { probeLocalSpeech } from '../../web/src/features/settings/speechBrowser.ts';
import { installUiBrowser } from './helpers/ui-components.js';
import { i18nBrowser, openLanguageChat, assertLanguageChat } from './helpers/i18nBrowser.js';

test('GUARD-STATE: настройки сохраняют настоящий чат, DOM, ввод, выделение и прокрутку', {
  timeout: 120000,
}, async (t) => {
  const { browser, origin } = await i18nBrowser(t);
  const context = await browser.newContext({ locale: 'ru-RU' });

  t.after(() => context.close());

  const page = await context.newPage();

  await openLanguageChat(page, origin);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.locator('[data-role="settings-modal"]').waitFor();
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await page.locator('[data-role="settings-modal"]').waitFor({ state: 'hidden' });
  await assertLanguageChat(page);
});

test('GUARD-SPEECH: auto, явные RU/EN и Whisper не зависят от настройки интерфейса', async (t) => {
  const win = await installUiBrowser(t);
  const instances = [];

  win.document.documentElement.lang = 'ru';
  Object.defineProperty(win.navigator, 'language', { value: 'en-US', configurable: true });

  class Recognition {
    static async available() {
      return 'available';
    }

    constructor() {
      instances.push(this);
    }

    start() {}
    abort() {}
  }

  Recognition.prototype.processLocally = false;
  win.SpeechRecognition = Recognition;

  const prefs = {
    engine: 'browser',
    language: 'auto',
    browserProcessing: 'local',
    browserAutoConsent: false,
    dictionary: '',
  };
  const controller = createDictationController({ settings: { read: () => prefs } });

  t.after(() => controller.dispose());

  const lease = controller.acquire(Symbol('i18n-preservation'));

  for (const [language, expected] of [['auto', 'ru-RU'], ['ru', 'ru-RU'], ['en', 'en-US']]) {
    prefs.language = language;
    await lease.start();
    assert.equal(instances.at(-1).lang, expected);
    await lease.cancel();
  }

  assert.equal(prefs.engine, 'browser');
  lease.release();

  for (const lang of ['ru', 'en']) {
    win.document.documentElement.lang = lang;

    const uploaded = Promise.withResolvers();
    const whisper = { 
      ...prefs, 
      engine: 'whisper', 
      language: 'auto', 
      local: { ready: true } 
    };

    class Recorder {
      constructor() {
        this.mimeType = 'audio/webm';
      }

      start() {
        this.state = 'recording';
      }

      stop() {
        this.state = 'inactive';
        this.ondataavailable({ data: new Blob(['synthetic audio']) });
        this.onstop();
      }
    }

    const local = createDictationController({
      settings: { read: () => whisper },
      media: {
        hasGetUserMedia: () => true,
        getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
        recorderCtor: () => Recorder,
      },
      localStream: { supported: () => false },
      apiClient: {
        upload: async (url, form) => {
          uploaded.resolve({ url, form });

          return { text: 'Синтетическое распознавание' };
        },
      },
    });

    t.after(() => local.dispose());

    const dictation = local.acquire(Symbol('whisper'));

    await dictation.start();
    await dictation.stop();

    const result = await uploaded.promise;

    assert.equal(result.url, '/api/chat/transcribe');
    assert.deepEqual([...result.form.keys()], ['file']);
    assert.equal(result.form.get('language'), null);
    assert.equal(whisper.language, 'auto');
    dictation.release();
  }
});

test('GUARD-SPEECH-PROBE: локальная проверка auto использует прежний язык документа', async (t) => {
  const win = await installUiBrowser(t);
  const calls = [];

  win.document.documentElement.lang = 'ru';
  Object.defineProperty(win.navigator, 'language', { value: 'en-US', configurable: true });
  win.SpeechRecognition = {
    prototype: { processLocally: false },
    available: async (options) => {
      calls.push(options);

      return 'available';
    },
  };

  for (const language of ['auto', 'ru', 'en']) {
    assert.equal(await probeLocalSpeech(win, language), 'available');
  }

  assert.deepEqual(calls, ['ru', 'ru-RU', 'en-US'].map((tag) => ({
    langs: [tag],
    processLocally: true,
  })));
});
