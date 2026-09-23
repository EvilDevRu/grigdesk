import { sseSubscribe } from '../../composables/useSse';
import { useProjectsStore } from '../../stores/projects';
import { loadProject } from './loadProject';
import { loadProjects } from './loadProjects';
import { runtimeOf } from './projectsRuntime';

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

  runtime.off = sseSubscribe((name) => {
    if (name === 'projects-changed') {
      void loadProjects();

      return;
    }

    if (name === 'hello') {
      void loadProjects();

      const openedId = store.opened?.id;

      if (openedId) {
        void loadProject(openedId, { keepDraft: true });
      }
    }
  });
}
