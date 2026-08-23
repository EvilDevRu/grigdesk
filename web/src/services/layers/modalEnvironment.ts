import type { UiLayerName } from '../../types/uiLayers';
import { isUiLayerName, uiLayerPriority } from './priorities';

interface ModalEntry {
  token: symbol;
  root: HTMLElement;
  priority: number;
  sequence: number;
}

interface SavedElementState {
  inert: boolean;
  ariaHidden: string | null;
}

export interface ModalEnvironmentHandle {
  readonly token: symbol;
  readonly root: HTMLElement;
  isTop(): boolean;
  refresh(): void;
  unregister(): void;
}

const modals = new Map<symbol, ModalEntry>();
const forcedElements = new Map<HTMLElement, SavedElementState>();
const listeners = new Set<() => void>();
let sequence = 0;
let observer: MutationObserver | null = null;
let observedBody: HTMLElement | null = null;
let refreshQueued = false;

let savedBodyOverflow = '';
let savedBodyPaddingRight = '';
let bodyHadLockClass = false;

function connectedEntries(): ModalEntry[] {
  return [...modals.values()]
    .filter((entry) => entry.root.isConnected)
    .sort((left, right) => right.priority - left.priority || right.sequence - left.sequence);
}

function topEntry(): ModalEntry | null {
  return connectedEntries()[0] ?? null;
}

function readLayerName(element: HTMLElement): UiLayerName | null {
  const value = element.dataset.uiLayer;
  return isUiLayerName(value) ? value : null;
}

function layerPriority(element: HTMLElement): number | null {
  const name = readLayerName(element);
  return name ? uiLayerPriority(name) : null;
}

function saveAndForce(element: HTMLElement): void {
  if (!forcedElements.has(element)) {
    forcedElements.set(element, {
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    });
  }
  element.inert = true;
  element.setAttribute('aria-hidden', 'true');
}

function restoreElement(element: HTMLElement): void {
  const saved = forcedElements.get(element);
  if (!saved) return;
  element.inert = saved.inert;
  if (saved.ariaHidden === null) element.removeAttribute('aria-hidden');
  else element.setAttribute('aria-hidden', saved.ariaHidden);
  forcedElements.delete(element);
}

function desiredInertElements(top: ModalEntry): Set<HTMLElement> {
  const desired = new Set<HTMLElement>();
  const entries = connectedEntries();

  for (const entry of entries) {
    if (entry.token !== top.token) desired.add(entry.root);
  }

  const body = top.root.ownerDocument.body;
  for (const child of [...body.children]) {
    if (!(child instanceof HTMLElement)) continue;
    if (child === top.root) continue;
    if (entries.some((entry) => entry.root === child)) continue;

    // Teleported tooltip/popover верхнего семантического уровня остаётся доступным.
    const priority = layerPriority(child);
    if (priority !== null && priority > top.priority) continue;
    desired.add(child);
  }
  return desired;
}

function lockBody(body: HTMLElement): void {
  if (observedBody === body) return;
  unlockBody();
  observedBody = body;
  savedBodyOverflow = body.style.overflow;
  savedBodyPaddingRight = body.style.paddingRight;
  bodyHadLockClass = body.classList.contains('ui-modal-scroll-lock');

  const view = body.ownerDocument.defaultView;
  const scrollbarWidth = view
    ? Math.max(0, view.innerWidth - body.ownerDocument.documentElement.clientWidth)
    : 0;
  if (scrollbarWidth > 0 && view) {
    const currentPadding = Number.parseFloat(view.getComputedStyle(body).paddingRight) || 0;
    body.style.paddingRight = `${currentPadding + scrollbarWidth}px`;
  }
  body.style.overflow = 'hidden';
  body.classList.add('ui-modal-scroll-lock');

  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => scheduleRefresh());
    observer.observe(body, { childList: true });
  }
}

function unlockBody(): void {
  observer?.disconnect();
  observer = null;
  if (!observedBody) return;
  observedBody.style.overflow = savedBodyOverflow;
  observedBody.style.paddingRight = savedBodyPaddingRight;
  if (!bodyHadLockClass) observedBody.classList.remove('ui-modal-scroll-lock');
  observedBody = null;
}

function scheduleRefresh(): void {
  if (refreshQueued) return;
  refreshQueued = true;
  queueMicrotask(() => {
    refreshQueued = false;
    refreshModalEnvironment();
  });
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function refreshModalEnvironment(): void {
  const top = topEntry();
  if (!top) {
    for (const element of [...forcedElements.keys()]) restoreElement(element);
    unlockBody();
    notify();
    return;
  }

  lockBody(top.root.ownerDocument.body);
  const desired = desiredInertElements(top);
  for (const element of [...forcedElements.keys()]) {
    if (!desired.has(element)) restoreElement(element);
  }
  for (const element of desired) saveAndForce(element);
  notify();
}

export function subscribeModalEnvironment(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isTopModal(token: symbol): boolean {
  return topEntry()?.token === token;
}

export function activeModalElement(): HTMLElement | null {
  return topEntry()?.root ?? null;
}

export function registerModalEnvironment(
  root: HTMLElement,
  layer: UiLayerName = 'dialog',
): ModalEnvironmentHandle {
  const token = Symbol(`modal-${layer}`);
  const entry: ModalEntry = {
    token,
    root,
    priority: uiLayerPriority(layer),
    sequence: ++sequence,
  };
  modals.set(token, entry);
  refreshModalEnvironment();

  let registered = true;
  return {
    token,
    root,
    isTop: () => registered && isTopModal(token),
    refresh: refreshModalEnvironment,
    unregister: () => {
      if (!registered) return;
      registered = false;
      restoreElement(root);
      modals.delete(token);
      refreshModalEnvironment();
    },
  };
}

/** Только для изолированных component-тестов, не входит в public facade. */
export function resetModalEnvironmentForTests(): void {
  modals.clear();
  for (const element of [...forcedElements.keys()]) restoreElement(element);
  sequence = 0;
  unlockBody();
  notify();
}
