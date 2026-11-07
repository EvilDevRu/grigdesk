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
  selectedId: string;
  selectionGeneration: number;
  dependenciesRequest: number;
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
      selectedId: '',
      selectionGeneration: 0,
      dependenciesRequest: 0,
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

/**
 * Удаление инвалидирует ответы выбранного паспорта, но не соседние правки.
 * Счётчик списка меняется для любого удаления, чтобы старый GET не вернул строку.
 */
export function forgetProject(store: ProjectsStore, id: string): void {
  const runtime = runtimeOf(store);

  runtime.listRequest += 1;

  if (runtime.selectedId === id || store.opened?.id === id || store.draft?.id === id) {
    runtime.selectionGeneration += 1;
    runtime.selectedId = '';
    runtime.detailRequest += 1;
    runtime.dependenciesRequest += 1;
    runtime.checkRequest += 1;
    runtime.checkCancelled?.();

    if (runtime.checkTimer !== null) {
      clearTimeout(runtime.checkTimer);
      runtime.checkTimer = null;
    }
  }

  store.removeRegistration(id);
}
