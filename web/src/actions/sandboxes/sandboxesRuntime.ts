// Нереактивная обвязка операций раздела: подписка на события и текущий запрос обзора.
// В состоянии им не место — Pinia сделала бы реактивными функцию отписки и promise,
// а привязка к экземпляру стора нужна, чтобы свежий стор (например, в тесте) начинал
// с чистой обвязки, а не наследовал чужую.
import type { useSandboxesStore } from '../../stores/sandboxes';

export type SandboxesStore = ReturnType<typeof useSandboxesStore>;

interface SandboxesRuntime {
  off: (() => void) | null;
  loading: Promise<void> | null;
}

const runtimes = new WeakMap<object, SandboxesRuntime>();

/**
 * Обвязка своего экземпляра стора; заводится при первом обращении к нему.
 * Живёт в WeakMap, поэтому вместе со стором исчезает и она — забытая подписка
 * не переживёт свой стор и не начнёт писать в чужое состояние.
 */
export function runtimeOf(store: SandboxesStore): SandboxesRuntime {
  let runtime = runtimes.get(store);

  if (!runtime) {
    runtime = { off: null, loading: null };
    runtimes.set(store, runtime);
  }

  return runtime;
}
