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
        <UiTextarea v-model="pairing" :placeholder="pairingPlaceholder" :disabled="busy"
                    :rows="3" spellcheck="false" autocomplete="off" />
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

import { computed, ref, watch } from 'vue';

import { UiDialog, UiButton, UiField, UiTextarea, UiInlineMessage } from '../../ui.ts';
import { useShellStore } from '../../stores/shell.ts';
import { failureText } from '../apiClient.ts';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ 'update:open': [value: boolean] }>();
const shell = useShellStore();
const pairing = ref('');
const error = ref('');
const busy = ref(false);
const pairingPlaceholder = computed(() => shell.capabilities.includes('scan')
  ? t('core.pairingStringPlaceholder') : t('core.desktopPairingPlaceholder'));
let generation = 0;

watch(() => props.open, (open) => {
  generation += 1;

  if (!open) {
    pairing.value = '';
    error.value = '';
  }
});

/**
 * Секретная строка уходит только в API оболочки и очищается при закрытии диалога.
 * После ответа, включая отказ, секрет удаляется и не становится состоянием установки.
 */
async function add(): Promise<void> {
  const epoch = generation;

  busy.value = true;
  error.value = '';

  try {
    await shell.addMachine(pairing.value.trim());

    if (props.open && generation === epoch) {
      emit('update:open', false);
    }
  } catch (failure) {
    if (props.open && generation === epoch) {
      error.value = failureText(failure, t('core.couldNotAddTheMachine'));
    }
  } finally {
    if (generation === epoch) {
      pairing.value = '';
      busy.value = false;
    }
  }
}

/**
 * Камера принадлежит нативной оболочке, веб получает только разобранную строку.
 * Ошибка или отмена сканирования оставляет диалог открытым для ручной вставки.
 */
async function scan(): Promise<void> {
  const epoch = generation;

  try {
    const result = await shell.scan();

    if (props.open && generation === epoch) {
      pairing.value = result.pairing;
    }
  } catch (failure) {
    if (props.open && generation === epoch) {
      error.value = failureText(failure, t('core.couldNotReadTheQRCode'));
    }
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
