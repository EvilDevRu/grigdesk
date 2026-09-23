import { projectsApi, projectsErrorData, projectsFailureText } from '../../shared/projectsApi';
import { useProjectsStore } from '../../stores/projects';
import { createDraft } from '../../views/projects/projectDraft';
import { loadDependencies } from './loadDependencies';
import { loadProjects } from './loadProjects';

export interface ProjectLifecycleResult {
  ok: boolean;
  error: string;
  message: string;
}

/**
 * Одна операция жизненного цикла на два действия: архив и возврат отличаются только
 * вызовом и текстом запасной ошибки. Общая часть — та, где можно ошибиться: ревизия,
 * обновление снимка и перечитывание связей.
 */
export async function changeLifecycle(
  id: string,
  expectedRevision: number,
  action: 'archive' | 'restore',
): Promise<ProjectLifecycleResult> {
  const store = useProjectsStore();

  try {
    const detail = action === 'archive'
      ? await projectsApi.archive(id, expectedRevision)
      : await projectsApi.restore(id, expectedRevision);

    store.setOpened(detail);
    store.setDraft(createDraft(detail));
    store.setConflict(null);
    store.setError('');
    await Promise.all([loadProjects(), loadDependencies(id)]);

    return {
      ok: true,
      error: '',
      message: '',
    };
  } catch (error) {
    const body = projectsErrorData(error);
    const message = projectsFailureText(
      error,
      action === 'archive' ? 'Не удалось убрать проект в архив.' : 'Не удалось вернуть проект.',
    );

    // Свежая сводка объясняет отказ: сервер отказал по связям, и человеку нужен их список.
    await loadDependencies(id);

    return {
      ok: false,
      error: body?.error ?? '',
      message,
    };
  }
}
