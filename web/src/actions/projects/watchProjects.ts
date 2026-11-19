import { sseSubscribe } from '../../composables/useSse';
import { useProjectsStore } from '../../stores/projects';
import type { ProjectCatalogScope } from '../../stores/projects';
import { loadProject } from './loadProject';
import { loadProjects } from './loadProjects';
import { parseProjectsChange } from '../../../../shared/runtime/projectsContracts';
import { forgetProject, runtimeOf } from './projectsRuntime';

/**
 * Общий поток обновляет только каталоги, которые используются открытыми экранами.
 * Восстановление соединения перечитывает точный паспорт, сохраняя черновик.
 */
export function watchProjects(scope: ProjectCatalogScope): () => void {
  const store = useProjectsStore();
  const runtime = runtimeOf(store);
  const watchers = runtime.catalogWatchers;

  watchers[scope] += 1;

  runtime.off ??= sseSubscribe((name, data) => {
    if (name === 'projects-changed') {
      try {
        const change = parseProjectsChange(data);

        if (change.kind === 'deleted') {
          forgetProject(store, change.id);
        }
      } catch {
        // Незнакомое событие не меняет выбор до успешного чтения каталога.
      }
    }

    if (name !== 'hello' && name !== 'projects-changed') {
      return;
    }
    if (watchers.active) {
      void loadProjects('active');
    }
    if (!watchers.all) {
      return;
    }

    void loadProjects('all').then(() => {
      const openedId = store.opened?.id;

      if (name === 'hello' && watchers.all && openedId) {
        void loadProject(openedId, { keepDraft: true });
      }
    });
  });

  return () => {
    watchers[scope] -= 1;

    if (!watchers.active && !watchers.all) {
      runtime.off?.();
      runtime.off = null;
    }
  };
}
