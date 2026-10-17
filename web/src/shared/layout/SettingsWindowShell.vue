<template>
  <div class="settings-window" data-settings-window>
    <UiDialogHost />
    <UiTooltipHost />
    <div class="settings-window-scroll">
      <SettingsView v-if="auth.ready && auth.authenticated" :window-actions="actions" />
    </div>
    <DocumentModal />
    <UiToastHost />
  </div>
</template>

<script setup lang="ts">
import { asyncView } from '../asyncView.ts';
import { onUnmounted, watch, watchEffect } from 'vue';

import { UiDialogHost, UiTooltipHost, UiToastHost, useUiLayer, showToast } from '../../ui.ts';
import { useAuthStore } from '../../stores/auth.js';
import { useProvidersStore } from '../../stores/providers.js';
import { useCockpitUpdateStore } from '../../stores/cockpit-update.js';
import { useChatStore } from '../../stores/chat.js';
import { useSse } from '../../composables/useSse.ts';
import DocumentModal from '../../views/DocumentModal.vue';
import { onMutationSuccess, pendingMutations } from '../apiClient.ts';
import { createSettingsWindowChannel } from '../settingsWindowChannel.ts';
import { createSettingsWindowActions } from '../settingsWindowActions.ts';
import { closeCurrentWindow } from '../windowControl.ts';

const SettingsView = asyncView(() => import('../../views/SettingsView.vue'));
const auth = useAuthStore();
const prov = useProvidersStore();
const cockpitUpdate = useCockpitUpdateStore();
const chat = useChatStore();
const channel = createSettingsWindowChannel();
const actions = createSettingsWindowActions({
  channel,
  close: closeCurrentWindow,
  notify: (text) => showToast({
    id: 'settings-window-intent',
    title: text,
    tone: 'danger',
  }),
});
const unsubscribeMutation = onMutationSuccess(() => {
  channel.post({ version: 1, type: 'settings-changed' });
});

let closeTimer: ReturnType<typeof setTimeout> | null = null;
let waitingToClose = false;
let live = true;

/**
 * Поле ввода получает первый Escape для снятия фокуса без потери черновика.
 * Свободный фокус закрывает окно, вложенные диалоги обрабатывает общий стек выше этого слоя.
 */
function onEscape(): boolean {
  const active = document.activeElement;
  const textInput = active instanceof HTMLElement && (active.matches('textarea, select')
    || active.isContentEditable || active.closest('[contenteditable="true"], [contenteditable=""]')
    || (active.matches('input') && !active.matches(
      '[type=checkbox], [type=radio], [type=button], [type=submit], [type=reset], '
      + '[type=range], [type=color], [type=file], [type=image], [type=hidden]',
    )));

  if (textInput && active instanceof HTMLElement) {
    active.blur();
  } else {
    closeCurrentWindow();
  }

  return true;
}

useUiLayer('tools', { onEscape });

/**
 * Потеря входа ждёт завершения начатых этим окном мутаций.
 * Ожидание ограничено пятью секундами и удаляется вместе с оболочкой.
 */
function closeAfterMutations(): void {
  if (waitingToClose) {
    return;
  }

  waitingToClose = true;

  const deadline = Date.now() + 5000;
  /**
   * Проверяет завершение мутаций без подписки на состояние клиента.
   * После unmount таймер не выполняет эффект закрытия.
   */
  const check = () => {
    if (!live) {
      return;
    }

    if (pendingMutations() === 0 || Date.now() >= deadline) {
      closeTimer = null;
      closeCurrentWindow();

      return;
    }

    closeTimer = setTimeout(check, 50);
  };

  check();
}

watchEffect(() => {
  if (auth.ready && !auth.authenticated) {
    closeAfterMutations();
  }
});

const { connected } = useSse((name, data) => {
  const record = data && typeof data === 'object' ? data : null;

  if (name === 'providers-update') {
    if (record && 'credentials' in record && record.credentials) {
      void prov.invalidateCredentials(record.credentials);
    } else {
      void prov.load();
    }
  } else if (name === 'providers-usage') {
    prov.applyUsage(record && 'usage' in record ? record.usage : undefined);
  } else if (name === 'cockpit-update') {
    void cockpitUpdate.load({ quiet: true });
  } else if (name === 'speech-settings') {
    chat.setSpeechSnapshot(data);
  }
});

watch(connected, (value) => prov.noteUsageConnection(value), { immediate: true, flush: 'sync' });

onUnmounted(() => {
  live = false;

  if (closeTimer !== null) {
    clearTimeout(closeTimer);
  }

  unsubscribeMutation();
  channel.close();
});
</script>

<style scoped>
.settings-window {
  height: 100%;
}

.settings-window-scroll {
  height: 100%;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: var(--page-gutter);
}
</style>
