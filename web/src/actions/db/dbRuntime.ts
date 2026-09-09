// Нереактивная обвязка операций раздела: подписка на события. В состоянии ей не
// место — Pinia сделала бы реактивной функцию отписки, а привязка к экземпляру стора
// нужна, чтобы свежий стор (например, в тесте) начинал с чистой обвязки.
import type { useDbStore } from '../../stores/db.ts';

export type DbStore = ReturnType<typeof useDbStore>;

interface DbRuntime {
  off: (() => void) | null;
}

const runtimes = new WeakMap<object, DbRuntime>();

/**
 * Обвязка своего экземпляра стора; заводится при первом обращении к нему. Живёт в
 * WeakMap, поэтому вместе со стором исчезает и она — забытая подписка не переживёт
 * свой стор и не начнёт писать в чужое состояние.
 */
export function runtimeOf(store: DbStore): DbRuntime {
  let runtime = runtimes.get(store);

  if (!runtime) {
    runtime = { off: null };
    runtimes.set(store, runtime);
  }

  return runtime;
}
