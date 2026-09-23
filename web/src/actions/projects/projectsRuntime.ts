// Нереактивная обвязка операций раздела: номера последних запросов, отписка от SSE
// и таймер склейки проверок.
//
// В состоянии стора им не место: Pinia сделала бы реактивными и таймер, и функцию
// отписки, а `$subscribe` на таком поле зациклил бы перерисовку (гоча «таймер в state»).
// Привязка к экземпляру стора — через WeakMap, поэтому забытая подписка не переживёт
// свой стор и не начнёт писать в чужое состояние.
import type { useProjectsStore } from '../../stores/projects';

export type ProjectsStore = ReturnType<typeof useProjectsStore>;

export interface ProjectsRuntime {
  off: (() => void) | null;
  listRequest: number;
  detailRequest: number;
  checkRequest: number;
  checkTimer: ReturnType<typeof setTimeout> | null;
  // Разрешение отменённой проверки: без него ожидающий вызова остался бы навсегда.
  checkCancelled: (() => void) | null;
}

const runtimes = new WeakMap<object, ProjectsRuntime>();

/**
 * Обвязка своего экземпляра стора; заводится при первом обращении к нему.
 * Живёт в WeakMap, поэтому исчезает вместе со стором.
 */
export function runtimeOf(store: ProjectsStore): ProjectsRuntime {
  let runtime = runtimes.get(store);

  if (!runtime) {
    runtime = {
      off: null,
      listRequest: 0,
      detailRequest: 0,
      checkRequest: 0,
      checkTimer: null,
      checkCancelled: null,
    };
    runtimes.set(store, runtime);
  }

  return runtime;
}
