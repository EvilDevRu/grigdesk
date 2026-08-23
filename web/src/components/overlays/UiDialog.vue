<template>
  <Teleport to="body">
    <Transition :name="fadeOnly ? 'ui-dialog-fade' : 'ui-dialog'">
      <div
        v-if="open"
        ref="overlayElement"
        class="ui-dialog-overlay"
        data-ui-modal-root=""
        :data-size="normalizedSize"
        :data-mobile-fullscreen="mobileFullscreen ? '' : undefined"
        :data-fade-only="fadeOnly ? '' : undefined"
        :data-busy="busy ? '' : undefined"
        :data-ui-layer="layerProps['data-ui-layer']"
        :style="layerProps.style"
        @click.self="onBackdropClick"
      >
        <section
          v-bind="surfaceAttrs"
          ref="surfaceElement"
          :class="['ui-dialog', attrs.class]"
          :style="attrs.style"
          :role="normalizedRole"
          aria-modal="true"
          :aria-label="hasTitle ? undefined : label"
          :aria-labelledby="hasTitle ? titleId : undefined"
          :aria-describedby="hasDescription ? descriptionId : undefined"
          :aria-busy="busy || undefined"
          tabindex="-1"
          @keydown="onSurfaceKeydown"
        >
          <header v-if="hasTitle || slots.header" class="ui-dialog__header">
            <slot name="header" v-bind="dialogSlotProps">
              <div v-if="hasTitle" :id="titleId" class="ui-dialog__title">
                <slot name="title">{{ title }}</slot>
              </div>
            </slot>
          </header>

          <div
            v-if="hasDescription"
            :id="descriptionId"
            class="ui-dialog__description"
          >
            <slot name="description">{{ description }}</slot>
          </div>

          <div class="ui-dialog__body">
            <slot v-bind="dialogSlotProps" />
          </div>

          <footer v-if="slots.footer" class="ui-dialog__footer">
            <slot name="footer" v-bind="dialogSlotProps" />
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  useAttrs,
  useId,
  watch,
  type VNode,
} from 'vue';
import { useUiLayer } from '../../composables/useUiLayer';
import {
  activeModalElement,
  registerModalEnvironment,
  subscribeModalEnvironment,
  type ModalEnvironmentHandle,
} from '../../services/layers/modalEnvironment';
import {
  normalizeUiLayerName,
  uiLayerPriority,
} from '../../services/layers/priorities';
import type { UiLayerName } from '../../types/uiLayers';
import type {
  UiDialogCloseReason,
  UiDialogRole,
  UiDialogSize,
  UiFocusTarget,
  UiInitialFocus,
} from '../../types/uiOverlays';

defineOptions({ inheritAttrs: false });

interface Props {
  open: boolean;
  role?: UiDialogRole;
  layer?: UiLayerName;
  size?: UiDialogSize;
  title?: string;
  description?: string;
  label?: string;
  dismissible?: boolean;
  persistent?: boolean;
  busy?: boolean;
  initialFocus?: UiInitialFocus;
  returnFocus?: boolean | UiInitialFocus;
  mobileFullscreen?: boolean;
  fadeOnly?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  role: 'dialog',
  layer: 'dialog',
  size: 'content',
  title: '',
  description: '',
  label: 'Диалог',
  dismissible: true,
  persistent: false,
  busy: false,
  initialFocus: undefined,
  returnFocus: true,
  mobileFullscreen: true,
  fadeOnly: false,
});
const emit = defineEmits<{
  'update:open': [value: boolean];
  close: [reason: UiDialogCloseReason];
}>();
const slots = defineSlots<{
  header?(props: DialogSlotProps): VNode[];
  title?(): VNode[];
  description?(): VNode[];
  default(props: DialogSlotProps): VNode[];
  footer?(props: DialogSlotProps): VNode[];
}>();
const attrs = useAttrs();

interface DialogSlotProps {
  close(reason?: UiDialogCloseReason): void;
  busy: boolean;
  persistent: boolean;
  isTop: boolean;
}

const VALID_ROLES = new Set<UiDialogRole>(['dialog', 'alertdialog']);
const VALID_SIZES = new Set<UiDialogSize>(['compact', 'content', 'workspace']);
const normalizedRole = computed<UiDialogRole>(() =>
  VALID_ROLES.has(props.role) ? props.role : 'dialog',
);
const normalizedSize = computed<UiDialogSize>(() =>
  VALID_SIZES.has(props.size) ? props.size : 'content',
);
const layerName = computed(() => normalizeUiLayerName(props.layer, 'dialog'));
const canDismiss = computed(() => props.dismissible && !props.persistent);
const hasTitle = computed(() => Boolean(props.title || slots.title));
const hasDescription = computed(() =>
  Boolean(props.description || slots.description),
);
const baseId = useId().replaceAll(':', '');
const titleId = `ui-dialog-title-${baseId}`;
const descriptionId = `ui-dialog-description-${baseId}`;
const overlayElement = ref<HTMLElement | null>(null);
const surfaceElement = ref<HTMLElement | null>(null);
const modalIsTop = ref(false);
let modalHandle: ModalEnvironmentHandle | null = null;
let returnTarget: HTMLElement | null = null;
let requestedCloseReason: UiDialogCloseReason | null = null;

const surfaceAttrs = computed<Record<string, unknown>>(() => {
  const forwarded: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(attrs)) {
    if (
      [
        'class',
        'style',
        'role',
        'tabindex',
        'aria-modal',
        'aria-label',
        'aria-labelledby',
        'aria-describedby',
        'aria-busy',
      ].includes(key)
    ) {
      continue;
    }

    forwarded[key] = value;
  }

  return forwarded;
});

const { isTopLayer, layerProps } = useUiLayer(layerName, {
  enabled: computed(() => props.open),
  element: overlayElement,
  onEscape: () => {
    // Persistent верхний слой всё равно владеет Escape и не пропускает его вниз.
    if (!canDismiss.value || !modalIsTop.value) {
      return true;
    }

    requestClose('escape');

    return true;
  },
});

const dialogSlotProps: DialogSlotProps = {
  close: (reason = 'action') => requestClose(reason),
  get busy() {
    return props.busy;
  },
  get persistent() {
    return props.persistent;
  },
  get isTop() {
    return modalIsTop.value && isTopLayer.value;
  },
};

function syncModalTop(): void {
  modalIsTop.value = Boolean(modalHandle?.isTop());
}

const unsubscribeModal = subscribeModalEnvironment(syncModalTop);

/**
 * Причина сохраняется до смены модели, чтобы watcher не сообщил закрытие повторно
 * как программное. Persistent запрещает только внешнее закрытие, но не action.
 */
function requestClose(reason: UiDialogCloseReason): void {
  if (!props.open) {
    return;
  }
  if ((reason === 'escape' || reason === 'backdrop') && !canDismiss.value) {
    return;
  }

  requestedCloseReason = reason;
  emit('update:open', false);
  emit('close', reason);
}

function onBackdropClick(): void {
  if (!modalIsTop.value || !isTopLayer.value) {
    return;
  }

  requestClose('backdrop');
}

/**
 * Структурно скрытые и inert-узлы сразу исключаются из focus order.
 * В браузере дополнительно учитываются CSS-состояния, а SSR не требует `window`.
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
 * Public focus target может быть selector, ref, component handle или фабрикой.
 * Ограничение глубины защищает диалог от циклических цепочек пользовательских refs.
 */
function resolveFocusTarget(
  target: UiFocusTarget | UiInitialFocus | undefined,
  depth = 0,
): UiFocusTarget {
  if (target === undefined || target === null || depth > 6) {
    return null;
  }
  if (typeof target === 'function') {
    return resolveFocusTarget(target(), depth + 1);
  }
  if (typeof target === 'string') {
    try {
      return surfaceElement.value?.querySelector<HTMLElement>(target) ?? null;
    } catch {
      return null;
    }
  }
  if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement) {
    return target;
  }
  if (typeof target !== 'object') {
    return null;
  }

  const candidate = target as {
    value?: unknown;
    element?: unknown;
    $el?: unknown;
    focus?: (options?: FocusOptions) => void;
  };

  if (candidate.value !== undefined) {
    return resolveFocusTarget(candidate.value as UiFocusTarget, depth + 1);
  }
  if (candidate.element !== undefined) {
    const resolved = resolveFocusTarget(
      candidate.element as UiFocusTarget,
      depth + 1,
    );

    if (resolved) {
      return resolved;
    }
  }
  if (candidate.$el !== undefined) {
    const resolved = resolveFocusTarget(
      candidate.$el as UiFocusTarget,
      depth + 1,
    );

    if (resolved) {
      return resolved;
    }
  }

  return typeof candidate.focus === 'function'
    ? (candidate as UiFocusTarget)
    : null;
}

/**
 * Компонентные handles намеренно проверяются duck typing, а не через HTMLElement.
 * Отсоединённый target не фокусируется и позволяет перейти к следующему fallback.
 */
function focusResolved(target: UiFocusTarget): boolean {
  if (!target || typeof target === 'string' || typeof target === 'function') {
    return false;
  }

  const focusable = target as {
    focus?: (options?: FocusOptions) => void;
    isConnected?: boolean;
  };

  if (
    focusable.isConnected === false ||
    typeof focusable.focus !== 'function'
  ) {
    return false;
  }

  focusable.focus({ preventScroll: true });

  return true;
}

/**
 * Начальный фокус принадлежит только верхнему modal и верхнему UI-слою.
 * После explicit target выбирается первый доступный контрол либо сама surface.
 */
function focusInitial(): void {
  if (!props.open || !modalIsTop.value || !isTopLayer.value) {
    return;
  }

  const surface = surfaceElement.value;

  if (!surface) {
    return;
  }

  const explicit = resolveFocusTarget(props.initialFocus);

  if (focusResolved(explicit)) {
    return;
  }

  const target = focusableElements(surface)[0] ?? surface;

  target.focus({ preventScroll: true });
}

/**
 * Focus trap не должен отнимать ввод у popover или другого вложенного слоя.
 * Владение определяется общей приоритетной шкалой, а не DOM-вложенностью.
 */
function upperLayerOwnsTarget(target: HTMLElement): boolean {
  const layerRoot = target.closest<HTMLElement>('[data-ui-layer]');

  if (!layerRoot || layerRoot === overlayElement.value) {
    return false;
  }

  const name = normalizeUiLayerName(layerRoot.dataset.uiLayer, 'tools');

  return uiLayerPriority(name) > uiLayerPriority(layerName.value);
}

/**
 * Уход фокуса наружу возвращает его в modal, кроме перехода в верхний слой.
 * Возврат ставится в microtask, чтобы не спорить с текущим browser focus event.
 */
function onDocumentFocusin(event: FocusEvent): void {
  if (!props.open || !modalIsTop.value || !isTopLayer.value) {
    return;
  }

  const surface = surfaceElement.value;
  const target = event.target;

  if (!surface || !(target instanceof HTMLElement)) {
    return;
  }
  if (surface.contains(target) || upperLayerOwnsTarget(target)) {
    return;
  }

  queueMicrotask(focusInitial);
}

/**
 * Tab и Shift+Tab замыкаются только на краях списка доступных элементов.
 * Если контролов нет, surface остаётся единственной безопасной точкой фокуса.
 */
function onSurfaceKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || !modalIsTop.value || !isTopLayer.value) {
    return;
  }

  const surface = surfaceElement.value;

  if (!surface) {
    return;
  }

  const candidates = focusableElements(surface);

  if (candidates.length === 0) {
    event.preventDefault();
    surface.focus({ preventScroll: true });

    return;
  }

  const first = candidates[0];
  const last = candidates[candidates.length - 1];
  const active = surface.ownerDocument.activeElement;

  if (
    event.shiftKey &&
    (active === first || active === surface || !surface.contains(active))
  ) {
    event.preventDefault();
    last?.focus({ preventScroll: true });
  } else if (
    !event.shiftKey &&
    (active === last || !active || !surface.contains(active))
  ) {
    event.preventDefault();
    first?.focus({ preventScroll: true });
  }
}

/**
 * Очистка идемпотентно снимает регистрацию modal и глобальный focus listener.
 * Это один путь и для обычного закрытия, и для размонтирования компонента.
 */
function cleanupModal(): void {
  modalHandle?.unregister();
  modalHandle = null;
  modalIsTop.value = false;

  if (typeof document !== 'undefined') {
    document.removeEventListener('focusin', onDocumentFocusin, true);
  }
}

/**
 * Возврат идёт по цепочке: explicit target, исходный элемент, нижний modal.
 * Так удалённый trigger не оставляет stacked dialogs без активного фокуса.
 */
function focusReturnTarget(): void {
  if (props.returnFocus === false) {
    return;
  }

  const explicit =
    props.returnFocus === true ? null : resolveFocusTarget(props.returnFocus);

  if (explicit && focusResolved(explicit)) {
    return;
  }
  if (
    returnTarget &&
    isVisibleElement(returnTarget) &&
    focusResolved(returnTarget)
  ) {
    return;
  }

  // Если trigger исчез, stacked modal всё равно вновь получает ввод.
  const lowerModal = activeModalElement();

  if (!lowerModal || !lowerModal.isConnected) {
    return;
  }

  const lowerSurface =
    lowerModal.querySelector<HTMLElement>('.ui-dialog') ?? lowerModal;
  const fallback = focusableElements(lowerSurface)[0] ?? lowerSurface;

  fallback.focus({ preventScroll: true });
}

watch(
  () => props.open,
  async (open, wasOpen) => {
    if (open) {
      if (typeof document !== 'undefined') {
        returnTarget =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
      }

      await nextTick();

      if (!props.open || !overlayElement.value) {
        return;
      }

      modalHandle = registerModalEnvironment(
        overlayElement.value,
        layerName.value,
      );
      syncModalTop();
      document.addEventListener('focusin', onDocumentFocusin, true);
      await nextTick();
      focusInitial();

      return;
    }

    if (!wasOpen) {
      return;
    }

    cleanupModal();

    if (requestedCloseReason === null) {
      emit('close', 'programmatic');
    }

    requestedCloseReason = null;
    await nextTick();
    focusReturnTarget();
    returnTarget = null;
  },
  { immediate: true, flush: 'post' },
);

watch(layerName, async () => {
  if (!props.open) {
    return;
  }

  modalHandle?.unregister();
  modalHandle = null;
  await nextTick();

  if (props.open && overlayElement.value) {
    modalHandle = registerModalEnvironment(
      overlayElement.value,
      layerName.value,
    );
    syncModalTop();
  }
});

onBeforeUnmount(() => {
  const shouldReturnFocus = props.open;

  cleanupModal();
  unsubscribeModal();

  if (shouldReturnFocus) {
    focusReturnTarget();
  }
});

defineExpose({
  close: (reason: UiDialogCloseReason = 'programmatic') => requestClose(reason),
  focus: focusInitial,
  overlayElement,
  surfaceElement,
  isTopLayer,
  isTopModal: modalIsTop,
});
</script>
