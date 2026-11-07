<template>
  <span
    v-if="visible"
    class="chat-keyboard-layout"
    data-role="chat-keyboard-layout"
    role="img"
    :aria-label="description"
    v-tooltip="description"
  >
    <svg viewBox="0 0 28 22" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="26" height="20" rx="3" stroke="currentColor" />
      <text x="14" y="14.5" text-anchor="middle" fill="currentColor">{{ label }}</text>
    </svg>
  </span>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';

import type { KeyboardLayout } from '../../../../shared/desktop/keyboardLayout.ts';
import { currentDesktopMode } from '../../shared/desktopSettings.ts';
import { observeKeyboardLayout } from '../../shared/keyboardLayout.ts';
import { t, vTooltip } from '../../ui';

const emit = defineEmits<{ visibilityChange: [visible: boolean] }>();

const desktop = currentDesktopMode() !== 'page';
const media = window.matchMedia('(min-width: 601px) and (pointer: fine)');
const visible = ref(desktop && media.matches);
const layout = shallowRef<KeyboardLayout | null>(null);
const label = computed(() => {
  const code = layout.value?.code;

  return code ? (['us', 'gb'].includes(code) ? 'EN' : code.toUpperCase().slice(0, 3)) : '?';
});
const description = computed(() => {
  if (!layout.value) {
    return t('core.keyboardLayoutUnavailable');
  }

  const { code, variant } = layout.value;
  const name = variant ? `${code.toUpperCase()} (${variant})` : label.value;

  return t('core.keyboardLayoutCurrent', { layout: name });
});

let stop: (() => void) | undefined;

/**
 * Телефон, сенсорный режим и обычная веб-страница не запускают native-опрос.
 * Изменение размера останавливает прежнюю подписку и сбрасывает её снимок.
 */
function sync(): void {
  stop?.();
  stop = undefined;
  layout.value = null;
  visible.value = desktop && media.matches;
  emit('visibilityChange', visible.value);

  if (visible.value) {
    stop = observeKeyboardLayout(window, (value) => {
      layout.value = value;
    });
  }
}

onMounted(() => {
  media.addEventListener('change', sync);
  sync();
});
onUnmounted(() => {
  media.removeEventListener('change', sync);
  stop?.();
});
</script>

<style scoped>
.chat-keyboard-layout {
  position: absolute;
  top: 6px;
  left: 0;
  width: 28px;
  height: 22px;
  color: var(--ink-mid);
  user-select: none;
}

.chat-keyboard-layout svg {
  display: block;
  width: 100%;
  height: 100%;
}

.chat-keyboard-layout text {
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  font-weight: 500;
}
</style>
