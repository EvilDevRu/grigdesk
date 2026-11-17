// Нереактивная обвязка операций раздела: подписка на события и текущий запрос обзора.
// В состоянии им не место — Pinia сделала бы реактивными функцию отписки и promise,
// а привязка к экземпляру стора нужна, чтобы свежий стор (например, в тесте) начинал
// с чистой обвязки, а не наследовал чужую.
import type { useShowcaseStore } from '../../stores/showcase';

export type ShowcaseStore = ReturnType<typeof useShowcaseStore>;

interface ShowcaseRuntime {
  off: (() => void) | null;
  generation: number;
  navigationEpoch: number;
  refreshPending: boolean;
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
      generation: 0,
      navigationEpoch: 0,
      refreshPending: false,
      loading: null,
      builds: new Map(),
      manifests: new Map(),
    };
    runtimes.set(store, runtime);
  }

  return runtime;
}

/**
 * Снимок намерения навигации не меняется от новой revision той же карточки.
 * Он инвалидируется новым маршрутом, закрытием или уходом со страницы раздела.
 */
export function captureShowcaseNavigation(store: ShowcaseStore): () => boolean {
  const runtime = runtimeOf(store);
  const epoch = runtime.navigationEpoch;

  return () => runtime.navigationEpoch === epoch;
}

/**
 * Намерение сменить маршрут регистрируется ДО GET: opened может ещё долго быть A,
 * пока B грузится. Уже начавшиеся действия и refresh не принадлежат этому намерению.
 */
export function beginShowcaseNavigation(store: ShowcaseStore): () => boolean {
  runtimeOf(store).navigationEpoch += 1;

  return captureShowcaseNavigation(store);
}

/**
 * Прямой ответ принадлежит фактической карточке и намерению маршрута. Два счётчика
 * закрывают и ручной setOpened(A→B→A), и путь A→маршрут B(pending)→A без смены opened.
 */
export function showcaseProjectOwner(
  store: ShowcaseStore,
  id: string | null = store.opened?.id ?? null,
): () => boolean {
  const navigationCurrent = captureShowcaseNavigation(store);
  const openedEpoch = store.openedEpoch;

  return () => navigationCurrent()
    && store.openedEpoch === openedEpoch
    && (store.opened?.id ?? null) === id;
}
