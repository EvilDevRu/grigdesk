<template>
  <UiDialog :open="open" :title="t('core.addMachine')" size="compact" :busy="busy"
            @update:open="$emit('update:open', $event)">
    <div class="pair-machine">
      <p class="pair-machine-intro">{{ t('core.connectAnotherComputerRunningGrigDeskToWork') }}</p>
      <ol class="pair-machine-steps">
        <li>{{ t('core.onTheTargetComputerOpenGrigDeskSettings') }}</li>
        <li>{{ t('core.copyThePairingStringAndPasteIt') }}</li>
      </ol>
      <UiField :label="t('settings.pairingString')" :hint="t('core.pairingLifetime')">
        <UiTextarea v-model="pairing" placeholder="GRIGDESK:PAIR:1:…" :disabled="busy" :rows="3"
                    spellcheck="false" autocomplete="off" />
      </UiField>
      <UiButton v-if="shell.capabilities.includes('scan')" :disabled="busy" @click="scan">
        {{ t('core.scanQRCode') }}
      </UiButton>
      <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
    </div>
    <template #footer>
      <UiButton variant="text" :disabled="busy" @click="$emit('update:open', false)">{{ t('settings.cancel') }}</UiButton>
      <UiButton variant="solid" tone="accent" :loading="busy" :disabled="busy || !pairing.trim()"
                @click="add">{{ t('core.add') }}</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { t } from '../../ui.ts';

import { ref, watch } from 'vue';

import { UiDialog, UiButton, UiField, UiTextarea, UiInlineMessage } from '../../ui.ts';
import { useShellStore } from '../../stores/shell.ts';
import { failureText } from '../apiClient.ts';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ 'update:open': [value: boolean] }>();
const shell = useShellStore();
const pairing = ref('');
const error = ref('');
const busy = ref(false);

watch(() => props.open, (open) => {
  if (!open) {
    pairing.value = '';
    error.value = '';
  }
});

/**
 * Секретная строка уходит только в API оболочки и очищается при закрытии диалога.
 * Неудачная привязка оставляет введённый текст для исправления человеком.
 */
async function add(): Promise<void> {
  busy.value = true;
  error.value = '';

  try {
    await shell.addMachine(pairing.value.trim());
    emit('update:open', false);
  } catch (failure) {
    error.value = failureText(failure, t('core.couldNotAddTheMachine'));
  } finally {
    busy.value = false;
  }
}

/**
 * Камера принадлежит нативной оболочке, веб получает только разобранную строку.
 * Ошибка или отмена сканирования оставляет диалог открытым для ручной вставки.
 */
async function scan(): Promise<void> {
  try {
    pairing.value = (await shell.scan()).pairing;
  } catch (failure) {
    error.value = failureText(failure, t('core.couldNotReadTheQRCode'));
  }
}
</script>

<style scoped>
.pair-machine {
  display: grid;
  gap: 18px;
}

.pair-machine-intro {
  margin: 0;
  color: var(--ink-mid);
  font-size: 13px;
}

.pair-machine-steps {
  display: grid;
  gap: 10px;
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
}

.pair-machine-steps li {
  padding-left: 4px;
}

.pair-machine-steps li::marker {
  color: var(--ink-mid);
}
</style>
