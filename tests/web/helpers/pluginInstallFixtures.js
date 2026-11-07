import { installJob, installedRecord } from '../../server/helpers/pluginInstallState.js';

/**
 * Браузер получает полный публичный DTO с реальными связями status и preview.
 * Synthetic значения не зависят от каталога или приватного состояния машины.
 */
export function webInstallJob(status = 'ready', kind = 'install', overrides = {}) {
  const job = installJob(status, kind);

  if (status === 'running') {
    job.pluginId = null;
    job.target = null;
    job.preview = null;
  }

  if (['failed', 'interrupted', 'recovery_required'].includes(status)) {
    job.error = {
      code: status === 'failed' ? 'git_failed' : status,
      message: 'Причина из фикстуры',
    };
  }

  return { ...job, ...overrides };
}

/**
 * InstallInfo содержит самостоятельную previous версию и вычисленные флаги.
 * При создании другой revision прежний snapshot остаётся независимым объектом.
 */
export function webInstallInfo(overrides = {}) {
  const record = installedRecord('1.1.0', 3);
  const previous = installedRecord();

  for (const key of ['revision', 'previous', 'latest', 'checkedAt', 'checkError']) {
    delete previous[key];
  }

  return {
    ...record,
    previous,
    updateAvailable: false,
    localChanges: false,
    restartRequired: false,
    rollbackAvailable: true,
    rollbackError: null,
    ...overrides,
  };
}
