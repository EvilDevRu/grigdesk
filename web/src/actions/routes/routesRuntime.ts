import type { useRoutesStore } from '../../stores/routes.ts';
import { routesApi } from '../../shared/routesApi.ts';

export type RoutesStore = ReturnType<typeof useRoutesStore>;

export interface RoutesScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultScheduler: RoutesScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RoutesRuntime {
  openRequest: number;
  editorRequest: number;
  listRequest: number;
  api: typeof routesApi;
  scheduler: RoutesScheduler;
  subscribe: ((listener: (name: string, payload?: unknown) => void) => () => void) | null;
  saveTimer: unknown | null;
  savePromise: Promise<void> | null;
  saveQueued: boolean;
  pendingDraftRevision: number | null;
  watchProfile: string | null;
  watchCatalogChanged: (() => void) | null;
  watchOff: (() => void) | null;
  watchFocusOff: (() => void) | null;
  operationId: () => string;
  publishPromise: Promise<void> | null;
}

const runtimes = new WeakMap<object, RoutesRuntime>();

/**
 * Возвращает или создаёт служебное состояние конкретного store.
 * Временные таймеры и запросы живут вне сериализуемого Pinia-состояния.
 */
export function runtimeOf(store: RoutesStore): RoutesRuntime {
  let runtime = runtimes.get(store);

  if (!runtime) {
    runtime = {
      openRequest: 0,
      editorRequest: 0,
      listRequest: 0,
      api: routesApi,
      scheduler: defaultScheduler,
      subscribe: null,
      saveTimer: null,
      savePromise: null,
      saveQueued: false,
      pendingDraftRevision: null,
      watchProfile: null,
      watchCatalogChanged: null,
      watchOff: null,
      watchFocusOff: null,
      operationId: () => crypto.randomUUID(),
      publishPromise: null,
    };
    runtimes.set(store, runtime);
  }

  return runtime;
}

/**
 * Подменяет API, планировщик и подписку для изолированных проверок.
 * Временные таймеры и запросы живут вне сериализуемого Pinia-состояния.
 */
export function configureRoutesRuntime(store: RoutesStore,
  options: {
    api?: Partial<typeof routesApi>;
    scheduler?: RoutesScheduler;
    subscribe?: RoutesRuntime['subscribe'];
    operationId?: RoutesRuntime['operationId'];
  }): void {
  const runtime = runtimeOf(store);

  if (options.api) {
    runtime.api = { ...runtime.api, ...options.api };
  }
  if (options.scheduler) {
    runtime.scheduler = options.scheduler;
  }
  if (options.subscribe !== undefined) {
    runtime.subscribe = options.subscribe;
  }
  if (options.operationId) {
    runtime.operationId = options.operationId;
  }
}
