<template>
  <div v-if="supported" data-ui-settings-field data-layout="row">
    <UiField :label="t('core.androidAppLock')" :hint="t('core.androidAppLockHint')" :error="error">
      <UiSwitch
        :aria-label="t('core.androidAppLock')"
        :model-value="enabled"
        :disabled="busy"
        @update:model-value="apply(Boolean($event), delay)"
      />
      <UiSelect
        :aria-label="t('core.androidAppLockDelay')"
        :model-value="delay"
        :disabled="busy || !enabled"
        @update:model-value="apply(enabled, Number($event))"
      >
        <option :value="0">{{ t('core.androidAppLockImmediate') }}</option>
        <option :value="60">{{ t('core.androidAppLockMinute') }}</option>
        <option :value="300">{{ t('core.androidAppLockFiveMinutes') }}</option>
      </UiSelect>
    </UiField>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import type { ShellState } from '../../../../shared/client/clientShell.ts';
import { t, UiField, UiSelect, UiSwitch } from '../../ui.ts';
import { useShellStore } from '../../stores/shell.ts';
import { shellAction } from '../../shared/shellClient.ts';
import { failureText } from '../../shared/apiClient.ts';

const shell = useShellStore();
const supported = computed(() => shell.appLock !== null);
const busy = ref(false);
const pending = ref<{
  enabled: boolean;
  delaySeconds: number;
} | null>(null);
const error = ref('');
const enabled = computed(() => pending.value?.enabled ?? shell.appLock?.enabled ?? false);
const delay = computed(() => pending.value?.delaySeconds ?? shell.appLock?.delaySeconds ?? 60);

/**
 * Настройка устройства сохраняется сразу и полным значением, без серверного Apply.
 * Ожидающая пара удерживается поверх старого poll, отказ возвращает принятый snapshot.
 */
async function apply(nextEnabled: boolean, nextDelay: number): Promise<void> {
  if (busy.value || !supported.value) {
    return;
  }

  busy.value = true;
  pending.value = {
    enabled: nextEnabled,
    delaySeconds: nextDelay,
  };
  error.value = '';

  try {
    const accepted = await shellAction('POST', '/app-lock', {
      enabled: pending.value.enabled,
      delaySeconds: pending.value.delaySeconds,
    });

    shell.apply(accepted as ShellState);
  } catch (cause) {
    error.value = failureText(cause, t('core.androidAppLockSaveFailed'));
  } finally {
    pending.value = null;
    busy.value = false;
  }
}
</script>
