import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveInstallDialogView } from '../../web/src/shared/pluginInstallView.ts';
import { webInstallJob } from './helpers/pluginInstallFixtures.js';

/**
 * Исходный снимок соответствует пустой форме после чтения current.
 * Каждый сценарий задаёт только наблюдаемое отличие без Vue и сетевых подмен.
 */
function input(overrides = {}) {
  return {
    job: null,
    mode: 'install',
    pluginName: null,
    pluginLocalChanges: false,
    bootLoading: false,
    bootFailed: false,
    error: null,
    recoveryError: null,
    pendingAction: null,
    reconciling: false,
    busy: false,
    versionsLoading: false,
    versionsInputKey: '',
    versionsUrl: '',
    url: '',
    selectedVersion: '',
    replaceModified: false,
    ...overrides,
  };
}

test('Проекция: bootstrap выбирает loading и запрещает запуск', () => {
  const view = deriveInstallDialogView(input({ bootLoading: true }));

  assert.equal(view.screen, 'loading');
  assert.equal(view.canStart, false);
  assert.equal(view.locked, true);
  assert.equal(view.stageHeading, 'Проверяем состояние');
  assert.equal(view.footer.primary.disabled, true);
});

test('Проекция: отказ bootstrap предлагает перечитывание', () => {
  const view = deriveInstallDialogView(input({ bootFailed: true, error: 'Нет связи.' }));

  assert.equal(view.screen, 'unavailable');
  assert.equal(view.stageHeading, 'Нет связи с Cockpit');
  assert.equal(view.footer.primary.action, 'reload');
  assert.equal(view.footer.primary.label, 'Повторить загрузку');
  assert.equal(view.footer.primary.disabled, false);
});

test('Проекция: пустая форма сохраняет source без разрешения запуска', () => {
  const view = deriveInstallDialogView(input());

  assert.equal(view.screen, 'source');
  assert.equal(view.heading, 'Установка плагина из Git');
  assert.equal(view.stageHeading, 'Подключите репозиторий');
  assert.equal(view.canStart, false);
  assert.equal(view.footer.primary.label, 'Скачать и проверить');
  assert.equal(view.footerHint, 'Установка — только после подтверждения.');
});

test('Проекция: fetching измерим, dependencies сохраняет неопределённый progress', () => {
  const fetching = deriveInstallDialogView(input({ job: webInstallJob('running', 'install', {
    stage: 'fetching',
    percent: 40,
  }) }));
  const dependencies = deriveInstallDialogView(input({ job: webInstallJob('running', 'install', {
    stage: 'dependencies',
    percent: null,
  }) }));

  assert.equal(fetching.screen, 'progress');
  assert.deepEqual(fetching.progress, { value: 40, indeterminate: false });
  assert.equal(fetching.stageHeading, 'Скачивание из источника');
  assert.equal(fetching.footer.secondary.action, 'cancel');
  assert.deepEqual(dependencies.progress, { value: 0, indeterminate: true });
  assert.equal(dependencies.stageHeading, 'Установка зависимостей');
});

test('Проекция: ready даёт preview и apply, applying скрывает apply и cancel', () => {
  const job = webInstallJob();
  const ready = deriveInstallDialogView(input({ job }));
  const applying = deriveInstallDialogView(input({ job: webInstallJob('applying') }));

  assert.equal(ready.screen, 'ready');
  assert.deepEqual(ready.preview, job.preview);
  assert.equal(ready.footer.primary.action, 'apply');
  assert.equal(ready.footer.primary.label, 'Установить');
  assert.equal(ready.footer.primary.disabled, false);
  assert.equal(applying.screen, 'progress');
  assert.equal(applying.stageHeading, 'Применяем изменения');
  assert.equal(applying.footer.primary.action, 'close');
  assert.equal(applying.footer.secondary.action, null);
});

test('Проекция: pending apply и reconciliation важнее ready', () => {
  for (const override of [{ pendingAction: 'apply' }, { reconciling: true }]) {
    const view = deriveInstallDialogView(input({ job: webInstallJob(), ...override }));

    assert.equal(view.screen, 'progress');
    assert.equal(view.stageHeading, 'Уточняю исход');
    assert.equal(view.locked, true);
    assert.deepEqual(view.progress, { value: 0, indeterminate: true });
    assert.equal(view.footer.secondary.action, null);
    assert.equal(view.footer.primary.action, 'close');
  }
});

test('Проекция: recoveryError блокирует start и apply с job и без него', () => {
  for (const job of [null, webInstallJob()]) {
    const view = deriveInstallDialogView(input({
      job,
      recoveryError: { code: 'recovery_required', message: 'Нужно восстановление.' },
      selectedVersion: '1.0.0',
      versionsInputKey: 'file:///fixture.git',
      versionsUrl: 'file:///fixture.git',
      url: 'file:///fixture.git',
    }));

    assert.equal(view.locked, true);
    assert.equal(view.canStart, false);
    assert.equal(view.footer.primary.disabled, true);
  }
});

test('Проекция: done install, update и rollback сохраняют разные подписи', () => {
  const install = deriveInstallDialogView(input({ job: webInstallJob('done') }));
  const updated = webInstallJob('done', 'update');

  updated.preview.replaces = {
    kind: 'managed',
    version: '0.9.0',
    sourceChanged: false,
  };

  const update = deriveInstallDialogView(input({ job: updated }));
  const rollback = deriveInstallDialogView(input({ job: webInstallJob('done', 'rollback') }));

  assert.equal(install.stageHeading, 'Установка завершена');
  assert.equal(rollback.stageHeading, 'Версия восстановлена');
  assert.equal(install.resultText,
    'Плагин «Демо» v1.0.0 установлен. Включите его в каталоге и перезапустите Cockpit.');
  assert.equal(update.resultText,
    'Плагин «Демо» обновлён до v1.0.0. Перезапустите Cockpit, чтобы применить.');
  assert.equal(rollback.resultText, 'Версия v1.0.0 восстановлена. Перезапустите Cockpit.');
  assert.equal(rollback.completed, true);
  assert.equal(rollback.footer.primary.label, 'Готово');
});

test('Проекция: failed разрешает retry, recovery_required сохраняет Закрыть без retry', () => {
  const failed = deriveInstallDialogView(input({ job: webInstallJob('failed') }));
  const recovery = deriveInstallDialogView(input({ job: webInstallJob('recovery_required') }));
  const cancelled = deriveInstallDialogView(input({ job: webInstallJob('cancelled') }));

  assert.equal(failed.footer.primary.action, 'retry');
  assert.equal(failed.footer.primary.disabled, false);
  assert.equal(failed.resultTone, 'danger');
  assert.equal(recovery.footer.primary.action, 'close');
  assert.equal(recovery.footer.primary.label, 'Закрыть');
  assert.equal(recovery.stageTone, 'warning');
  assert.equal(recovery.resultTone, 'neutral');
  assert.equal(cancelled.stageTone, 'accent');
  assert.equal(cancelled.resultTone, 'neutral');
});

test('Проекция: глобальное задание определяет заголовок раньше карточки инициатора', () => {
  const view = deriveInstallDialogView(input({
    job: webInstallJob('ready', 'update'),
    mode: 'install',
    pluginName: 'Другой',
  }));
  const source = deriveInstallDialogView(input({ mode: 'update', pluginName: 'Другой' }));

  assert.equal(view.heading, 'Обновление «Демо»');
  assert.equal(view.footer.primary.label, 'Обновить');
  assert.equal(source.heading, 'Обновление «Другой»');
  assert.equal(source.stageHeading, 'Выберите новую версию');
});

test('Проекция: start требует актуальную версию, trim ввода и подтверждение ручных правок', () => {
  const valid = input({
    selectedVersion: '1.0.0',
    versionsInputKey: 'file:///fixture.git',
    versionsUrl: 'file:///canonical.git',
    url: '  file:///fixture.git  ',
  });

  assert.equal(deriveInstallDialogView(valid).canStart, true);
  assert.equal(deriveInstallDialogView({ ...valid, versionsInputKey: 'file:///old.git' }).canStart, false);
  assert.equal(deriveInstallDialogView({ ...valid, versionsLoading: true }).canStart, false);
  assert.equal(deriveInstallDialogView({ ...valid, selectedVersion: '' }).canStart, false);

  const modified = {
    ...valid,
    mode: 'update',
    pluginLocalChanges: true,
  };

  assert.equal(deriveInstallDialogView(modified).canStart, false);
  assert.equal(deriveInstallDialogView({ ...modified, replaceModified: true }).canStart, true);
});
