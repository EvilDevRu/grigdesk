import { projectsApi, projectsFailureText } from '../../shared/projectsApi';
import { useProjectsStore } from '../../stores/projects';
import { runtimeOf } from './projectsRuntime';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


/**
 * Связи проекта. Раздел «Управление» показывает их перед архивом, чтобы человек видел,
 * что именно мешает, а не только «нельзя».
 */
export async function loadDependencies(id: string): Promise<void> {
  const store = useProjectsStore();
  const runtime = runtimeOf(store);
  const request = ++runtime.dependenciesRequest;
  const generation = runtime.selectionGeneration;

  try {
    const dependencies = await projectsApi.dependencies(id);

    if (request !== runtime.dependenciesRequest || generation !== runtime.selectionGeneration
      || store.deletedIds.has(id)) {
      return;
    }

    store.setDependencies(dependencies);
  } catch (error) {
    if (request !== runtime.dependenciesRequest || generation !== runtime.selectionGeneration
      || store.deletedIds.has(id)) {
      return;
    }

    store.setDependencies(null);
    store.setError(
      projectsFailureText(error, translateUi('core.loadDependenciesCouldNotReadProjectDependencies')),
    );
  }
}
