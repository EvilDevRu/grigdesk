<template>
  <section v-if="toasts.length" class="ui-toast-host" :aria-label="t('settings.notifications')" v-bind="layerProps">
    <TransitionGroup name="ui-toast">
      <UiToastCard
        v-for="toast in visibleToasts"
        :key="toast.id"
        :toast="toast"
      />
    </TransitionGroup>

    <p v-if="hiddenCount" class="ui-toast-host__more">
      <span>{{ t('core.more') }} {{ hiddenCount }}</span>
      <UiButton data-context="toast-action" variant="text" @click="dismissAllToasts('user')">
        {{ t('core.dismissAll') }}
      </UiButton>
    </p>
  </section>
</template>

<script setup lang="ts">
import { t } from '../../services/locale.ts';

import {
  computed,
  onBeforeUnmount,
  onMounted,
  shallowRef,
} from 'vue';
import { uiLayerProps } from '../../services/layers/priorities';
import UiButton from '../primitives/UiButton.vue';
import UiToastCard from './UiToastCard.vue';
import {
  dismissAllToasts,
  setToastsVisible,
  subscribeToasts,
} from '../../services/toasts';
import type { UiToast } from '../../types/uiToasts';

const VISIBLE_LIMIT = 3;

const toasts = shallowRef<readonly UiToast[]>([]);
const layerProps = uiLayerProps('toast');
let unsubscribe: (() => void) | undefined;

const visibleToasts = computed(() => toasts.value.slice(-VISIBLE_LIMIT).reverse());
const hiddenCount = computed(() => Math.max(0, toasts.value.length - VISIBLE_LIMIT));

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
