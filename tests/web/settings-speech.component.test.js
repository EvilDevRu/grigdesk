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

test('Речь: одна установка, простые поля и свёрнутые инженерные настройки', async (t) => {
  const h = await settingsHarness(t, 'speech.dictation', 'SpeechPage');

  assert.equal(h.wrapper.findAll('[data-speech-installation]').length, 1);
  assert.equal(h.wrapper.get('[data-speech-advanced-toggle]').attributes('aria-expanded'), 'false');
  assert.equal(h.wrapper.find('[data-speech-advanced]').exists(), false);
  assert.equal(h.wrapper.find('[data-benchmark]').exists(), false);
  assert.deepEqual(h.wrapper.findAll('select').map((select) => select.element.value),
    ['balanced', 'auto']);
  assert.deepEqual(h.wrapper.find('select').findAll('option').map((option) => option.text()),
    ['Быстрее', 'Обычное', 'Точнее']);

  assert.equal(h.wrapper.find('textarea').exists(), false);
  assert.equal(h.wrapper.find('[data-model]').exists(), false);
  assert.equal(h.wrapper.find('[role="switch"]').exists(), false);
  await h.wrapper.get('[data-speech-advanced-toggle]').trigger('click');
  await h.wrapper.get('textarea').setValue('термины нового проекта');
  assert.equal(h.wrapper.findAll('[data-speech-installation]').length, 1);
  assert.equal(h.wrapper.get('option[value="cuda"]').attributes('disabled'), '');
  assert.equal(h.wrapper.get('textarea[maxlength="600"]').exists(), true);
  assert.equal(h.wrapper.find('[data-benchmark]').exists(), true);
  assert.equal(h.writes().length, 0);
  await h.settings.apply();

  assert.deepEqual(h.writes()[0].body, { dictionary: 'термины нового проекта' });
  assert.equal(h.control.data.speech.revision, 'sha256:browser-fixture');
});

test('Речь: поиск инженерного поля раскрывает расширенные настройки и фокусирует поле', async (t) => {
  const h = await settingsHarness(t, 'speech.dictation', 'SpeechPage');

  h.settings.reveal({ pageId: 'speech.advanced', fieldPath: ['beamSize'] });
  await h.flushPromises();

  assert.equal(h.settings.pageId, 'speech.dictation');
  assert.equal(h.wrapper.get('[data-speech-advanced-toggle]').attributes('aria-expanded'), 'true');
  assert.equal(h.wrapper.get('[data-revealed] input').element === h.browser.document.activeElement, true);
  assert.equal(h.writes().length, 0);
});

test('Речь: установленная модель видна здесь, проверка сервера сохраняет черновик', async (t) => {
  const h = await settingsHarness(t, 'speech.dictation', 'SpeechPage', {
    prepare: prepareSpeech,
  });
  const panel = h.wrapper.get('[data-speech-server-setup]');

  assert.match(panel.text(), /Готово/);
  assert.equal(h.wrapper.find('[data-model="medium"] [data-download]').exists(), false);
  assert.equal(panel.find('[data-download]').exists(), false);
  assert.equal(h.writes().length, 0);
  h.settings.setField('speech', 'dictionary', 'неприменённые термины');
  h.control.data.speech.capabilities.environmentReady = false;
  h.control.data.speech.capabilities.environmentChecks[0].ok = false;
  await h.wrapper.get('[data-speech-advanced-toggle]').trigger('click');
  await h.wrapper.get('[data-speech-recheck]').trigger('click');
  await h.flushPromises();

  assert.doesNotMatch(panel.text(), /sudo apt|deploy\/install\.sh/);
  assert.match(panel.text(), /Не установлено/);
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
  await h.wrapper.get('[data-speech-preset] select').setValue('fast');
  await h.flushPromises();

  assert.equal(h.writes().length, 1);
  assert.equal(h.writes()[0].path, '/api/settings/speech/models/small/download');
  assert.match(h.wrapper.get('[data-speech-model-status]').text(), /45%/);
  assert.equal(h.wrapper.get('[data-speech-preset] [role="progressbar"]')
    .attributes('aria-valuenow'), '45');
  assert.equal(h.settings.getValue('speech', 'videoQuality'), 'fast');
  assert.equal(h.wrapper.find('[data-model]').exists(), false);
  h.settings.selectPage('interface.behavior');
  await h.flushPromises();

  const reads = h.control.calls.length;

  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(h.control.calls.length, reads);
  finished = true;
  h.control.data.speech.capabilities.models[1].cached = true;
  h.settings.selectPage('speech.dictation');
  await h.flushPromises();

  assert.match(h.wrapper.get('[data-speech-installation-status]').text(), /Готово/);
  assert.equal(h.wrapper.find('[data-download="small"]').exists(), false);
  assert.equal(h.settings.getValue('speech', 'quality'), 'fast');
  assert.equal(h.settings.snapshot.dirtyCount, 2);
});

test('Речь: модель видео независима от диктовки, неизвестное состояние явно обозначено', async (t) => {
  const h = await settingsHarness(t, 'speech.dictation', 'SpeechPage', {
    prepare: prepareSpeech,
  });

  await h.wrapper.get('[data-speech-advanced-toggle]').trigger('click');
  h.settings.setField('speech', 'videoQuality', 'accurate');
  await h.flushPromises();

  assert.equal(h.wrapper.find('[data-download="large-v3-turbo"]').exists(), true);
  assert.equal(h.wrapper.get('[data-model="medium"] [data-speech-model-selected]').text(),
    'Выбрана для диктовки');
  assert.equal(h.wrapper.get('[data-model="large-v3-turbo"] [data-speech-model-selected]').text(),
    'Выбрана для видео');
  h.control.data.speech.capabilities.models = [];
  await h.wrapper.get('[data-speech-recheck]').trigger('click');
  await h.flushPromises();

  const panel = h.wrapper.get('[data-speech-server-setup]');

  assert.match(h.wrapper.text(), /не подтвердил наличие модели large-v3-turbo/);
  assert.equal(panel.find('[data-download]').exists(), false);
  assert.equal(h.writes().length, 0);
});

test('Речь: установка требует подтверждения и не применяет черновик', async (t) => {
  const h = await settingsHarness(t, 'speech.dictation', 'SpeechPage', {
    prepare({ control }) {
      prepareSpeech({ control });
      control.data.speech.capabilities.environmentReady = false;
    },
  });
  let running = false;

  h.control.handlers['/api/settings/speech/installation/install'] = () => {
    running = true;

    return Response.json({
      managed: true,
      installed: false,
      job: {
        id: 'runtime-install',
        operation: 'install',
        status: 'running',
        stage: 'packages',
        output: 'package progress',
        error: '',
      },
    });
  };
  h.control.handlers['/api/settings/speech/installation'] = () => Response.json({
    managed: true,
    installed: false,
    job: running ? {
      id: 'runtime-install',
      operation: 'install',
      status: 'running',
      stage: 'packages',
      output: 'package progress',
      error: '',
    } : null,
  });
  h.settings.setField('speech', 'dictionary', 'сохранить черновик');
  h.control.answer = false;
  await h.wrapper.get('[data-speech-install="install"]').trigger('click');
  await h.flushPromises();

  assert.equal(h.writes().length, 0);
  h.control.answer = true;
  await h.wrapper.get('[data-speech-install="install"]').trigger('click');
  await h.wrapper.get('[data-speech-install="install"]').trigger('click');
  await h.flushPromises();

  assert.equal(h.writes().length, 1);
  assert.equal(h.writes()[0].path, '/api/settings/speech/installation/install');
  assert.deepEqual(h.writes()[0].body, { modelId: 'medium' });
  assert.match(h.wrapper.get('[data-speech-installation-status]').text(), /установка компонентов/i);
  assert.equal(h.wrapper.find('[data-speech-installation] pre').exists(), false);
  assert.equal(h.wrapper.get('[data-speech-install="install"]').attributes('disabled'), '');
  assert.equal(h.settings.getValue('speech', 'dictionary'), 'сохранить черновик');
  assert.equal(h.settings.snapshot.dirtyCount, 1);
});

test('Речь: обновление и удаление доступны установленному окружению', async (t) => {
  const h = await settingsHarness(t, 'speech.dictation', 'SpeechPage', { prepare: prepareSpeech });
  const completed = {
    managed: true,
    installed: false,
    job: {
      id: 'runtime-uninstall',
      operation: 'uninstall',
      status: 'succeeded',
      stage: 'done',
      output: '',
      error: '',
    },
  };

  h.control.handlers['/api/settings/speech/installation/uninstall'] = () => Response.json(completed);
  h.control.handlers['/api/settings/speech/installation'] = () => Response.json(completed);
  assert.equal(h.wrapper.find('[data-speech-install="install"]').exists(), false);
  assert.equal(h.wrapper.find('[data-speech-install="update"]').exists(), true);
  await h.wrapper.get('[data-speech-install="uninstall"]').trigger('click');
  await h.flushPromises();

  assert.equal(h.writes().length, 1);
  assert.match(h.control.confirms[0][0], /модели и настройки речи сохранятся/);
  assert.match(h.wrapper.get('[data-speech-installation-status]').text(), /Не установлено/);
  assert.equal(h.wrapper.find('[data-speech-install="install"]').exists(), true);
  assert.equal(h.control.calls.some((call) => call.path === '/api/settings/speech?refresh=1'), true);
});

test('Речь: установка остаётся одной операцией до готовности выбранной модели', async (t) => {
  let started = false;
  let complete = false;
  const h = await settingsHarness(t, 'speech.dictation', 'SpeechPage', {
    /**
     * Состояние проходит скачивание модели и завершается только после смены снимка.
     * Оба HTTP-адреса возвращают одну серверную операцию без отдельного model job.
     */
    prepare({ control }) {
      prepareSpeech({ control });
      control.data.speech.capabilities.environmentReady = false;
      control.data.speech.settings.quality = 'fast';
      control.handlers['/api/settings/speech/installation/install'] = () => {
        started = true;

        return control.handlers['/api/settings/speech/installation']();
      };
      control.handlers['/api/settings/speech/installation'] = () => Response.json({
        managed: true,
        installed: started,
        job: started ? {
          id: 'with-model',
          operation: 'install',
          status: complete ? 'succeeded' : 'running',
          stage: complete ? 'done' : 'model',
          output: 'NVIDIA GPU: no_device',
          error: '',
        } : null,
      });
    },
  });

  await h.wrapper.get('[data-speech-install="install"]').trigger('click');
  await h.flushPromises();

  assert.deepEqual(h.writes()[0].body, { modelId: 'small' });
  assert.match(h.wrapper.get('[data-speech-installation-status]').text(), /Устанавливаю.*модели/);
  assert.equal(h.wrapper.findAll('[role="progressbar"]').length, 1);
  assert.equal(h.wrapper.get('[data-speech-preset] select').attributes('disabled'), '');
  h.settings.selectPage('interface.behavior');
  await h.flushPromises();
  complete = true;
  h.control.data.speech.capabilities.environmentReady = true;
  h.control.data.speech.capabilities.models[1].cached = true;
  h.settings.selectPage('speech.dictation');
  await h.flushPromises();

  assert.equal(h.wrapper.get('[data-speech-installation-status]').text(), 'Готово');
  assert.equal(h.writes().length, 1);
  assert.equal(h.settings.snapshot.dirtyCount, 0);
});

test('Речь: простой пресет сбрасывает явные модели и выбирает качество для обеих задач', async (t) => {
  const h = await settingsHarness(t, 'speech.dictation', 'SpeechPage', {
    /**
     * Явные модели намеренно перекрывают качество до простого выбора.
     * Готовый small позволяет проверить только черновик, без сетевого задания.
     */
    prepare({ control }) {
      prepareSpeech({ control });
      control.data.speech.settings.model = 'large-v3';
      control.data.speech.settings.videoModel = 'small';
      control.data.speech.capabilities.models[1].cached = true;
    },
  });

  await h.wrapper.get('[data-speech-preset] select').setValue('fast');
  await h.flushPromises();

  assert.equal(h.settings.getValue('speech', 'quality'), 'fast');
  assert.equal(h.settings.getValue('speech', 'videoQuality'), 'fast');
  assert.equal(h.settings.getValue('speech', 'model'), null);
  assert.equal(h.settings.getValue('speech', 'videoModel'), null);
  assert.equal(h.writes().length, 0);
});

test('Речь: возврат перечитывает установку из другого окна без повторного POST', async (t) => {
  let status = 'running';
  const h = await settingsHarness(t, 'speech.dictation', 'SpeechPage', {
    prepare({ control }) {
      prepareSpeech({ control });
      control.handlers['/api/settings/speech/installation'] = () => Response.json({
        managed: true,
        installed: true,
        job: {
          id: 'other-window',
          operation: 'update',
          status,
          stage: status === 'running' ? 'packages' : 'done',
          output: '',
          error: '',
        },
      });
    },
  });

  assert.equal(h.wrapper.get('[data-speech-install="update"]').attributes('disabled'), '');
  h.settings.selectPage('interface.behavior');
  await h.flushPromises();

  const reads = h.control.calls.length;

  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(h.control.calls.length, reads);
  status = 'succeeded';
  h.settings.selectPage('speech.dictation');
  await h.flushPromises();

  assert.match(h.wrapper.get('[data-speech-installation-status]').text(), /Готово/);
  assert.equal(h.wrapper.get('[data-speech-install="update"]').attributes('disabled'), undefined);
  assert.equal(h.writes().length, 0);
});

test('Речь: отказ обновления не показывает прежний успешный результат', async (t) => {
  const h = await settingsHarness(t, 'speech.dictation', 'SpeechPage', {
    prepare({ control }) {
      prepareSpeech({ control });
      control.handlers['/api/settings/speech/installation'] = () => Response.json({
        managed: true,
        installed: true,
        job: {
          id: 'old-success',
          operation: 'update',
          status: 'succeeded',
          stage: 'done',
          output: '',
          error: '',
        },
      });
      control.handlers['/api/settings/speech/installation/update'] = () => Response.json({
        error: 'speech_runtime_busy',
        message: 'Дождитесь окончания распознавания',
      }, { status: 409 });
    },
  });

  await h.wrapper.get('[data-speech-install="update"]').trigger('click');
  await h.flushPromises();

  assert.equal(h.writes().length, 1);
  assert.match(h.wrapper.get('[data-speech-installation]').text(), /Дождитесь окончания распознавания/);
  assert.doesNotMatch(h.wrapper.get('[data-speech-installation-status]').text(), /Готово/);
});

test('Речь: внешнему окружению недоступны файловые действия', async (t) => {
  const h = await settingsHarness(t, 'speech.dictation', 'SpeechPage', {
    prepare({ control }) {
      prepareSpeech({ control });
      control.handlers['/api/settings/speech/installation'] = () => Response.json({
        managed: false,
        installed: true,
        job: null,
      });
    },
  });

  assert.match(h.wrapper.get('[data-speech-installation]').text(), /внешнее окружение речи/);
  assert.equal(h.wrapper.find('[data-speech-install]').exists(), false);
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

  await h.wrapper.get('[data-speech-advanced-toggle]').trigger('click');
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


/**
 * В компонентной проверке терминал записывает доставленное намерение и ничего не исполняет.
 * Настоящий переход настроек по-прежнему отвечает за черновик и закрытие модала.
 */
function dependencyOptions(dependency = 'ffmpeg') {
  return {
    moduleStubs: {
      '../../../shared/tools/launcher.ts': `
        export const useToolLauncher = () => ({
          openTerminal: async (target) => {
            globalThis.__settingsHarness.terminals.push(target);
            return true;
          },
        });
      `,
    },
    /**
     * Отсутствующая зависимость сохраняется в серверном снимке, терминал только записывает intent.
     * Недоверенный fix специально отличается от разрешённой команды установки.
     */
    prepare({ control }) {
      prepareSpeech({ control });
      control.terminals = [];
      control.data.speech.capabilities.environmentReady = false;
      control.data.speech.capabilities.environmentChecks[0].ok = dependency !== 'ffmpeg';
      control.data.speech.capabilities.environmentChecks[0].fix = 'не исполнять: echo unsafe';
      control.handlers['/api/settings/speech/installation'] = () => Response.json({
        managed: true,
        installed: true,
        job: {
          id: 'missing-dependency',
          operation: 'install',
          status: 'failed',
          stage: dependency === 'ffmpeg' ? 'verification' : 'environment',
          error: 'Не установлена системная зависимость',
          output: '',
          dependency,
        },
      });
    },
  };
}

for (const [dependency, command] of [
  ['ffmpeg', 'sudo apt install -y ffmpeg'],
  ['python_venv', 'sudo apt install -y python3-venv'],
]) {
  test(`Речь: ссылка ${dependency} открывает терминал с командой без Enter`, async (t) => {
    const h = await settingsHarness(t, 'speech.dictation', 'SpeechPage', dependencyOptions(dependency));
    const link = h.wrapper.get(`[data-speech-dependency="${dependency}"]`);

    assert.equal(link.attributes('data-variant'), 'link');
    assert.match(link.text(), /Установить/);
    assert.deepEqual(h.control.terminals, []);
    await link.trigger('click');
    await h.flushPromises();

    assert.deepEqual(h.control.terminals, [{ insert: command }]);
    assert.equal(h.control.terminals[0].insert.includes('\n'), false);
    assert.equal(h.writes().length, 0);
  });
}

test('Речь: переход к установке зависимости ждёт выбора по черновику', async (t) => {
  const h = await settingsHarness(t, 'speech.dictation', 'SpeechPage', dependencyOptions());

  h.settings.setField('speech', 'dictionary', 'несохранённый словарь');
  await h.wrapper.get('[data-speech-dependency="ffmpeg"]').trigger('click');
  await h.flushPromises();

  assert.equal(h.settings.closeChoiceOpen, true);
  assert.deepEqual(h.control.terminals, []);
  await h.settings.chooseClose('continue');
  assert.equal(h.settings.getValue('speech', 'dictionary'), 'несохранённый словарь');
  assert.deepEqual(h.control.terminals, []);
  await h.wrapper.get('[data-speech-dependency="ffmpeg"]').trigger('click');
  await h.settings.chooseClose('discard');
  await h.flushPromises();

  assert.deepEqual(h.control.terminals, [{ insert: 'sudo apt install -y ffmpeg' }]);
  assert.equal(h.writes().length, 0);
});

test('Речь: успешная перепроверка скрывает ссылку старой ошибки ffmpeg', async (t) => {
  const h = await settingsHarness(t, 'speech.dictation', 'SpeechPage', dependencyOptions());

  assert.equal(h.wrapper.find('[data-speech-dependency="ffmpeg"]').exists(), true);
  h.control.data.speech.capabilities.environmentChecks[0].ok = true;
  await h.wrapper.get('[data-speech-advanced-toggle]').trigger('click');
  await h.wrapper.get('[data-speech-recheck]').trigger('click');
  await h.flushPromises();

  assert.equal(h.wrapper.find('[data-speech-dependency]').exists(), false);
  assert.deepEqual(h.control.terminals, []);
});
