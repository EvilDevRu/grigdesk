import type {
  UiLayerCloseHandler,
  UiLayerHandle,
  UiLayerName,
  UiLayerRegistrationOptions,
} from '../../types/uiLayers';
import { uiLayerPriority } from './priorities.ts';

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
  return (
    enabledLayers().sort(
      (left, right) => right.priority - left.priority || right.sequence - left.sequence,
    )[0] ?? null
  );
}

function targetOwnsEscape(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') {
    return false;
  }

  return Boolean((target as Element).closest('[data-escape-owner]'));
}

/**
 * Передаём Escape верхнему активному слою по его политике.
 * Глобальный обработчик не забирает клавишу у вложенного элемента.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented || targetOwnsEscape(event.target)) {
    return;
  }

  closeTopLayer(event);
}

/**
 * Escape и системный Назад обращаются к одному верхнему слою.
 * Отказ закрыться удерживает навигацию за постоянным диалогом.
 */
export function closeTopLayer(event: KeyboardEvent): boolean {
  const layer = topLayer();

  if (!layer) {
    return false;
  }

  let handled: boolean | void = false;

  try {
    handled = layer.close(event);
  } catch (error) {
    // Ошибка обработчика не должна передать тот же Escape следующему слою.
    event.preventDefault();
    event.stopImmediatePropagation();
    queueMicrotask(() => {
      throw error;
    });

    return true;
  }

  // `false` означает: верхний слой осознанно оставил Escape себе, но не закрылся.
  if (handled === false) {
    return true;
  }

  event.preventDefault();
  event.stopImmediatePropagation();

  return true;
}

/**
 * Вешаем один обработчик клавиатуры на текущий document.
 * При смене документа прежний обработчик снимается.
 */
function ensureListener(): void {
  if (typeof document === 'undefined' || listeningDocument === document) {
    return;
  }

  listeningDocument?.removeEventListener('keydown', onKeydown, true);
  listeningDocument = document;
  listeningDocument.addEventListener('keydown', onKeydown, true);
}

function removeListenerWhenIdle(): void {
  if (layers.size > 0 || !listeningDocument) {
    return;
  }

  listeningDocument.removeEventListener('keydown', onKeydown, true);
  listeningDocument = null;
}

function notify(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

export function refreshLayerStack(): void {
  notify();
}

export function subscribeLayerStack(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

/**
 * Диагностика для журнала окна: вид слоя и номер, локальный для документа.
 * Строковый id регистрации и DOM-элементы наружу не отдаются.
 */
export function getUiLayerDiagnostics(): { id: number; kind: UiLayerName }[] {
  return enabledLayers()
    .filter((layer) => layer.name !== 'tooltip')
    .map((layer) => ({ id: layer.sequence, kind: layer.name }));
}

export const subscribeUiLayerDiagnostics = subscribeLayerStack;

export function activeLayerId(): string | null {
  return topLayer()?.id ?? null;
}

/**
 * Возвращаем узел верхнего слоя для безопасного замера.
 * Ошибка пользовательского getter не ломает работу оболочки.
 */
export function activeLayerElement(): HTMLElement | null {
  const element = topLayer()?.element;

  if (!element) {
    return null;
  }

  try {
    return element();
  } catch {
    return null;
  }
}

/**
 * Подсказка получает Escape первой, но не меняет владельца фокуса.
 * Верхний интерактивный слой сохраняет замыкание Tab и обработку фона.
 */
export function isTopLayerToken(token: symbol): boolean {
  const top = enabledLayers()
    .filter((layer) => layer.name !== 'tooltip')
    .sort((left, right) => right.priority - left.priority || right.sequence - left.sequence)[0];

  return top?.token === token;
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
      if (!registered) {
        return;
      }

      registered = false;
      layers.delete(token);
      notify();
      removeListenerWhenIdle();
    },
  };

  return handle;
}

/** Только для изолированных component-тестов, не входит в public facade. */
export function resetLayerStackForTests(): void {
  layers.clear();
  listeners.clear();
  sequence = 0;
  removeListenerWhenIdle();
}
