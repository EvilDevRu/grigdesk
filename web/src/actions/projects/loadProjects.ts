import { projectsApi, projectsFailureText } from '../../shared/projectsApi';
import { useProjectsStore } from '../../stores/projects';
import type { ProjectCatalogScope } from '../../stores/projects';
import { forgetProject, runtimeOf } from './projectsRuntime';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


/**
 * Рабочий каталог и управление архивом принимают независимые снимки сервера.
 * Только полный каталог может подтвердить отсутствие открытого паспорта.
 */
export async function loadProjects(scope: ProjectCatalogScope): Promise<void> {
  const store = useProjectsStore();
  const runtime = runtimeOf(store);
  const catalog = scope === 'all' ? store : store.activeCatalog;
  const request = ++runtime.listRequest[scope];

  catalog.loading = true;

  try {
    const response = await projectsApi.list(scope);
    const items = response.filter((item) => !store.deletedIds.has(item.id));

    if (request !== runtime.listRequest[scope]) {
      return;
    }

    const selected = store.opened?.id || runtime.selectedId;

    if (scope === 'all' && selected && !items.some((item) => item.id === selected)) {
      catalog.loading = false;
      forgetProject(store, selected);
    }

    catalog.items = items;
    catalog.loaded = true;
    catalog.error = '';
  } catch (error) {
    if (request !== runtime.listRequest[scope]) {
      return;
    }

    catalog.error = projectsFailureText(error, translateUi('core.loadProjectsCouldNotReadTheProjectList'));
  } finally {
    if (request === runtime.listRequest[scope]) {
      catalog.loading = false;
    }
  }
}
