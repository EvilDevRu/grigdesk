import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { decodeInstallState } from '../../../server/src/lib/packageInstall/stateValidation.ts';

export const moduleWarning = 'Модуль интерфейса исполняется в главном окне GrigDesk '
  + 'с вашей сессией и может обращаться к любому API GrigDesk.';

/**
 * Ресурсы разных выпусков имеют различимые байты, включая стили и оба перевода.
 * Код бросает при импорте: успешная подготовка доказывает отсутствие исполнения.
 */
export function moduleRelease(version, dir = 'ui') {
  return {
    manifest: {
      api: 1,
      contributes: { panels: [{}] },
      entrypoints: { web: {
        dir,
        entry: 'panel.js',
        css: ['panel.css'],
        locales: { ru: 'ru.json', en: 'en.json' },
      } },
    },
    files: {
      [`${dir}/panel.js`]: `throw new Error('Установщик исполнил модуль ${version}');`,
      [`${dir}/panel.css`]: `/* ${version} */ body { color: red; }`,
      [`${dir}/ru.json`]: JSON.stringify({ title: `Модуль ${version}` }),
      [`${dir}/en.json`]: JSON.stringify({ title: `Module ${version}` }),
    },
  };
}

/**
 * Подготовка идёт через настоящий offline Git и публичную границу сервиса.
 * Явная версия позволяет проверять старый выпуск при уже опубликованном новом.
 */
export async function prepareModule(service, url, request = {}) {
  await service.startInstall({ url, ...request });
  await service.whenIdle();

  const job = await service.currentJob();

  assert.equal(job.status, 'ready', JSON.stringify(job.error));

  return job;
}

/**
 * Проверяется настоящий файл состояния, а не его проекция из service API.
 * Прежний закрытый validator и точные ключи preview защищают откат GrigDesk.
 */
export async function compatibleState(statePath) {
  const raw = JSON.parse(await readFile(statePath, 'utf8'));
  const state = decodeInstallState(raw);
  const jobs = [state.job, ...Object.values(state.completedJobs),
    ...Object.values(state.lastRollback).map((receipt) => receipt.job)];
  const keys = ['source', 'target', 'id', 'name', 'version', 'description', 'hasServer', 'hasWeb',
    'replaces', 'changes', 'warnings'].sort();

  for (const job of jobs) {
    if (job?.preview) {
      assert.deepEqual(Object.keys(job.preview).sort(), keys);
    }
  }

  return state;
}
