import assert from 'node:assert/strict';
import test from 'node:test';

import { isActiveInstallJob, isTerminalInstallJob } from '../../web/src/shared/pluginInstall.ts';
import { installJob } from '../server/helpers/pluginInstallState.js';

test('W1: active/terminal на восьми статусах, recovery не running и не успешный конец', () => {
  for (const status of ['running', 'ready', 'applying', 'done', 'failed', 'cancelled', 'interrupted',
    'recovery_required']) {
    const job = installJob(status);

    assert.equal(isActiveInstallJob(job), ['running', 'applying'].includes(status));
    assert.equal(isTerminalInstallJob(job), ['done', 'failed', 'cancelled', 'interrupted'].includes(status));
  }

  for (const value of [null, undefined]) {
    assert.equal(isActiveInstallJob(value), false);
    assert.equal(isTerminalInstallJob(value), false);
  }
});

test('W2: stage rows согласуют running/failed/ready/cancelled/interrupted/recovery', async () => {
  const { installStageRows } = await import('../../web/src/shared/pluginInstall.ts');

  for (const [status, expected] of [
    ['running', ['done', 'current', 'pending']], ['failed', ['done', 'failed', 'pending']],
    ['ready', ['done', 'done', 'done']], ['applying', ['done', 'done', 'done']],
    ['done', ['done', 'done', 'done']], ['cancelled', ['done', 'pending', 'pending']],
    ['interrupted', ['done', 'pending', 'pending']], ['recovery_required', ['pending', 'pending', 'pending']],
  ]) {
    const job = installJob(status);

    job.stage = 'validating';

    const rows = installStageRows(job);

    assert.deepEqual(rows.map((row) => row.id), ['fetching', 'validating', 'dependencies']);
    assert.deepEqual(rows.map((row) => row.state), expected);
  }
});

test('W3: fetching percent, неопределённые dependencies/applying,100 ready/done, failures null', async () => {
  const { installProgress } = await import('../../web/src/shared/pluginInstall.ts');
  const running = installJob();

  running.percent = 40;
  assert.deepEqual(installProgress(running), { value: 40, indeterminate: false });
  running.percent = null;
  assert.deepEqual(installProgress(running), { value: 0, indeterminate: true });

  for (const stage of ['validating', 'dependencies']) {
    running.stage = stage;
    running.percent = 40;
    assert.deepEqual(installProgress(running), { value: 0, indeterminate: true });
  }

  assert.deepEqual(installProgress(installJob('applying')), { value: 0, indeterminate: true });

  for (const status of ['ready', 'done']) {
    assert.deepEqual(installProgress(installJob(status)), { value: 100, indeterminate: false });
  }

  for (const status of ['failed', 'cancelled', 'interrupted', 'recovery_required']) {
    assert.equal(installProgress(installJob(status)), null);
  }

  assert.equal(installProgress(null), null);
});

test('W4: result различает fresh/update/rollback, ошибки и остановку/recovery', async () => {
  const { installResultText } = await import('../../web/src/shared/pluginInstall.ts');
  const fresh = installJob('done');
  const update = installJob('done', 'update');
  const rollback = installJob('done', 'rollback');

  update.preview.replaces = {
    kind: 'managed',
    version: '0.9.0',
    sourceChanged: false,
  };
  assert.equal(installResultText(fresh),
    'Плагин «Демо» v1.0.0 установлен. Включите его в каталоге и перезапустите GrigDesk.');
  assert.equal(installResultText(update),
    'Плагин «Демо» обновлён до v1.0.0. Перезапустите GrigDesk, чтобы применить.');
  assert.equal(installResultText(rollback), 'Версия v1.0.0 восстановлена. Перезапустите GrigDesk.');

  const failed = installJob('failed');

  assert.equal(installResultText(failed), 'Установка завершилась ошибкой.');
  failed.error = { code: 'source_unavailable', message: 'Нет доступа.' };
  assert.equal(installResultText(failed), 'Нет доступа.');
  assert.equal(installResultText(installJob('cancelled')), 'Установка отменена.');
  assert.equal(installResultText(installJob('interrupted')),
    'Сервер перезапустился во время установки. Начните заново.');

  const recovery = installJob('recovery_required');

  recovery.error = { code: 'recovery_required', message: 'Требуется восстановление.' };
  assert.equal(installResultText(recovery),
    'Требуется восстановление. Копии сохранены. Новая установка пока недоступна.');
});

test('W5: replaces none/managed/sourceChanged/unmanaged словами объясняет прежнюю копию', async () => {
  const { replacesText } = await import('../../web/src/shared/pluginInstall.ts');

  assert.equal(replacesText({ kind: 'none' }), 'Новый плагин.');
  assert.equal(replacesText({
    kind: 'managed',
    version: '1.0.0',
    sourceChanged: false,
  }),
    'Заменит установленную v1.0.0.');
  assert.equal(replacesText({
    kind: 'managed',
    version: '1.0.0',
    sourceChanged: true,
  }),
    'Заменит установленную v1.0.0. Источник сменится.');
  assert.equal(replacesText({ kind: 'unmanaged' }),
    'Заменит папку, положенную вручную; она переедет в резерв.');
});

test('W6: restart badge приоритетнее update, omitted/null install безопасны', async () => {
  const { pluginInstallBadge } = await import('../../web/src/shared/pluginInstall.ts');

  for (const [install, expected] of [
    [{ restartRequired: true, updateAvailable: true }, 'restart'],
    [{ restartRequired: false, updateAvailable: true }, 'update'],
    [{ restartRequired: false, updateAvailable: false }, ''], [null, ''], [undefined, ''],
  ]) {
    assert.equal(pluginInstallBadge({ install }), expected);
  }
});

test('W7: short SHA и русские подписи всех этапов', async () => {
  const { shortSha, INSTALL_STAGE_LABELS, INSTALL_STAGE_ORDER } =
    await import('../../web/src/shared/pluginInstall.ts');

  assert.equal(shortSha('abcdef0123456789'), 'abcdef0');
  assert.equal(shortSha('abc'), 'abc');
  assert.deepEqual(INSTALL_STAGE_ORDER, ['fetching', 'validating', 'dependencies']);
  assert.deepEqual(INSTALL_STAGE_LABELS, {
    fetching: 'Скачивание из источника',
    validating: 'Проверка пакета',
    dependencies: 'Установка зависимостей',
  });
});
