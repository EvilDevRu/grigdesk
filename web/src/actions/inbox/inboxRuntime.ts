// Нереактивная обвязка операций раздела: подписка на события и таймер перепроверки.
// В состоянии им не место — Pinia сделала бы реактивными функцию отписки и дескриптор
// таймера, а привязка к экземпляру стора нужна, чтобы свежий стор (например, в тесте)
// начинал с чистой обвязки, а не наследовал чужую.
import type { useInboxStore } from '../../stores/inbox.ts';

export type InboxStore = ReturnType<typeof useInboxStore>;

interface InboxRuntime {
  off: (() => void) | null;
  timer: ReturnType<typeof setInterval> | null;
}

const runtimes = new WeakMap<object, InboxRuntime>();

/**
 * Обвязка своего экземпляра стора; заводится при первом обращении к нему. Живёт в
 * WeakMap, поэтому вместе со стором исчезает и она — забытый таймер не переживёт
 * свой стор и не начнёт опрашивать выключенный раздел.
 */
export function runtimeOf(store: InboxStore): InboxRuntime {
  let runtime = runtimes.get(store);

  if (!runtime) {
    runtime = { off: null, timer: null };
    runtimes.set(store, runtime);
  }

  return runtime;
}
