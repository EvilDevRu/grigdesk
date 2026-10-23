import { projectsApi, projectsErrorData, projectsFailureText } from '../../shared/projectsApi';
import { useProjectsStore } from '../../stores/projects';
import { loadDependencies } from './loadDependencies';
import { loadProjects } from './loadProjects';
import { forgetProject } from './projectsRuntime';
import type { ProjectLifecycleResult } from './changeLifecycle';

/**
 * Успех удаления наступает только после подтверждённого DELETE, включая повтор.
 * Отказ сохраняет паспорт; свежие связи объясняют, где требуется переназначение.
 */
export async function removeProject(
  id: string,
  { expectedRevision }: { expectedRevision: number },
): Promise<ProjectLifecycleResult> {
  const store = useProjectsStore();

  try {
    await projectsApi.remove(id, expectedRevision);
  } catch (error) {
    const body = projectsErrorData(error);
    const message = projectsFailureText(error, 'Не удалось удалить регистрацию проекта.');

    if (body?.error === 'has_dependencies' || body?.error === 'dependency_check_failed') {
      await loadDependencies(id);
    }

    store.setError(message);

    return {
      ok: false,
      error: body?.error ?? '',
      message,
    };
  }

  forgetProject(store, id);
  store.setError('');
  await loadProjects();

  return {
    ok: true,
    error: '',
    message: '',
  };
}
