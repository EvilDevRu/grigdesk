import { projectsApi, projectsFailureText } from '../../shared/projectsApi';
import { useProjectsStore } from '../../stores/projects';

/**
 * Связи проекта. Раздел «Управление» показывает их перед архивом, чтобы человек видел,
 * что именно мешает, а не только «нельзя».
 */
export async function loadDependencies(id: string): Promise<void> {
  const store = useProjectsStore();

  try {
    store.setDependencies(await projectsApi.dependencies(id));
  } catch (error) {
    store.setDependencies(null);
    store.setError(projectsFailureText(error, 'Не удалось прочитать связи проекта.'));
  }
}
