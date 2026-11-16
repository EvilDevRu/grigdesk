<template>
  <div v-if="supported" data-ui-settings-field data-layout="row">
    <UiField
      :label="t('core.androidBackgroundLink')"
      :hint="t('core.androidBackgroundLinkHint')"
      :error="error"
    >
      <UiSwitch
        :aria-label="t('core.androidBackgroundLink')"
        :model-value="enabled"
        :disabled="busy"
        @update:model-value="apply(Boolean($event))"
      />
    </UiField>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import type { ShellState } from '../../../../shared/client/clientShell.ts';
import { t, UiField, UiSwitch } from '../../ui.ts';
import { useShellStore } from '../../stores/shell.ts';
import { failureText } from '../../shared/apiClient.ts';

const shell = useShellStore();
const supported = computed(() => shell.backgroundLink !== null);
const busy = ref(false);
const pending = ref<boolean | null>(null);
const error = ref('');
const enabled = computed(() => pending.value ?? shell.backgroundLink?.enabled ?? false);

/**
 * Фоновая связь сохраняется сразу полным значением, без серверного Apply.
 * Ожидающее значение удерживается поверх старого poll, отказ возвращает принятый snapshot.
 */
async function apply(next: boolean): Promise<void> {
  if (busy.value || !supported.value) {
    return;
  }

  busy.value = true;
  pending.value = next;
  error.value = '';

  try {
    const accepted = await shell.setBackgroundLink(next);

    shell.apply(accepted as ShellState);
  } catch (cause) {
    error.value = failureText(cause, t('core.androidBackgroundLinkSaveFailed'));
  } finally {
    pending.value = null;
    busy.value = false;
  }
}
</script>
