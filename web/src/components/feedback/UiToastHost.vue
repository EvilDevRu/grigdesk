<template>
  <section v-if="toasts.length" class="ui-toast-host" aria-label="Оповещения" v-bind="layerProps">
    <TransitionGroup name="ui-toast">
      <article
        v-for="toast in visibleToasts"
        :key="toast.id"
        class="ui-toast"
        :data-toast-id="toast.id"
        :data-tone="toast.tone"
        :role="toast.tone === 'accent' ? 'status' : 'alert'"
        @pointerenter="pauseToast(toast.id)"
        @pointerleave="resumeToast(toast.id)"
        @focusin="pauseToast(toast.id)"
        @focusout="onFocusOut($event, toast.id)"
      >
        <span class="ui-toast__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
               stroke-linecap="round" stroke-linejoin="round">
            <path :d="TONE_ICONS[toast.tone]" />
          </svg>
        </span>

        <div class="ui-toast__content">
          <strong class="ui-toast__title">{{ toast.title }}</strong>
          <p v-if="toast.body" class="ui-toast__body">{{ toast.body }}</p>
          <pre v-if="toast.detail" class="ui-toast__detail">{{ toast.detail }}</pre>
          <div v-if="toast.actions.length" class="ui-toast__actions">
            <UiButton
              v-for="action in toast.actions"
              :key="action.id"
              data-context="toast-action"
              :tone="action.tone || 'neutral'"
              :variant="action.variant || 'outline'"
              @click="void runToastAction(toast.id, action.id)"
            >
              {{ action.label }}
            </UiButton>
          </div>
        </div>

        <UiIconButton
          class="ui-toast__close"
          data-context="toast-close"
          label="Закрыть оповещение"
          role="rail"
          @click="dismissToast(toast.id, 'user')"
        >
          ×
        </UiIconButton>
      </article>
    </TransitionGroup>

    <p v-if="hiddenCount" class="ui-toast-host__more">
      <span>Ещё {{ hiddenCount }}</span>
      <UiButton data-context="toast-action" variant="text" @click="dismissAllToasts('user')">
        Скрыть все
      </UiButton>
    </p>
  </section>
</template>

<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  shallowRef,
} from 'vue';
import { uiLayerProps } from '../../services/layers/priorities';
import UiButton from '../primitives/UiButton.vue';
import UiIconButton from '../primitives/UiIconButton.vue';
import {
  dismissAllToasts,
  dismissToast,
  pauseToast,
  resumeToast,
  runToastAction,
  setToastsVisible,
  subscribeToasts,
} from '../../services/toasts';
import type { UiToast, UiToastTone } from '../../types/uiToasts';

const VISIBLE_LIMIT = 3;

// Значок говорит о срочности раньше текста: сведения, ожидание человека, поломка.
const TONE_ICONS: Record<UiToastTone, string> = {
  accent: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 11v5M12 7.5v.5',
  warning: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7v5l3 2',
  danger: 'M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0'
    + 'M12 9v4M12 16.5v.5',
};

const toasts = shallowRef<readonly UiToast[]>([]);
const layerProps = uiLayerProps('toast');
let unsubscribe: (() => void) | undefined;

const visibleToasts = computed(() => toasts.value.slice(-VISIBLE_LIMIT).reverse());
const hiddenCount = computed(() => Math.max(0, toasts.value.length - VISIBLE_LIMIT));

/**
 * Перевод фокуса между кнопками одного тоста сохраняет паузу.
 * Таймер возвращается, только когда клавиатурный фокус покинул весь тост.
 */
function onFocusOut(event: FocusEvent, id: string): void {
  const article = event.currentTarget as HTMLElement;

  if (!(event.relatedTarget instanceof Node) || !article.contains(event.relatedTarget)) {
    resumeToast(id);
  }
}

function updateVisibility(): void {
  setToastsVisible(document.visibilityState !== 'hidden');
}

onMounted(() => {
  unsubscribe = subscribeToasts((snapshot) => {
    toasts.value = snapshot;
  });
  updateVisibility();
  document.addEventListener('visibilitychange', updateVisibility);
});

onBeforeUnmount(() => {
  unsubscribe?.();
  document.removeEventListener('visibilitychange', updateVisibility);
});
</script>
