import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

/**
 * Ответ моделирует выбранный сервер с отдельными проверками окружения и кэша.
 * Установленные файлы не подменяются состоянием сохранённой модели диктовки.
 */
function prepareSpeech({ control }) {
  const speech = control.data.speech;

  speech.settings.engine = 'whisper';
  speech.capabilities.environmentReady = true;
  speech.capabilities.environmentChecks = [
    {
      name: 'ffmpeg (извлечение аудио/кадров)',
      ok: true,
      fix: 'sudo apt install -y ffmpeg',
    },
    {
      name: 'faster-whisper (распознавание речи)',
      ok: true,
      fix: 'restore runtime',
    },
  ];
  speech.capabilities.models = [
    {
      modelId: 'medium',
      repo: 'model/medium',
      cached: true,
      sizeMb: 700,
    },
    {
      modelId: 'small',
      repo: 'model/small',
      cached: false,
      sizeMb: 0,
    },
    {
      modelId: 'large-v3-turbo',
      repo: 'model/turbo',
      cached: false,
      sizeMb: 0,
    },
  ];
}

test('Речь: реальная новая форма, CUDA gate, opaque revision и серверные умолчания', async (t) => {
  const h = await settingsHarness(t, 'speech.advanced', 'SpeechPage');

  assert.match(h.wrapper.text(), /CUDA/);
  assert.equal(h.wrapper.findAll('option').find((option) => option.element.value === 'cuda')
    .attributes('disabled') !== undefined, true);
  h.settings.selectPage('speech.language');
  await h.flushPromises();

  const dictionary = h.wrapper.get('textarea');

  await dictionary.setValue('термины нового проекта');
  assert.equal(h.writes().length, 0);
  await h.settings.apply();
  assert.deepEqual(h.writes()[0].body, { dictionary: 'термины нового проекта' });
  assert.equal(h.control.data.speech.revision, 'sha256:browser-fixture');
  h.settings.selectPage('speech.video');
  await h.flushPromises();
  assert.equal(h.wrapper.get('textarea').attributes('maxlength'), '600');
});

test('Речь: установленная модель видна здесь, проверка сервера сохраняет черновик', async (t) => {
  const h = await settingsHarness(t, 'speech.dictation', 'SpeechPage', {
    prepare: prepareSpeech,
  });
  const panel = h.wrapper.get('[data-speech-server-setup]');

  assert.match(panel.text(), /Установлено на сервере/);
  assert.equal(panel.find('[data-download]').exists(), false);
  assert.equal(h.writes().length, 0);
  h.settings.setField('speech', 'dictionary', 'неприменённые термины');
  h.control.data.speech.capabilities.environmentReady = false;
  h.control.data.speech.capabilities.environmentChecks[0].ok = false;
  await panel.get('[data-speech-recheck]').trigger('click');
  await h.flushPromises();

  assert.match(panel.text(), /sudo apt install -y ffmpeg/);
  assert.match(panel.text(), /Требуется установка/);
  assert.equal(h.settings.getValue('speech', 'dictionary'), 'неприменённые термины');
  assert.equal(h.settings.snapshot.dirtyCount, 1);
  assert.equal(h.writes().length, 0);
  assert.equal(h.control.calls.some((call) => call.path === '/api/settings/speech?refresh=1'), true);
});

test('Речь: скачать выбранную модель можно в диктовке и продолжить опрос после перехода', async (t) => {
  const h = await settingsHarness(t, 'speech.dictation', 'SpeechPage', {
    prepare: prepareSpeech,
  });
  let finished = false;

  h.control.handlers['/api/settings/speech/models/small/download'] = () => Response.json({
    jobId: 'setup-download',
    status: 'queued',
  });
  h.control.handlers['/api/settings/speech/jobs/setup-download'] = () => Response.json({
    jobId: 'setup-download',
    modelId: 'small',
    kind: 'download',
    status: finished ? 'done' : 'running',
    progress: { percent: finished ? 100 : 45 },
  });
  h.settings.setField('speech', 'quality', 'fast');
  await h.flushPromises();

  const download = h.wrapper.get('[data-download="small"]');

  await download.trigger('click');
  await download.trigger('click');
  await h.flushPromises();

  assert.equal(h.writes().length, 1);
  assert.equal(h.writes()[0].path, '/api/settings/speech/models/small/download');
  assert.match(h.wrapper.get('[data-model="small"]').text(), /45%/);
  assert.equal(h.wrapper.get('[data-cancel="small"]').exists(), true);
  h.settings.selectPage('speech.language');
  await h.flushPromises();

  const reads = h.control.calls.length;

  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(h.control.calls.length, reads);
  finished = true;
  h.control.data.speech.capabilities.models[1].cached = true;
  h.settings.selectPage('speech.dictation');
  await h.flushPromises();

  assert.match(h.wrapper.get('[data-model="small"]').text(), /Установлено на сервере/);
  assert.equal(h.wrapper.find('[data-download="small"]').exists(), false);
  assert.equal(h.settings.getValue('speech', 'quality'), 'fast');
  assert.equal(h.settings.snapshot.dirtyCount, 1);
});

test('Речь: модель видео независима от диктовки, неизвестное состояние явно обозначено', async (t) => {
  const h = await settingsHarness(t, 'speech.video', 'SpeechPage', {
    prepare: prepareSpeech,
  });

  h.settings.setField('speech', 'videoQuality', 'accurate');
  await h.flushPromises();

  assert.equal(h.wrapper.find('[data-download="large-v3-turbo"]').exists(), true);
  assert.equal(h.wrapper.find('[data-model="medium"]').exists(), false);
  h.control.data.speech.capabilities.models = [];
  await h.wrapper.get('[data-speech-recheck]').trigger('click');
  await h.flushPromises();

  const panel = h.wrapper.get('[data-speech-server-setup]');

  assert.match(panel.text(), /не подтвердил наличие модели large-v3-turbo/);
  assert.equal(panel.find('[data-download]').exists(), false);
  assert.equal(h.writes().length, 0);
});

test('Речь: отказ диагностики кэша и отсутствующий Python блокируют бессмысленное скачивание', async (t) => {
  const h = await settingsHarness(t, 'speech.dictation', 'SpeechPage', {
    /**
     * Скачивание модели не восстановит отсутствующий Python.
     * Проверка кнопки опирается на отчёт сервера, а не на общий ready диктовки.
     */
    prepare({ control }) {
      prepareSpeech({ control });
      control.data.speech.settings.quality = 'fast';
      control.data.speech.capabilities.environmentReady = false;
      control.data.speech.capabilities.environmentChecks.push({
        name: 'python venv (GRIGDESK_MEDIA_PYTHON не задан)',
        ok: false,
        fix: 'configure media Python',
      });
    },
  });

  assert.equal(h.wrapper.get('[data-download="small"]').attributes('disabled'), '');
  h.control.data.speech.capabilities.environmentChecks = [{
    name: 'диагностика кэша моделей',
    ok: false,
    fix: 'cache check failed',
  }];
  await h.wrapper.get('[data-speech-recheck]').trigger('click');
  await h.flushPromises();

  assert.match(h.wrapper.get('[data-model="small"]').text(), /Состояние не проверено/);
  assert.equal(h.wrapper.find('[data-download="small"]').exists(), false);
});
