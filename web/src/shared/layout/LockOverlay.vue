<template>
  <UiDialog open layer="session-lock" size="compact" :label="t('core.applicationLocked')"
            :mobile-fullscreen="false" persistent :dismissible="false" :busy="busy" data-ui-touch>
    <div class="session-lock-content">
      <div class="session-lock-symbol" aria-hidden="true"><MachineGlyph name="lock" /></div>
      <p class="session-lock-brand">GrigDesk</p>
      <h1>{{ t('core.applicationLocked') }}</h1>
      <p class="session-lock-description">{{ t('core.unlockWithDeviceSecurity') }}</p>
      <div v-if="shell.profile" class="session-lock-machine">
        <MachineGlyph name="machine" />
        <span>{{ shell.profile.name }}</span>
      </div>
      <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
      <UiButton block wrap variant="solid" tone="accent" :loading="busy" :disabled="busy"
                :loading-label="t('core.unlockWaiting')" @click="unlock">
        <template #leading><MachineGlyph name="lock" /></template>
        {{ error ? t('core.unlockRetry') : t('core.unlock') }}
      </UiButton>
      <p class="session-lock-note" role="status" aria-live="polite">
        {{ busy ? t('core.unlockWaiting') : t('core.unlockKeepsWorkspace') }}
      </p>
    </div>
  </UiDialog>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import { UiButton, UiDialog, UiInlineMessage, t } from '../../ui.ts';
import { useShellStore } from '../../stores/shell.ts';
import { failureText } from '../apiClient.ts';
import MachineGlyph from './MachineGlyph.vue';

const shell = useShellStore();
const busy = ref(false);
const error = ref('');

/**
 * Ключ устройства разблокируется только нативной оболочкой после действия человека.
 * Слой блокировки не размонтирует рабочий интерфейс и его несохранённые данные.
 */
async function unlock(): Promise<void> {
  if (busy.value) {
    return;
  }

  error.value = '';
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

<style scoped>
.session-lock-content {
  display: grid;
  justify-items: center;
  gap: 18px;
  padding: 20px 12px;
  text-align: center;
  min-width: 0;
}

.session-lock-symbol {
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-2);
  color: var(--accent);
}

.session-lock-symbol .machine-glyph {
  width: 32px;
  height: 32px;
}

.session-lock-brand {
  margin: 0;
  color: var(--ink-low);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
}

.session-lock-content h1 {
  margin: 0;
  font-size: 24px;
  line-height: 1.25;
  font-weight: 650;
  letter-spacing: -0.025em;
  overflow-wrap: anywhere;
}

.session-lock-description {
  margin: 0;
  color: var(--ink-mid);
  font-size: 14px;
  line-height: 1.6;
}

.session-lock-machine {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.session-lock-machine span {
  min-width: 0;
}

.session-lock-note {
  margin: 0;
  color: var(--ink-low);
  font-size: 12px;
  line-height: 1.6;
}

@media (max-width: 380px), (max-height: 500px) {
  .session-lock-content {
    gap: 14px;
    padding: 8px 0;
  }

  .session-lock-content h1 {
    font-size: 22px;
  }
}
</style>
