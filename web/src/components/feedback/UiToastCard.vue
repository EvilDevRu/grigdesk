<template>
  <article
    class="ui-toast"
    :data-toast-id="toast.id"
    :data-tone="toast.tone"
    :data-swiping="dragging || undefined"
    :style="swipeStyle"
    :role="toast.tone === 'accent' ? 'status' : 'alert'"
    @pointerenter="onPointerEnter"
    @pointerleave="onPointerLeave"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @lostpointercapture.self="onPointerCancel"
    @click.capture="onClick"
  >
    <span class="ui-toast__icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round">
        <path :d="TONE_ICONS[toast.tone]" />
      </svg>
    </span>

    <div class="ui-toast__content">
      <strong class="ui-toast__title">{{ resolveUiText(toast.title) }}</strong>
      <p v-if="toast.body" class="ui-toast__body">{{ resolveUiText(toast.body) }}</p>
      <pre v-if="toast.detail" class="ui-toast__detail">{{ resolveUiText(toast.detail) }}</pre>
      <div v-if="toast.actions.length" class="ui-toast__actions">
        <UiButton v-for="action in toast.actions" :key="action.id"
                  data-context="toast-action" size="compact" wrap
                  :tone="action.tone || 'neutral'" :variant="action.variant || 'outline'"
                  @click="void runToastAction(toast.id, action.id)">
          {{ resolveUiText(action.label) }}
        </UiButton>
      </div>
    </div>

    <UiIconButton class="ui-toast__close" data-context="toast-close"
                  :label="t('core.dismissNotification')" role="rail"
                  @click="dismissToast(toast.id, 'user')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
           stroke-linecap="round" aria-hidden="true">
        <path d="m6 6 12 12M18 6 6 18" />
      </svg>
    </UiIconButton>
  </article>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import { t, resolveUiText } from '../../services/locale.ts';
import { dismissToast, pauseToast, resumeToast, runToastAction } from '../../services/toasts';
import type { UiToast, UiToastTone } from '../../types/uiToasts';
import UiButton from '../primitives/UiButton.vue';
import UiIconButton from '../primitives/UiIconButton.vue';

interface SwipeGesture {
  pointerId: number;
  startX: number;
  startY: number;
  startedAt: number;
  element: HTMLElement;
  interactive: boolean;
}

const props = defineProps<{ toast: UiToast }>();

const TONE_ICONS: Record<UiToastTone, string> = {
  accent: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 11v5M12 7.5v.5',
  warning: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7v5l3 2',
  danger: 'M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0'
    + 'M12 9v4M12 16.5v.5',
};
const NATIVE_CONTENT = 'input, textarea, select, summary, [contenteditable], .ui-toast__detail';

const hovered = ref(false);
const focused = ref(false);
const dragging = ref(false);
const offset = ref(0);
const width = ref(320);
const exitOffset = ref('24px');
let gesture: SwipeGesture | null = null;
let blockClick = false;

const swipeStyle = computed(() => ({
  '--ui-toast-swipe-x': `${offset.value}px`,
  '--ui-toast-swipe-opacity': 1 - Math.min(Math.abs(offset.value) / width.value, 0.65),
  '--ui-toast-exit-x': exitOffset.value,
}));

function syncPause(): void {
  if (hovered.value || focused.value || gesture) {
    pauseToast(props.toast.id);
  } else {
    resumeToast(props.toast.id);
  }
}

function onPointerEnter(event: PointerEvent): void {
  hovered.value = !event.pointerType || event.pointerType === 'mouse';
  syncPause();
}

function onPointerLeave(): void {
  hovered.value = false;
  syncPause();
}

function onFocusIn(): void {
  focused.value = true;
  syncPause();
}

function onFocusOut(event: FocusEvent): void {
  const article = event.currentTarget as HTMLElement;

  focused.value = event.relatedTarget instanceof Node && article.contains(event.relatedTarget);
  syncPause();
}

/**
 * Захват снимается после очистки жеста: lostpointercapture не завершит его повторно.
 * Отмена возвращает карточку на место, подтверждённый свайп сохраняет положение для ухода.
 */
function resetGesture(restore = true): void {
  const previous = gesture;

  gesture = null;
  dragging.value = false;

  if (restore) {
    offset.value = 0;
    exitOffset.value = '24px';
  }

  if (previous?.element.hasPointerCapture?.(previous.pointerId)) {
    previous.element.releasePointerCapture(previous.pointerId);
  }

  syncPause();
}

/**
 * Палец и перо начинают жест только на свободной части карточки.
 * Кнопки, ссылки и прокручиваемые подробности сохраняют собственное взаимодействие.
 */
function onPointerDown(event: PointerEvent): void {
  if (gesture || event.isPrimary === false || event.button !== 0) {
    return;
  }

  blockClick = false;

  if (!['touch', 'pen'].includes(event.pointerType)
    || (event.target instanceof Element && event.target.closest(NATIVE_CONTENT))) {
    return;
  }

  const element = event.currentTarget as HTMLElement;

  width.value = element.getBoundingClientRect().width || 320;
  gesture = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startedAt: event.timeStamp,
    element,
    interactive: event.target instanceof Element
      && Boolean(event.target.closest('button, a, [role="button"]')),
  };
  syncPause();
}

/**
 * Направление фиксируется после небольшого порога: вертикальная прокрутка остаётся браузеру.
 * Только горизонтальный жест получает capture, движение карточки и подавление случайного клика.
 */
function onPointerMove(event: PointerEvent): void {
  if (!gesture || event.pointerId !== gesture.pointerId) {
    return;
  }

  const x = event.clientX - gesture.startX;
  const y = event.clientY - gesture.startY;

  if (!dragging.value) {
    if (Math.max(Math.abs(x), Math.abs(y)) < 8) {
      return;
    }

    if (gesture.interactive) {
      blockClick = true;
      resetGesture();

      return;
    }

    if (Math.abs(x) <= Math.abs(y) * 1.25) {
      resetGesture();

      return;
    }

    dragging.value = true;
    blockClick = true;
    gesture.element.setPointerCapture?.(event.pointerId);
  }

  event.preventDefault();
  offset.value = x;
}

/**
 * Длинный сдвиг или короткий быстрый бросок закрывает только сам тост как просмотренный.
 * Жест никогда не запускает действие, а неполное движение возвращается в исходное положение.
 */
function onPointerUp(event: PointerEvent): void {
  if (!gesture || event.pointerId !== gesture.pointerId) {
    return;
  }

  const distance = Math.abs(offset.value);
  const elapsed = event.timeStamp - gesture.startedAt;
  const threshold = Math.min(120, Math.max(56, width.value * 0.25));
  const dismissed = dragging.value && (distance >= threshold || (distance >= 40 && elapsed <= 200));

  if (dismissed) {
    const toast = props.toast;

    exitOffset.value = `${Math.sign(offset.value) * (width.value + 24)}px`;
    resetGesture(false);
    void nextTick(() => {
      if (props.toast === toast) {
        dismissToast(toast.id, 'user');
      }
    });
  } else {
    resetGesture();
  }
}

function onPointerCancel(event: PointerEvent): void {
  if (gesture?.pointerId === event.pointerId) {
    resetGesture();
  }
}

function onClick(event: MouseEvent): void {
  if (blockClick && event.detail > 0) {
    blockClick = false;
    event.preventDefault();
    event.stopPropagation();
  }
}

watch(() => props.toast, () => resetGesture());

onBeforeUnmount(() => {
  gesture = null;
  resumeToast(props.toast.id);
});
</script>
