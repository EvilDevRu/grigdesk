import { projectsApi, projectsFailureText } from '../../shared/projectsApi';
import { useProjectsStore } from '../../stores/projects';
import { runtimeOf } from './projectsRuntime';
import type { ProjectsRuntime, ProjectsStore } from './projectsRuntime';

/**
 * Проверка путей без сохранения. Это подсказка форме, а не действие: человек правит
 * путь по буквам, и запрос на каждую букву не нужен — повторный вызов в окне склейки
 * отменяет предыдущий. Таймер живёт в runtime, а не в состоянии стора.
 */
export function checkRepositories(
  dirs: string[],
  { debounceMs = 300 }: { debounceMs?: number } = {},
): Promise<void> {
  const store = useProjectsStore();
  const runtime = runtimeOf(store);

  if (runtime.checkTimer !== null) {
    clearTimeout(runtime.checkTimer);
    runtime.checkTimer = null;
    runtime.checkCancelled?.();
    runtime.checkCancelled = null;
  }

  runtime.checkRequest += 1;

  const request = runtime.checkRequest;

  return new Promise<void>((resolve) => {
    runtime.checkTimer = setTimeout(() => {
      runtime.checkTimer = null;
      runtime.checkCancelled = null;
      void runCheck(store, runtime, dirs, request).finally(resolve);
    }, debounceMs);
    runtime.checkCancelled = resolve;
  });
}

/**
 * Запрос к серверу и раскладка ответа по строкам формы. Результат применяется, только
 * если запрос всё ещё последний: пока он шёл, человек мог изменить путь, и подсказка
 * о прежнем пути была бы неправдой.
 */
async function runCheck(
  store: ProjectsStore,
  runtime: ProjectsRuntime,
  paths: string[],
  request: number,
): Promise<void> {
  try {
    const { results } = await projectsApi.check(paths);

    if (request !== runtime.checkRequest) {
      return;
    }

    for (const result of results) {
      if (paths.includes(result.dir)) {
        store.setCheck(result.dir, { state: result.state, message: result.message });
      }
    }
  } catch (error) {
    if (request !== runtime.checkRequest) {
      return;
    }

    store.setError(projectsFailureText(error, 'Не удалось проверить пути репозиториев.'));
  }
}
