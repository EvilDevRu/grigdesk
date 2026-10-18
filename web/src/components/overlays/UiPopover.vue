<template>
  <PopoverTrigger
    v-if="slots.trigger"
    :attributes="triggerAttributes"
    @element="setTriggerElement"
  >
    <slot name="trigger" v-bind="triggerSlotProps" />
  </PopoverTrigger>
  <UiButton
    v-else
    ref="fallbackTrigger"
    class="ui-popover__fallback-trigger"
    variant="ghost"
    :aria-expanded="isOpen"
    :aria-controls="surfaceId"
    :aria-haspopup="popupRole"
    @pointerdown="onTriggerPointerdown"
    @mouseenter="onTriggerMouseEnter"
    @mouseleave="onTriggerMouseLeave"
    @focus="onTriggerFocus"
    @click="onTriggerClick"
  >
    {{ triggerLabel }}
  </UiButton>

  <Teleport to="body">
    <Transition name="ui-popover">
      <div
        v-if="isOpen"
        v-bind="surfaceAttrs"
        :id="surfaceId"
        ref="surfaceElement"
        :class="['ui-popover', attrs.class]"
        :role="popupRole"
        :aria-modal="popupRole === 'dialog' ? 'false' : undefined"
        tabindex="-1"
        data-state="open"
        :data-placement="actualPlacement"
        :data-ui-layer="layerProps['data-ui-layer']"
        :style="surfaceStyle"
        @keydown="onSurfaceKeydown"
        @mouseenter="onSurfaceMouseEnter"
        @mouseleave="onSurfaceMouseLeave"
      >
        <slot v-bind="contentSlotProps" />
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import {
  Comment,
  Fragment,
  Text,
  cloneVNode,
  computed,
  defineComponent,
  nextTick,
  onBeforeUnmount,
  ref,
  useAttrs,
  useId,
  watch,
  type PropType,
  type VNode,
} from 'vue';
import UiButton from '../primitives/UiButton.vue';
import { useUiLayer } from '../../composables/useUiLayer';
import { normalizeUiLayerName } from '../../services/layers/priorities';
import type { UiLayerName } from '../../types/uiLayers';
import type {
  UiOverlayContentSlotProps,
  UiOverlayPlacement,
  UiOverlayTriggerSlotProps,
  UiPopoverCloseReason,
  UiPopoverFocusPolicy,
  UiPopoverHasPopup,
  UiPopoverSlots,
  UiPopoverTriggerMode,
} from '../../types/uiOverlays';

defineOptions({ inheritAttrs: false });

type TriggerElement = HTMLElement | SVGElement;
type OpenModality = 'keyboard' | 'pointer' | 'programmatic';

interface Props {
  open?: boolean;
  defaultOpen?: boolean;
  hasPopup?: UiPopoverHasPopup;
  focusPolicy?: UiPopoverFocusPolicy;
  triggerMode?: UiPopoverTriggerMode;
  placement?: UiOverlayPlacement;
  layer?: UiLayerName;
  triggerLabel?: string;
  offset?: number;
  hoverDelay?: number;
  returnFocus?: boolean;
  attachment?: 'topbar';
}

const props = withDefaults(defineProps<Props>(), {
  open: undefined,
  defaultOpen: false,
  hasPopup: 'dialog',
  focusPolicy: 'auto',
  triggerMode: 'click',
  placement: 'bottom-start',
  layer: 'popover',
  triggerLabel: 'Открыть',
  offset: 8,
  hoverDelay: 120,
  returnFocus: true,
});
const emit = defineEmits<{
  'update:open': [value: boolean];
  open: [];
  close: [reason: UiPopoverCloseReason];
}>();
const slots = defineSlots<UiPopoverSlots>();
const attrs = useAttrs();

const VALID_PLACEMENTS = new Set<UiOverlayPlacement>([
  'top',
  'top-start',
  'top-end',
  'right',
  'right-start',
  'right-end',
  'bottom',
  'bottom-start',
  'bottom-end',
  'left',
  'left-start',
  'left-end',
]);
const VALID_POPUPS = new Set<UiPopoverHasPopup>(['dialog', 'menu', 'listbox']);
const VALID_FOCUS_POLICIES = new Set<UiPopoverFocusPolicy>([
  'auto',
  'surface',
  'none',
]);
const VALID_TRIGGER_MODES = new Set<UiPopoverTriggerMode>([
  'click',
  'hover',
  'both',
]);

const requestedPlacement = computed<UiOverlayPlacement>(() =>
  VALID_PLACEMENTS.has(props.placement) ? props.placement : 'bottom-start',
);
const popupRole = computed<UiPopoverHasPopup>(() =>
  VALID_POPUPS.has(props.hasPopup) ? props.hasPopup : 'dialog',
);
const normalizedFocusPolicy = computed<UiPopoverFocusPolicy>(() =>
  VALID_FOCUS_POLICIES.has(props.focusPolicy) ? props.focusPolicy : 'auto',
);
const normalizedTriggerMode = computed<UiPopoverTriggerMode>(() =>
  VALID_TRIGGER_MODES.has(props.triggerMode) ? props.triggerMode : 'click',
);
const layerName = computed(() => normalizeUiLayerName(props.layer, 'popover'));

/**
 * Vue slot может начинаться с комментариев, пробелов или вложенного Fragment.
 * Ищем первый реальный VNode, чтобы навесить trigger attrs именно на него.
 */
function firstRenderable(nodes: VNode[]): VNode | null {
  for (const node of nodes) {
    if (node.type === Comment) {
      continue;
    }
    if (node.type === Text && String(node.children ?? '').trim() === '') {
      continue;
    }
    if (node.type === Fragment && Array.isArray(node.children)) {
      const nested = firstRenderable(node.children as VNode[]);

      if (nested) {
        return nested;
      }

      continue;
    }

    return node;
  }

  return null;
}

/**
 * Ref клонированного VNode может вернуть DOM-узел, Vue ref или public instance.
 * Последовательно разворачиваем известные оболочки до HTML/SVG trigger-а.
 */
function resolveElement(value: unknown): TriggerElement | null {
  if (typeof Element !== 'undefined' && value instanceof Element) {
    return value instanceof HTMLElement || value instanceof SVGElement
      ? value
      : null;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as {
    element?: unknown;
    value?: unknown;
    $el?: unknown;
  };

  return resolveElement(
    candidate.element ?? candidate.value ?? candidate.$el ?? null,
  );
}

const PopoverTrigger = defineComponent({
  name: 'UiPopoverTrigger',
  inheritAttrs: false,
  props: {
    attributes: {
      type: Object as PropType<Record<string, unknown>>,
      required: true,
    },
  },
  emits: {
    element: (_element: TriggerElement | null) => true,
  },
  setup(triggerProps, { slots: triggerSlots, emit: triggerEmit }) {
    return () => {
      const child = firstRenderable(triggerSlots.default?.() ?? []);

      if (!child) {
        return null;
      }

      return cloneVNode(
        child,
        {
          ...triggerProps.attributes,
          ref: (value: unknown) =>
            triggerEmit('element', resolveElement(value)),
        },
        true,
      );
    };
  },
});

const surfaceId = `ui-popover-${useId().replaceAll(':', '')}`;
const internalOpen = ref(props.defaultOpen);
const isControlled = computed(() => props.open !== undefined);
const isOpen = computed(() =>
  isControlled.value ? Boolean(props.open) : internalOpen.value,
);
const triggerElement = ref<TriggerElement | null>(null);
const fallbackTrigger = ref<{
  focus?: (options?: FocusOptions) => void;
  element?: HTMLElement | null;
} | null>(null);
const surfaceElement = ref<HTMLElement | null>(null);
const actualPlacement = ref<UiOverlayPlacement>(requestedPlacement.value);
const positionStyle = ref<Record<string, string>>({
  position: 'fixed',
  left: '0px',
  top: '0px',
  visibility: 'hidden',
});
const attachedTriggerStyle = ref<Record<string, string>>({});
let openModality: OpenModality = 'programmatic';
let lastCloseReason: UiPopoverCloseReason = 'programmatic';
let closeRequested = false;
let pinned = false;
let restoringFocus = false;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let resizeObserver: ResizeObserver | null = null;

const surfaceAttrs = computed<Record<string, unknown>>(() => {
  const forwarded: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(attrs)) {
    if (
      ['class', 'style', 'id', 'role', 'tabindex', 'aria-modal'].includes(key)
    ) {
      continue;
    }

    forwarded[key] = value;
  }

  return forwarded;
});

const { isTopLayer, layerProps } = useUiLayer(layerName, {
  enabled: isOpen,
  element: surfaceElement,
  onEscape: () => {
    if (!isOpen.value) {
      return false;
    }

    requestOpen(false, 'escape');

    return true;
  },
});
const surfaceStyle = computed(() => [
  layerProps.value.style,
  positionStyle.value,
  attrs.style,
]);

const triggerSlotProps: UiOverlayTriggerSlotProps = {
  get open() {
    return isOpen.value;
  },
  toggle: () => toggle('programmatic'),
  close: () => requestOpen(false, 'programmatic'),
};
const contentSlotProps: UiOverlayContentSlotProps = {
  get open() {
    return isOpen.value;
  },
  toggle: () => toggle('programmatic'),
  close: (reason = 'action') => requestOpen(false, reason),
};

const triggerAttributes = computed<Record<string, unknown>>(() => ({
  'data-ui-topbar-trigger': props.attachment === 'topbar' ? '' : undefined,
  style: props.attachment === 'topbar' ? attachedTriggerStyle.value : undefined,
  'aria-expanded': String(isOpen.value),
  'aria-controls': surfaceId,
  'aria-haspopup': popupRole.value,
  onPointerdown: onTriggerPointerdown,
  onMouseenter: onTriggerMouseEnter,
  onMouseleave: onTriggerMouseLeave,
  onFocus: onTriggerFocus,
  onClick: onTriggerClick,
  onKeydown: onTriggerKeydown,
}));

function setTriggerElement(value: unknown): void {
  triggerElement.value = resolveElement(value);
}

function currentTrigger(): HTMLElement | SVGElement | null {
  return triggerElement.value ?? fallbackTrigger.value?.element ?? null;
}

/**
 * Controlled popover только сообщает новое состояние, uncontrolled меняет local ref.
 * Модальность открытия и причина закрытия сохраняются для фокуса и финального emit.
 */
function requestOpen(
  value: boolean,
  reason: UiPopoverCloseReason = 'programmatic',
  modality: OpenModality = 'programmatic',
): void {
  if (value === isOpen.value) {
    return;
  }
  if (value) {
    openModality = modality;
    closeRequested = false;

    if (!isControlled.value) {
      internalOpen.value = true;
    }

    emit('update:open', true);
    emit('open');

    return;
  }

  lastCloseReason = reason;
  closeRequested = true;
  pinned = false;

  if (!isControlled.value) {
    internalOpen.value = false;
  }

  emit('update:open', false);
  emit('close', reason);
}

function toggle(modality: OpenModality): void {
  requestOpen(!isOpen.value, 'trigger', modality);
}

function onTriggerPointerdown(event: PointerEvent): void {
  openModality = event.pointerType === 'touch' ? 'pointer' : 'pointer';
}

/**
 * Click в hover-режиме закрепляет уже открытую поверхность вместо её закрытия.
 * Нулевой `detail` помечает keyboard activation для последующего переноса фокуса.
 */
function onTriggerClick(event: MouseEvent): void {
  const modality: OpenModality = event.detail === 0 ? 'keyboard' : openModality;

  if (normalizedTriggerMode.value !== 'click' && isOpen.value && !pinned) {
    pinned = true;

    return;
  }
  if (normalizedTriggerMode.value === 'hover') {
    pinned = true;

    if (!isOpen.value) {
      requestOpen(true, 'trigger', modality);
    }

    return;
  }

  const opening = !isOpen.value;

  toggle(modality);
  pinned = opening;
}

function onTriggerKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' || isOpen.value) {
    return;
  }

  event.preventDefault();
  requestOpen(true, 'trigger', 'keyboard');
}

function usesHover(): boolean {
  return (
    normalizedTriggerMode.value === 'hover' ||
    normalizedTriggerMode.value === 'both'
  );
}

function clearHoverTimer(): void {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
  }

  hoverTimer = null;
}

/**
 * Hover открывает только разрешённые trigger modes и отменяет отложенное закрытие.
 * Повторный enter не создаёт лишний state transition или новый слой.
 */
function onTriggerMouseEnter(): void {
  if (!usesHover()) {
    return;
  }

  clearHoverTimer();

  if (!isOpen.value) {
    requestOpen(true, 'trigger', 'pointer');
  }
}

function onTriggerMouseLeave(): void {
  scheduleHoverClose();
}

function onTriggerFocus(): void {
  if (usesHover() && !isOpen.value && !restoringFocus) {
    requestOpen(true, 'trigger', 'keyboard');
  }
}

function onSurfaceMouseEnter(): void {
  clearHoverTimer();
}

function onSurfaceMouseLeave(): void {
  scheduleHoverClose();
}

function scheduleHoverClose(): void {
  if (!usesHover() || pinned) {
    return;
  }

  clearHoverTimer();
  hoverTimer = setTimeout(
    () => {
      hoverTimer = null;
      requestOpen(false, 'outside');
    },
    Math.max(0, props.hoverDelay),
  );
}

/**
 * Из composite navigation исключаются detached, hidden, inert и CSS-скрытые узлы.
 * При SSR структурной проверки достаточно и обращение к `window` не выполняется.
 */
function isVisibleElement(element: HTMLElement): boolean {
  if (!element.isConnected || element.hidden || element.closest('[inert]')) {
    return false;
  }
  if (typeof window === 'undefined') {
    return true;
  }

  const style = window.getComputedStyle(element);

  return style.display !== 'none' && style.visibility !== 'hidden';
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      [
        'a[href]',
        'button:not([disabled])',
        'input:not([disabled]):not([type="hidden"])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[contenteditable="true"]',
        '[tabindex]:not([tabindex="-1"])',
      ].join(','),
    ),
  ].filter(isVisibleElement);
}

/**
 * Menu и listbox используют разные допустимые роли дочерних элементов.
 * В выборку входят только видимые и доступные items текущей surface.
 */
function compositeItems(): HTMLElement[] {
  const surface = surfaceElement.value;

  if (!surface || popupRole.value === 'dialog') {
    return [];
  }

  const selector =
    popupRole.value === 'menu'
      ? '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'
      : '[role="option"]';

  return [...surface.querySelectorAll<HTMLElement>(selector)].filter(
    (item) =>
      item.getAttribute('aria-disabled') !== 'true' && isVisibleElement(item),
  );
}

/**
 * Перед навигацией восстанавливаем единственный roving `tabindex=0`.
 * Если consumer не назначил активный item, детерминированно выбирается первый.
 */
function prepareCompositeItems(): HTMLElement[] {
  const items = compositeItems();

  if (items.length === 0) {
    return items;
  }

  let activeIndex = items.findIndex((item) => item.tabIndex === 0);

  if (activeIndex < 0) {
    activeIndex = 0;
  }

  items.forEach((item, index) => {
    item.tabIndex = index === activeIndex ? 0 : -1;
  });

  return items;
}

/**
 * Явная focus policy сильнее модальности, auto переносит фокус только с клавиатуры.
 * Для composite выбирается item, для dialog — первый контрол или сама surface.
 */
function focusSurface(): void {
  const surface = surfaceElement.value;

  if (!surface || normalizedFocusPolicy.value === 'none') {
    return;
  }
  if (normalizedFocusPolicy.value === 'surface') {
    surface.focus({ preventScroll: true });

    return;
  }
  if (openModality !== 'keyboard') {
    return;
  }

  const candidates = prepareCompositeItems();
  const target = candidates[0] ?? focusableElements(surface)[0] ?? surface;

  target.focus({ preventScroll: true });
}

/**
 * Возвращать фокус можно только существующему и визуально доступному trigger-у.
 * Исчезнувший или inert trigger оставляется браузеру без искусственного fallback.
 */
function returnFocus(): void {
  if (!props.returnFocus) {
    return;
  }

  const trigger = currentTrigger();

  if (!trigger || !trigger.isConnected || trigger.closest('[inert]')) {
    return;
  }
  if (typeof window !== 'undefined') {
    const style = window.getComputedStyle(trigger);

    if (style.display === 'none' || style.visibility === 'hidden') {
      return;
    }
  }

  restoringFocus = true;
  trigger.focus({ preventScroll: true });
  restoringFocus = false;
}

/**
 * Outside click закрывает только верхний слой и не считает trigger/surface внешними.
 * Capture-фаза фиксирует исходную цель до того, как product handler изменит DOM.
 */
function onDocumentPointerdown(event: PointerEvent): void {
  if (!isTopLayer.value) {
    return;
  }

  const target = event.target;

  if (!(target instanceof Node)) {
    return;
  }
  if (
    currentTrigger()?.contains(target) ||
    surfaceElement.value?.contains(target)
  ) {
    return;
  }

  requestOpen(false, 'outside');
}

/**
 * Стрелки циклически двигают единственный roving tabindex по доступным items.
 * Home/End используют тот же путь, чтобы DOM-фокус и tabindex не расходились.
 */
function moveCompositeFocus(
  event: KeyboardEvent,
  direction: 'next' | 'previous' | 'first' | 'last',
): void {
  const items = prepareCompositeItems();

  if (items.length === 0) {
    return;
  }

  const active =
    event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>('[role]')
      : null;
  let index = active ? items.indexOf(active) : -1;

  if (direction === 'first') {
    index = 0;
  } else if (direction === 'last') {
    index = items.length - 1;
  } else if (direction === 'next') {
    index = (index + 1 + items.length) % items.length;
  } else {
    index = (index - 1 + items.length) % items.length;
  }

  items.forEach((item, itemIndex) => {
    item.tabIndex = itemIndex === index ? 0 : -1;
  });
  items[index]?.focus({ preventScroll: true });
  event.preventDefault();
}

/**
 * Menu/listbox получают общий keyboard map стрелок, Home/End и активации.
 * Dialog не перехватывается: его внутренние контролы сохраняют нативное поведение.
 */
function onSurfaceKeydown(event: KeyboardEvent): void {
  if (popupRole.value === 'dialog') {
    return;
  }
  if (event.key === 'ArrowDown') {
    moveCompositeFocus(event, 'next');
  } else if (event.key === 'ArrowUp') {
    moveCompositeFocus(event, 'previous');
  } else if (event.key === 'Home') {
    moveCompositeFocus(event, 'first');
  } else if (event.key === 'End') {
    moveCompositeFocus(event, 'last');
  } else if (
    (event.key === 'Enter' || event.key === ' ') &&
    event.target instanceof HTMLElement
  ) {
    const item = event.target.closest<HTMLElement>('[role]');

    if (item && compositeItems().includes(item)) {
      event.preventDefault();
      item.click();
    }
  }
}

function axisPlacement(
  placement: UiOverlayPlacement,
): 'top' | 'right' | 'bottom' | 'left' {
  return placement.split('-')[0] as 'top' | 'right' | 'bottom' | 'left';
}

/**
 * Суффиксы start/end выравнивают surface по поперечной оси trigger-а.
 * Placement без суффикса центрируется и одинаково работает для обеих осей.
 */
function alignedCoordinate(
  start: number,
  triggerSize: number,
  surfaceSize: number,
  placement: UiOverlayPlacement,
): number {
  if (placement.endsWith('-start')) {
    return start;
  }
  if (placement.endsWith('-end')) {
    return start + triggerSize - surfaceSize;
  }

  return start + (triggerSize - surfaceSize) / 2;
}

/**
 * Flip меняет только основную сторону и сохраняет start/end-выравнивание.
 * Это позволяет повторно использовать тот же расчёт поперечной координаты.
 */
function flippedPlacement(placement: UiOverlayPlacement): UiOverlayPlacement {
  if (placement.startsWith('top')) {
    return placement.replace('top', 'bottom') as UiOverlayPlacement;
  }
  if (placement.startsWith('bottom')) {
    return placement.replace('bottom', 'top') as UiOverlayPlacement;
  }
  if (placement.startsWith('left')) {
    return placement.replace('left', 'right') as UiOverlayPlacement;
  }

  return placement.replace('right', 'left') as UiOverlayPlacement;
}

/**
 * Клавиатура и масштабирование могут сдвинуть видимую область без resize окна.
 * Координаты остаются в системе layout viewport, как getBoundingClientRect триггера.
 */
function visibleBounds(): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;

  return {
    left,
    top,
    right: left + (viewport?.width || window.innerWidth),
    bottom: top + (viewport?.height || window.innerHeight),
  };
}

/**
 * Плитка сохраняет стык с топбаром и прокручивает длинное содержимое внутри
 * оставшейся видимой области, в том числе при открытой экранной клавиатуре.
 */
function placeTopbarPanel(trigger: TriggerElement, surface: HTMLElement): void {
  const rect = trigger.getBoundingClientRect();
  const bar = trigger.closest('[data-ui-topbar]')?.getBoundingClientRect() ?? rect;
  const bounds = visibleBounds();
  const edge = 8;
  const top = Math.max(bounds.top, bar.bottom - 1);
  const left = Math.max(bounds.left + edge, Math.min(rect.right - surface.offsetWidth,
    bounds.right - surface.offsetWidth - edge));

  attachedTriggerStyle.value = {
    '--ui-topbar-trigger-top': `${bar.top - rect.top}px`,
    '--ui-topbar-trigger-height': `${bar.height}px`,
  };
  actualPlacement.value = 'bottom-end';
  positionStyle.value = {
    position: 'fixed',
    left: `${left}px`,
    top: `${top}px`,
    maxHeight: `${Math.max(0, bounds.bottom - top - edge)}px`,
    maxWidth: `${Math.max(0, bounds.right - bounds.left - edge * 2)}px`,
    visibility: 'visible',
  };
}

/**
 * Surface переворачивается лишь когда противоположная сторона даёт больше места,
 * затем зажимается в viewport и публикует координаты anchor для стрелки.
 */
function place(): void {
  const trigger = currentTrigger();
  const surface = surfaceElement.value;

  if (!trigger || !surface || typeof window === 'undefined') {
    return;
  }

  if (props.attachment === 'topbar') {
    placeTopbarPanel(trigger, surface);

    return;
  }

  const triggerRect = trigger.getBoundingClientRect();
  const bounds = visibleBounds();
  const width = surface.offsetWidth;
  const height = surface.offsetHeight;
  const edge = 8;
  const gap = Math.max(0, props.offset);
  let placement = requestedPlacement.value;
  let axis = axisPlacement(placement);
  const room = {
    top: triggerRect.top - bounds.top - edge,
    right: bounds.right - triggerRect.right - edge,
    bottom: bounds.bottom - triggerRect.bottom - edge,
    left: triggerRect.left - bounds.left - edge,
  };
  const needed =
    axis === 'top' || axis === 'bottom' ? height + gap : width + gap;
  const opposite =
    axis === 'top'
      ? 'bottom'
      : axis === 'bottom'
        ? 'top'
        : axis === 'left'
          ? 'right'
          : 'left';

  if (room[axis] < needed && room[opposite] > room[axis]) {
    placement = flippedPlacement(placement);
    axis = axisPlacement(placement);
  }

  let left = alignedCoordinate(
    triggerRect.left,
    triggerRect.width,
    width,
    placement,
  );
  let top = alignedCoordinate(
    triggerRect.top,
    triggerRect.height,
    height,
    placement,
  );

  if (axis === 'top') {
    top = triggerRect.top - height - gap;
  } else if (axis === 'bottom') {
    top = triggerRect.bottom + gap;
  } else if (axis === 'left') {
    left = triggerRect.left - width - gap;
  } else {
    left = triggerRect.right + gap;
  }

  left = Math.min(
    Math.max(left, bounds.left + edge),
    Math.max(bounds.left + edge, bounds.right - width - edge),
  );
  top = Math.min(
    Math.max(top, bounds.top + edge),
    Math.max(bounds.top + edge, bounds.bottom - height - edge),
  );
  actualPlacement.value = placement;
  positionStyle.value = {
    position: 'fixed',
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    maxHeight: `${Math.max(0, bounds.bottom - bounds.top - edge * 2)}px`,
    maxWidth: `${Math.max(0, bounds.right - bounds.left - edge * 2)}px`,
    visibility: 'visible',
    '--ui-overlay-anchor-x': `${Math.round(triggerRect.left + triggerRect.width / 2 - left)}px`,
    '--ui-overlay-anchor-y': `${Math.round(triggerRect.top + triggerRect.height / 2 - top)}px`,
  };
}

/**
 * Пересчитывает положение при прокрутке и изменении окна без потери привязки к шапке.
 * Скрытый адаптивной раскладкой триггер закрывает свою плитку, чтобы она не зависла в углу.
 */
function onViewportMove(): void {
  const trigger = currentTrigger();

  if (!trigger?.isConnected) {
    requestOpen(false, 'programmatic');

    return;
  }

  if (props.attachment === 'topbar') {
    const bar = trigger.closest('[data-ui-topbar]')?.getBoundingClientRect();

    if (bar?.width && !trigger.getBoundingClientRect().width) {
      requestOpen(false, 'outside');

      return;
    }
  }

  place();
}

watch(
  isOpen,
  async (open, wasOpen) => {
    if (typeof document === 'undefined') {
      return;
    }
    if (open) {
      document.addEventListener('pointerdown', onDocumentPointerdown, true);
      window.addEventListener('scroll', onViewportMove, {
        capture: true,
        passive: true,
      });
      window.addEventListener('resize', onViewportMove, { passive: true });
      window.visualViewport?.addEventListener('resize', onViewportMove, { passive: true });
      window.visualViewport?.addEventListener('scroll', onViewportMove, { passive: true });
      await nextTick();
      place();
      prepareCompositeItems();
      focusSurface();

      if (typeof ResizeObserver !== 'undefined' && surfaceElement.value) {
        resizeObserver = new ResizeObserver(place);
        resizeObserver.observe(surfaceElement.value);

        if (props.attachment === 'topbar') {
          const trigger = currentTrigger();
          const bar = trigger?.closest('[data-ui-topbar]');

          if (trigger) {
            resizeObserver.observe(trigger);
          }

          // Новая иконка меняет ширину группы и сдвигает соседей, хотя размеры самой
          // кнопки прежние. Наблюдаем её контейнеры вплоть до полосы топбара.
          for (let parent = trigger?.parentElement; bar && parent; parent = parent.parentElement) {
            resizeObserver.observe(parent);

            if (parent === bar) {
              break;
            }
          }
        }
      }

      return;
    }

    document.removeEventListener('pointerdown', onDocumentPointerdown, true);
    window.removeEventListener('scroll', onViewportMove, true);
    window.removeEventListener('resize', onViewportMove);
    window.visualViewport?.removeEventListener('resize', onViewportMove);
    window.visualViewport?.removeEventListener('scroll', onViewportMove);
    resizeObserver?.disconnect();
    resizeObserver = null;
    clearHoverTimer();

    if (wasOpen) {
      if (!closeRequested) {
        lastCloseReason = 'programmatic';
        emit('close', 'programmatic');
      }

      closeRequested = false;

      if (lastCloseReason !== 'outside' && lastCloseReason !== 'trigger') {
        await nextTick(returnFocus);
      }
    }
  },
  { flush: 'post' },
);

onBeforeUnmount(() => {
  clearHoverTimer();

  if (typeof document !== 'undefined') {
    document.removeEventListener('pointerdown', onDocumentPointerdown, true);
    window.removeEventListener('scroll', onViewportMove, true);
    window.removeEventListener('resize', onViewportMove);
    window.visualViewport?.removeEventListener('resize', onViewportMove);
    window.visualViewport?.removeEventListener('scroll', onViewportMove);
  }

  resizeObserver?.disconnect();
});

defineExpose({
  open: () => requestOpen(true, 'programmatic'),
  close: (reason: UiPopoverCloseReason = 'programmatic') =>
    requestOpen(false, reason),
  toggle: () => toggle('programmatic'),
  focus: focusSurface,
  triggerElement,
  surfaceElement,
  isTopLayer,
});
</script>
