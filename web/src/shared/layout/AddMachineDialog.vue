<template>
  <UiDialog :open="open" title="Добавить машину" size="compact" :busy="busy"
            @update:open="$emit('update:open', $event)">
    <div class="pair-machine">
      <p class="pair-machine-intro">Подключите другой компьютер с GrigDesk, чтобы работать с ним из этого окна.</p>
      <ol class="pair-machine-steps">
        <li>На нужном компьютере откройте настройки GrigDesk и создайте код привязки устройства.</li>
        <li>Скопируйте строку привязки и вставьте её ниже.</li>
      </ol>
      <UiField label="Строка привязки" hint="Код действует ограниченное время. Если он истёк, создайте новый.">
        <UiTextarea v-model="pairing" placeholder="GRIGDESK:PAIR:1:…" :disabled="busy" :rows="3"
                    spellcheck="false" autocomplete="off" />
      </UiField>
      <UiButton v-if="shell.capabilities.includes('scan')" :disabled="busy" @click="scan">
        Сканировать QR-код
      </UiButton>
      <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
    </div>
    <template #footer>
      <UiButton variant="text" :disabled="busy" @click="$emit('update:open', false)">Отмена</UiButton>
      <UiButton variant="solid" tone="accent" :loading="busy" :disabled="busy || !pairing.trim()"
                @click="add">Добавить</UiButton>
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
