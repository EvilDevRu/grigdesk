<template>
  <div class="density-consumers">
    <div class="consumer-controls">
      <UiInput v-model="value" data-context="settings-field" class="pvsetinput" aria-label="Настройка" />
      <UiInput v-model="secret" type="password" aria-label="Синтетический секрет" />
      <UiButton data-context="task-footer-action">Действие задачи</UiButton>
      <UiButton data-role="task-compact-action">Действие карточки</UiButton>
      <UiButton data-role="pipeline-compact-action">Действие конвейера</UiButton>
      <UiButton data-role="pipeline-runner"><b>Исполнитель фикстуры</b><small>Модель и усилие</small></UiButton>
      <UiIconButton data-context="task-modal-header" label="Шапка задачи">×</UiIconButton>
      <UiIconButton data-context="pipeline-stage-close" label="Закрыть этап">×</UiIconButton>
      <UiSwitch v-model="enabled">Переключатель</UiSwitch>
      <UiButton @click="dialog = true">Диалог фикстуры</UiButton>
    </div>
    <UiDialog v-model:open="dialog" title="Синтетический диалог" data-role="task-modal">
      <UiInput v-model="value" aria-label="Поле диалога" />
      <UiButton @click="dialog = false">Готово</UiButton>
    </UiDialog>
    <div class="density-virtual" tabindex="0" aria-label="Синтетический длинный список">
      <VirtualRows :items="items" :item-key="itemKey" :row-height="36">
        <template #default="{ item }">
          <UiButton block :data-density-row="item">Строка {{ item }}</UiButton>
        </template>
      </VirtualRows>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { UiInput, UiButton, UiIconButton, UiSwitch, UiDialog } from '../../../../web/src/ui.ts';
import VirtualRows from '../../../../web/src/shared/VirtualRows.vue';

const value = ref('Синтетическое значение');
const secret = ref('fixture-only');
const enabled = ref(false);
const dialog = ref(false);
const items = Array.from({ length: 300 }, (_, index) => index);
const itemKey = (item) => item;
</script>

<style>
.density-consumers { display: grid; gap: 12px; max-width: 100%; }
.consumer-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.density-virtual { width: 320px; max-width: 100%; height: 320px; overflow: auto; }
</style>
