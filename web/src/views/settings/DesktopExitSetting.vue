<template>
  <div v-if="supported" data-ui-settings-field data-layout="row">
    <UiField :label="t('desktop.exitAskSetting')" :hint="t('desktop.exitSettingHint')" :error="error">
      <UiSwitch
        :aria-label="t('desktop.exitAskSetting')"
        :model-value="checked"
        :disabled="busy"
        @update:model-value="save"
      />
    </UiField>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import type { ShellState } from '../../../../shared/client/clientShell.ts';
import { t, UiField, UiSwitch } from '../../ui.ts';
import { useShellStore } from '../../stores/shell.ts';
import { currentDesktopMode } from '../../shared/desktopSettings.ts';
import { shellAction } from '../../shared/shellClient.ts';
import { failureText } from '../../shared/apiClient.ts';

const shell = useShellStore();
const supported = computed(() => currentDesktopMode() === 'main' && !!shell.snapshot?.desktopExit);
const busy = ref(false);
const pending = ref<boolean | null>(null);
const error = ref('');
const checked = computed(() => pending.value ?? !shell.snapshot?.desktopExit?.skipConfirmation);

/**
 * Настройка устройства сохраняется сразу и не участвует в серверном Apply.
 * Ожидающее значение удерживается поверх старого poll, отказ возвращает принятый snapshot.
 */
async function save(value: boolean): Promise<void> {
  if (busy.value || !supported.value) {
    return;
  }

  busy.value = true;
  pending.value = value;
  error.value = '';

  try {
    const accepted = await shellAction('POST', '/exit-preference', { skipConfirmation: !value });

    shell.apply(accepted as ShellState);
  } catch (cause) {
    error.value = failureText(cause, t('desktop.exitSaveFailed'));
  } finally {
    pending.value = null;
    busy.value = false;
  }
}
</script>
