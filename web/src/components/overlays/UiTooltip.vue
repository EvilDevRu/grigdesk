<template>
  <span
    v-if="disabledTrigger"
    ref="setTriggerElement"
    class="ui-tooltip__disabled-trigger"
    role="group"
    tabindex="0"
    :aria-label="disabledLabel || text || 'Подсказка'"
    :aria-describedby="tooltipId"
    @mouseenter="onMouseEnter"
    @mouseleave="onMouseLeave"
    @focusin="onFocus"
    @focusout="onFocusOut"
  >
    <slot v-if="slots.trigger" name="trigger" v-bind="triggerSlotProps" />
    <slot v-else v-bind="triggerSlotProps" />
  </span>

  <TooltipTrigger
    v-else-if="hasTrigger"
    :attributes="triggerAttributes"
    @element="setTriggerElement"
  >
    <slot v-if="slots.trigger" name="trigger" v-bind="triggerSlotProps" />
    <slot v-else v-bind="triggerSlotProps" />
  </TooltipTrigger>

  <span
    v-else
    ref="setTriggerElement"
    class="ui-tooltip__fallback-trigger"
    tabindex="0"
    aria-label="Подсказка"
    :aria-describedby="tooltipId"
    @mouseenter="onMouseEnter"
    @mouseleave="onMouseLeave"
    @focusin="onFocus"
    @focusout="onFocusOut"
    >?</span
  >

  <Teleport to="body">
    <Transition name="ui-tooltip">
      <span
        v-if="visible"
        :id="tooltipId"
        ref="tooltipElement"
        :class="['ui-tooltip', surfaceClass]"
        role="tooltip"
        data-state="open"
        :data-placement="actualPlacement"
        :data-ui-layer="layerProps['data-ui-layer']"
        :style="resolvedSurfaceStyle"
      >
        <slot v-if="slots.tip" name="tip" />
        <slot v-else-if="slots.content" name="content" />
        <slot v-else-if="slots.trigger" v-bind="triggerSlotProps" />
        <template v-else>{{ text }}</template>
      </span>
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
  h,
  nextTick,
  onBeforeUnmount,
  ref,
  useId,
  watch,
  type CSSProperties,
  type PropType,
  type VNode,
} from 'vue';
import { useUiLayer } from '../../composables/useUiLayer';
import type {
  UiOverlayPlacement,
  UiOverlayTriggerSlotProps,
  UiTooltipSlots,
} from '../../types/uiOverlays';

type TriggerElement = HTMLElement | SVGElement;

interface Props {
  text?: string;
  placement?: UiOverlayPlacement;
  disabledTrigger?: boolean;
  disabledLabel?: string;
  offset?: number;
  showDelay?: number;
  hideDelay?: number;
  surfaceClass?: string | readonly string[] | Record<string, boolean>;
  surfaceStyle?: CSSProperties | CSSProperties[];
}

const props = withDefaults(defineProps<Props>(), {
  text: '',
  placement: 'top',
  disabledTrigger: false,
  disabledLabel: '',
  offset: 9,
  showDelay: 0,
  hideDelay: 80,
  surfaceClass: '',
  surfaceStyle: undefined,
});
const slots = defineSlots<UiTooltipSlots>();

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
const requestedPlacement = computed<UiOverlayPlacement>(() =>
  VALID_PLACEMENTS.has(props.placement) ? props.placement : 'top',
);

/**
 * Vue slot может содержать служебные комментарии, пробелы и вложенные Fragment.
 * Атрибуты tooltip должны попасть на первый реальный VNode, а не на обёртку.
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
 * Ref клонированного trigger-а бывает DOM-узлом, Vue ref или public instance.
 * Разворачиваем известные оболочки до фокусируемого HTML/SVG-элемента.
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

const TooltipTrigger = defineComponent({
  name: 'UiTooltipTrigger',
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
  setup(triggerProps, { slots: triggerSlots, emit }) {
    return () => {
      const child = firstRenderable(triggerSlots.default?.() ?? []);

      if (!child) {
        return h('span');
      }

      const previousDescription = child.props?.['aria-describedby'];
      const nextDescription = triggerProps.attributes['aria-describedby'];
      const describedBy =
        [previousDescription, nextDescription]
          .filter((value) => typeof value === 'string' && value.trim())
          .join(' ') || undefined;

      return cloneVNode(
        child,
        {
          ...triggerProps.attributes,
          'aria-describedby': describedBy,
          ref: (value: unknown) => emit('element', resolveElement(value)),
        },
        true,
      );
    };
  },
});

const tooltipId = `ui-tooltip-${useId().replaceAll(':', '')}`;
const triggerElement = ref<TriggerElement | null>(null);
const tooltipElement = ref<HTMLElement | null>(null);
const visible = ref(false);
const hovered = ref(false);
const focused = ref(false);
const actualPlacement = ref<UiOverlayPlacement>(requestedPlacement.value);
const positionStyle = ref<Record<string, string>>({
  position: 'fixed',
  left: '0px',
  top: '0px',
  visibility: 'hidden',
});
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let resizeObserver: ResizeObserver | null = null;

const hasTrigger = computed(() => Boolean(slots.trigger || slots.default));
const triggerSlotProps: UiOverlayTriggerSlotProps = {
  get open() {
    return visible.value;
  },
  toggle: () => (visible.value ? hideNow() : showNow()),
  close: hideNow,
};

const triggerAttributes = computed<Record<string, unknown>>(() => ({
  'aria-describedby': tooltipId,
  onMouseenter: onMouseEnter,
  onMouseleave: onMouseLeave,
  onFocusin: onFocus,
  onFocusout: onFocusOut,
}));

const { layerProps } = useUiLayer('tooltip', {
  enabled: visible,
  element: tooltipElement,
  onEscape: () => {
    hideNow();
  },
});
const resolvedSurfaceStyle = computed(() => [
  layerProps.value.style,
  positionStyle.value,
  props.surfaceStyle,
]);

function setTriggerElement(value: unknown): void {
  triggerElement.value = resolveElement(value);
}

/**
 * Оба таймера отменяются и ссылки обнуляются одним идемпотентным действием.
 * Так запоздалый callback не меняет видимость после нового pointer/focus события.
 */
function clearTimers(): void {
  if (showTimer) {
    clearTimeout(showTimer);
  }
  if (hideTimer) {
    clearTimeout(hideTimer);
  }

  showTimer = null;
  hideTimer = null;
}

function showNow(): void {
  if (visible.value) {
    void nextTick(place);

    return;
  }

  visible.value = true;
  void nextTick(place);
}

function hideNow(): void {
  clearTimers();
  visible.value = false;
}

/**
 * Возврат курсора отменяет ожидающее скрытие, но не множит show timers.
 * Задержка нормализуется до неотрицательной перед передачей браузеру.
 */
function scheduleShow(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
  }

  hideTimer = null;

  if (visible.value || showTimer) {
    return;
  }

  showTimer = setTimeout(
    () => {
      showTimer = null;
      showNow();
    },
    Math.max(0, props.showDelay),
  );
}

/**
 * Tooltip остаётся открыт, пока trigger удерживает hover или focus.
 * Callback повторно проверяет оба флага, закрывая гонку с новым событием.
 */
function scheduleHide(): void {
  if (hovered.value || focused.value) {
    return;
  }
  if (showTimer) {
    clearTimeout(showTimer);
  }

  showTimer = null;

  if (hideTimer) {
    clearTimeout(hideTimer);
  }

  hideTimer = setTimeout(
    () => {
      hideTimer = null;

      if (!hovered.value && !focused.value) {
        visible.value = false;
      }
    },
    Math.max(0, props.hideDelay),
  );
}

function onMouseEnter(): void {
  hovered.value = true;
  scheduleShow();
}

function onMouseLeave(): void {
  hovered.value = false;
  scheduleHide();
}

function onFocus(): void {
  focused.value = true;
  scheduleShow();
}

/**
 * `focusout` всплывает от составного trigger-а, поэтому переход между его детьми
 * не считается уходом наружу и не запускает преждевременное скрытие tooltip.
 */
function onFocusOut(event: FocusEvent): void {
  const boundary = event.currentTarget;
  const next = event.relatedTarget;

  if (
    boundary instanceof Node &&
    next instanceof Node &&
    boundary.contains(next)
  ) {
    return;
  }

  focused.value = false;
  scheduleHide();
}

function axisPlacement(
  placement: UiOverlayPlacement,
): 'top' | 'right' | 'bottom' | 'left' {
  return placement.split('-')[0] as 'top' | 'right' | 'bottom' | 'left';
}

/**
 * Start/end выравнивают tooltip по поперечной оси trigger-а.
 * Placement без суффикса получает симметричное центрирование.
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
 * Противоположная сторона сохраняет исходный start/end-суффикс.
 * Благодаря этому flip не меняет ожидаемое поперечное выравнивание.
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
 * Tooltip переворачивается при дефиците места и затем зажимается в viewport.
 * Одновременно вычисляются CSS anchor-координаты относительно trigger-а.
 */
function place(): void {
  const trigger = triggerElement.value;
  const surface = tooltipElement.value;

  if (!trigger || !surface || typeof window === 'undefined') {
    return;
  }

  const triggerRect = trigger.getBoundingClientRect();
  const width = surface.offsetWidth;
  const height = surface.offsetHeight;
  const edge = 8;
  const gap = Math.max(0, props.offset);
  let placement = requestedPlacement.value;
  let axis = axisPlacement(placement);

  const room = {
    top: triggerRect.top - edge,
    right: window.innerWidth - triggerRect.right - edge,
    bottom: window.innerHeight - triggerRect.bottom - edge,
    left: triggerRect.left - edge,
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
    Math.max(left, edge),
    Math.max(edge, window.innerWidth - width - edge),
  );
  top = Math.min(
    Math.max(top, edge),
    Math.max(edge, window.innerHeight - height - edge),
  );
  actualPlacement.value = placement;
  positionStyle.value = {
    position: 'fixed',
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    visibility: 'visible',
    '--ui-overlay-anchor-x': `${Math.round(triggerRect.left + triggerRect.width / 2 - left)}px`,
    '--ui-overlay-anchor-y': `${Math.round(triggerRect.top + triggerRect.height / 2 - top)}px`,
  };
}

/**
 * При viewport-событии исчезнувший или полностью ушедший trigger закрывает tooltip.
 * Пока trigger видим, позиция пересчитывается без нового цикла показа.
 */
function onViewportMove(): void {
  const trigger = triggerElement.value;

  if (!trigger?.isConnected) {
    hideNow();

    return;
  }

  const rect = trigger.getBoundingClientRect();

  if (
    rect.bottom < 0 ||
    rect.top > window.innerHeight ||
    rect.right < 0 ||
    rect.left > window.innerWidth
  ) {
    hideNow();

    return;
  }

  place();
}

watch(
  visible,
  (open) => {
    if (typeof window === 'undefined') {
      return;
    }
    if (open) {
      window.addEventListener('scroll', onViewportMove, {
        capture: true,
        passive: true,
      });
      window.addEventListener('resize', onViewportMove, { passive: true });

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(place);
        void nextTick(() => {
          if (tooltipElement.value) {
            resizeObserver?.observe(tooltipElement.value);
          }
        });
      }
    } else {
      window.removeEventListener('scroll', onViewportMove, true);
      window.removeEventListener('resize', onViewportMove);
      resizeObserver?.disconnect();
      resizeObserver = null;
    }
  },
  { flush: 'post' },
);

onBeforeUnmount(() => {
  clearTimers();

  if (typeof window !== 'undefined') {
    window.removeEventListener('scroll', onViewportMove, true);
    window.removeEventListener('resize', onViewportMove);
  }

  resizeObserver?.disconnect();
});

defineExpose({
  show: showNow,
  hide: hideNow,
  triggerElement,
  tooltipElement,
});
</script>
