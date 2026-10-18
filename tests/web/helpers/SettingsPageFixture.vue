<template>
  <SettingsField :address="address">
    <UiInput
      aria-label="Тестовое поле"
      :model-value="value"
      @update:model-value="edit"
    />
  </SettingsField>
  <UiButton @click="nested = true">Открыть QR</UiButton>
  <UiDialog
    :open="nested"
    label="QR-проверка"
    @close="nested = false"
  >
    <UiButton>Скопировать QR</UiButton>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { UiInput, UiButton, UiDialog } from '../../../web/src/ui.ts';
import { useSettingsStore } from '../../../web/src/stores/settings.ts';
import SettingsField from '../../../web/src/views/settings/SettingsField.vue';

defineProps<{ active?: boolean }>();

const settings = useSettingsStore();
const address = computed(() => ({
  pageId: 'interface.behavior',
  entityId: settings.entityId,
  tabId: settings.tabId,
  fieldPath: ['value'],
}));
const nested = ref(false);
const value = computed(() => {
  settings.snapshot;

  return String(settings.getValue('test', 'value') ?? '');
});

function edit(value: unknown): void {
  settings.setField('test', 'value', String(value));
}
</script>
