import { sseSubscribe } from '../../composables/useSse';
import { useProjectsStore } from '../../stores/projects';
import { loadProject } from './loadProject';
import { loadProjects } from './loadProjects';
import { parseProjectsChange } from '../../../../shared/runtime/projectsContracts';
import { forgetProject, runtimeOf } from './projectsRuntime';

/**
 * Подписка раздела на общий поток событий. `projects-changed` приходит после каждой
 * мутации реестра — список перечитывается; `hello` означает переподключение, когда
 * вкладка могла пропустить события, поэтому перечитывается и открытый паспорт.
 *
 * Открытая форма при этом не трогается: черновик человека важнее чужой правки, а
 * расхождение ревизий покажет сохранение.
 */
export function watchProjects(): void {
  const store = useProjectsStore();
  const runtime = runtimeOf(store);

  if (runtime.off) {
    return;
  }

  runtime.off = sseSubscribe((name, data) => {
    if (name === 'projects-changed') {
      try {
        const change = parseProjectsChange(data);

        if (change.kind === 'deleted') {
          forgetProject(store, change.id);
        }
      } catch {
        // Незнакомое событие не меняет выбор до успешного чтения каталога.
      }

      void loadProjects();

      return;
    }

    if (name === 'hello') {
      void loadProjects().then(() => {
        const openedId = store.opened?.id;

        if (openedId) {
          void loadProject(openedId, { keepDraft: true });
        }
      });
    }
  });
}
