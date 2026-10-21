<template>
  <UiDialog open layer="session-lock" :title="t('core.applicationLocked')" persistent :dismissible="false">
    <p>{{ t('core.unlockTheDeviceToContinue') }}</p>
    <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
    <template #footer>
      <UiButton :disabled="busy" @click="unlock">{{ t('core.unlock') }}</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { t } from '../../ui.ts';

import { ref } from 'vue';

import { UiButton, UiDialog, UiInlineMessage } from '../../ui.ts';
import { useShellStore } from '../../stores/shell.ts';
import { failureText } from '../apiClient.ts';

const shell = useShellStore();
const busy = ref(false);
const error = ref('');

/**
 * Ключ устройства разблокируется только нативной оболочкой после действия человека.
 * Слой блокировки не размонтирует рабочий интерфейс и его несохранённые данные.
 */
async function unlock(): Promise<void> {
  busy.value = true;

  try {
    await shell.unlock();
  } catch (failure) {
    error.value = failureText(failure, t('core.couldNotUnlockTheDevice'));
  } finally {
    busy.value = false;
  }
}
</script>
