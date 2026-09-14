import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import { runtimeOf } from './showcaseRuntime';
import type { ShowcaseStore } from './showcaseRuntime';

/** Ключ относится к одному нажатию и пригоден для безопасного повтора POST сервером. */
function buildRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  const random = Math.random().toString(36).slice(2, 14);

  return `build_${Date.now().toString(36)}_${random}`;
}

/**
 * Сохраняемый запуск создаётся одним POST. Браузер не ждёт дочерние задания и не
 * решает, какую стадию запускать следующей: после 202 его можно закрыть, а run
 * восстановится из overview/SSE с тем же sequence.
 */
export function buildShowcaseFilm(store: ShowcaseStore): Promise<boolean> {
  const opened = store.opened;

  if (!opened) {
    return Promise.resolve(false);
  }

  const active = store.activeBuildOf(opened.id);

  if (active) {
    return Promise.resolve(true);
  }

  const runtime = runtimeOf(store);
  const pending = runtime.builds.get(opened.id);

  if (pending) {
    return pending;
  }

  const projectId = opened.id;
  const requestId = buildRequestId();

  store.setBusy(projectId, true);

  const request = showcaseApi.startBuild(projectId, opened.revision, requestId)
    .then((run) => {
      store.applyBuildRun(run);
      store.setError('');

      return true;
    })
    .catch((error: unknown) => {
      store.setError(showcaseErrorMessage(error, 'Не удалось запустить сборку ролика.'));

      return false;
    })
    .finally(() => {
      runtime.builds.delete(projectId);
      store.setBusy(projectId, false);
    });

  runtime.builds.set(projectId, request);

  return request;
}

/**
 * Отмена относится ко всему run, а не к одной стадии. Текущий дочерний job
 * сервер остановит сам и сохранит итоговый снимок запуска.
 */
export async function cancelShowcaseBuild(
  store: ShowcaseStore,
  runId: string,
): Promise<boolean> {
  try {
    store.applyBuildRun(await showcaseApi.cancelBuild(runId));
    store.setError('');

    return true;
  } catch (error) {
    store.setError(showcaseErrorMessage(error, 'Не удалось остановить сборку ролика.'));

    return false;
  }
}
