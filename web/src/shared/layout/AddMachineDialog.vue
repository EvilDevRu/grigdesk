<template>
  <UiDialog :open="open" title="Добавить машину" :busy="busy" @update:open="$emit('update:open', $event)">
    <UiField label="Строка привязки">
      <UiTextarea v-model="pairing" placeholder="GRIGDESK:PAIR:1:…" :disabled="busy" />
    </UiField>
    <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
    <template #footer>
      <UiButton v-if="shell.capabilities.includes('scan')" :disabled="busy" @click="scan">
        Сканировать QR
      </UiButton>
      <UiButton :disabled="busy || !pairing.trim()" @click="add">Добавить</UiButton>
      <UiButton variant="text" :disabled="busy" @click="$emit('update:open', false)">Отмена</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
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
    error.value = failureText(failure, 'Не удалось добавить машину.');
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
    error.value = failureText(failure, 'Не удалось прочитать QR-код.');
  }
}
</script>
