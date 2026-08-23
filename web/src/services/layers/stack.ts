import type {
  UiLayerCloseHandler,
  UiLayerHandle,
  UiLayerName,
  UiLayerRegistrationOptions,
} from '../../types/uiLayers';
import { normalizeUiLayerName, uiLayerPriority } from './priorities';

interface LayerEntry {
  token: symbol;
  id: string;
  name: UiLayerName;
  priority: number;
  sequence: number;
  close: UiLayerCloseHandler;
  enabled?: () => boolean;
  element?: () => HTMLElement | null;
}

export interface LegacyLayerRegistrationOptions {
  priority?: number;
  name?: UiLayerName;
  close: UiLayerCloseHandler;
  enabled?: (() => boolean) | null;
  element?: (() => HTMLElement | null) | null;
}

export type LegacyLayerUnregister = (() => void) & {
  readonly token: symbol;
  readonly handle: UiLayerHandle;
};

const layers = new Map<symbol, LayerEntry>();
const listeners = new Set<() => void>();
let sequence = 0;
let listeningDocument: Document | null = null;

function enabledLayers(): LayerEntry[] {
  return [...layers.values()].filter((layer) => {
    try {
      return layer.enabled?.() !== false;
    } catch {
      return false;
    }
  });
}

function topLayer(): LayerEntry | null {
  return enabledLayers().sort((left, right) => (
    right.priority - left.priority || right.sequence - left.sequence
  ))[0] ?? null;
}

function targetOwnsEscape(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  return Boolean((target as Element).closest('[data-escape-owner]'));
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented || targetOwnsEscape(event.target)) return;

  const layer = topLayer();
  if (!layer) return;

  let handled: boolean | void = false;
  try {
    handled = layer.close(event);
  } catch (error) {
    // Ошибка обработчика не должна передать тот же Escape следующему слою.
    event.preventDefault();
    event.stopImmediatePropagation();
    queueMicrotask(() => { throw error; });
    return;
  }

  // `false` означает: верхний слой осознанно оставил Escape себе, но не закрылся.
  if (handled === false) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function ensureListener(): void {
  if (typeof document === 'undefined' || listeningDocument === document) return;
  listeningDocument?.removeEventListener('keydown', onKeydown, true);
  listeningDocument = document;
  listeningDocument.addEventListener('keydown', onKeydown, true);
}

function removeListenerWhenIdle(): void {
  if (layers.size > 0 || !listeningDocument) return;
  listeningDocument.removeEventListener('keydown', onKeydown, true);
  listeningDocument = null;
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function refreshLayerStack(): void {
  notify();
}

export function subscribeLayerStack(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function activeLayerId(): string | null {
  return topLayer()?.id ?? null;
}

export function activeLayerElement(): HTMLElement | null {
  const element = topLayer()?.element;
  if (!element) return null;
  try {
    return element();
  } catch {
    return null;
  }
}

export function isTopLayerToken(token: symbol): boolean {
  return topLayer()?.token === token;
}

export function registerUiLayer(id: string, options: UiLayerRegistrationOptions): UiLayerHandle {
  ensureListener();
  const token = Symbol(id);
  const entry: LayerEntry = {
    token,
    id,
    name: options.name,
    priority: uiLayerPriority(options.name),
    sequence: ++sequence,
    close: options.close,
    enabled: options.enabled,
    element: options.element,
  };
  layers.set(token, entry);
  notify();

  let registered = true;
  const handle: UiLayerHandle = {
    token,
    id,
    name: entry.name,
    priority: entry.priority,
    isTop: () => registered && isTopLayerToken(token),
    refresh: refreshLayerStack,
    unregister: () => {
      if (!registered) return;
      registered = false;
      layers.delete(token);
      notify();
      removeListenerWhenIdle();
    },
  };
  return handle;
}

/**
 * Переходный API для legacy facade. Новый код передаёт semantic `name`.
 */
export function registerLayer(id: string, options: LegacyLayerRegistrationOptions): LegacyLayerUnregister {
  const name = normalizeUiLayerName(options.name, 'dialog');
  ensureListener();
  const token = Symbol(id);
  const priority = Number.isFinite(options.priority)
    ? Number(options.priority)
    : uiLayerPriority(name);
  const entry: LayerEntry = {
    token,
    id,
    name,
    priority,
    sequence: ++sequence,
    close: options.close,
    enabled: options.enabled ?? undefined,
    element: options.element ?? undefined,
  };
  layers.set(token, entry);
  notify();

  let registered = true;
  const handle: UiLayerHandle = {
    token,
    id,
    name,
    priority,
    isTop: () => registered && isTopLayerToken(token),
    refresh: refreshLayerStack,
    unregister: () => {
      if (!registered) return;
      registered = false;
      layers.delete(token);
      notify();
      removeListenerWhenIdle();
    },
  };
  const unregister = (() => handle.unregister()) as LegacyLayerUnregister;
  Object.defineProperties(unregister, {
    token: { value: token, enumerable: true },
    handle: { value: handle, enumerable: true },
  });
  return unregister;
}

/** Только для изолированных component-тестов, не входит в public facade. */
export function resetLayerStackForTests(): void {
  layers.clear();
  listeners.clear();
  sequence = 0;
  removeListenerWhenIdle();
}
