<template>
  <UiButton id="fixture-open" @click="settings.requestOpen({ source: 'button' })">Настройки</UiButton>
  <SettingsModal />
  <UiDialogHost />
  <UiDialog
    :open="other"
    label="Другой диалог"
    @close="other = false"
  >
    <UiButton>Действие другого диалога</UiButton>
  </UiDialog>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { UiButton, UiDialog, UiDialogHost, hasOpenModal } from '../../../web/src/ui.ts';
import SettingsModal from '../../../web/src/views/settings/SettingsModal.vue';
import { useSettingsStore } from '../../../web/src/stores/settings.ts';
import { useUiContextStore } from '../../../web/src/stores/uiContext.ts';

const settings = useSettingsStore();
const ui = useUiContextStore();
const other = ref(false);

defineExpose({
  settings,
  ui,
  other,
  hasOpenModal,
});
</script>
