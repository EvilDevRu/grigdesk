<template>
  <UiDialog
    :open="open"
    title="Сохранить изменения настроек?"
    layer="confirm"
    data-role="settings-close-choice"
    @close="reason => reason === 'escape' && emit('choose', 'continue')"
  >
    <p>Есть неприменённые изменения. Выберите, что сделать перед закрытием.</p>
    <template #footer>
      <UiButton @click="emit('choose', 'continue')">Продолжить редактирование</UiButton>
      <UiButton @click="emit('choose', 'discard')">Не сохранять</UiButton>
      <UiButton
        tone="accent"
        variant="solid"
        @click="emit('choose', 'apply')"
      >
        Применить и закрыть
      </UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { UiButton, UiDialog } from '../../ui.ts';

defineProps<{ open: boolean }>();

const emit = defineEmits<{ choose: [choice: 'apply' | 'discard' | 'continue'] }>();
</script>
