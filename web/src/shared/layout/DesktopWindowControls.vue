<template>
  <div v-if="state" class="desktop-window-controls" data-role="desktop-window-controls">
    <UiIconButton
      data-context="window-control"
      :label="t('desktop.windowMinimize')"
      :disabled="busy"
      @click="control('minimize')"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 11h10" /></svg>
    </UiIconButton>
    <UiIconButton
      data-context="window-control"
      :label="state.maximized ? t('desktop.windowRestore') : t('desktop.windowMaximize')"
      :disabled="busy"
      @click="control('toggle-maximize')"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path v-if="state.maximized" d="M6 3h7v7M3 6h7v7H3Z" />
        <path v-else d="M3 3h10v10H3Z" />
      </svg>
    </UiIconButton>
    <UiIconButton
      data-context="window-control"
      :label="t('desktop.windowClose')"
      :disabled="busy"
      @click="control('close')"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M4 12l8-8" /></svg>
    </UiIconButton>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import type { WindowControlAction } from '../../../../shared/desktop/windowControls.ts';
import { hasOpenModal, showToast, t, UiIconButton } from '../../ui.ts';
import { useShellStore } from '../../stores/shell.ts';
import { shellAction } from '../shellClient.ts';

const shell = useShellStore();
const busy = ref(false);
const state = computed(() => shell.snapshot?.windowControls);

/**
 * Кнопки живут под общим затемнением и не выполняют команды при открытом модальном слое.
 * Повтор одного нажатия запрещён до ответа локальной трубы, без доступа страницы к Node.
 */
async function control(action: WindowControlAction): Promise<void> {
  if (busy.value || hasOpenModal()) {
    return;
  }

  busy.value = true;

  try {
    await shellAction('POST', '/window', { action });
  } catch {
    showToast({
      id: 'window-control-failed',
      tone: 'danger',
      title: t('desktop.windowActionFailed'),
    });
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.desktop-window-controls {
  position: fixed;
  top: 0;
  right: 0;
  display: flex;
  height: var(--app-topbar-h);
  -webkit-app-region: no-drag;
}

.desktop-window-controls svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.3;
}
</style>
