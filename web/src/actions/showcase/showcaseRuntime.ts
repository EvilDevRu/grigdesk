// Нереактивная обвязка операций раздела: подписка на события и текущий запрос обзора.
// В состоянии им не место — Pinia сделала бы реактивными функцию отписки и promise,
// а привязка к экземпляру стора нужна, чтобы свежий стор (например, в тесте) начинал
// с чистой обвязки, а не наследовал чужую.
import type { useShowcaseStore } from '../../stores/showcase';

export type ShowcaseStore = ReturnType<typeof useShowcaseStore>;

interface ShowcaseRuntime {
  off: (() => void) | null;
  loading: Promise<void> | null;
  builds: Map<string, Promise<boolean>>;
  manifests: Map<string, Promise<boolean>>;
}

const runtimes = new WeakMap<object, ShowcaseRuntime>();

/**
 * Обвязка своего экземпляра стора; заводится при первом обращении к нему.
 * Живёт в WeakMap, поэтому вместе со стором исчезает и она — забытая подписка
 * не переживёт свой стор и не начнёт писать в чужое состояние.
 */
export function runtimeOf(store: ShowcaseStore): ShowcaseRuntime {
  let runtime = runtimes.get(store);

  if (!runtime) {
    runtime = {
      off: null,
      loading: null,
      builds: new Map(),
      manifests: new Map(),
    };
    runtimes.set(store, runtime);
  }

  return runtime;
}
