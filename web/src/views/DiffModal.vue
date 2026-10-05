<template>
  <UiDialog
    :open="diff.open"
    class="diff-dialog"
    layer="diff-workspace"
    size="workspace"
    :label="`#${diff.taskId} · диф`"
    :body-inset="false"
    fade-only
    @update:open="onDialogOpenChange"
  >
    <template #header="{ close }">
      <div class="diff-dialog__header">
        <span class="diff-dialog__title mono">#{{ diff.taskId }} · диф</span>
        <UiIconButton
          role="embedded"
          label="Закрыть диф"
          v-tooltip="'Закрыть (Esc)'"
          @click="close('action')"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </UiIconButton>
      </div>
    </template>

    <!-- Пустая строка вместо null: у панели нет «задачи не выбрано», и её
         собственное значение по умолчанию — та же пустая строка. -->
    <DiffPanel :task-id="diff.taskId ?? ''" class="diff-dialog__panel" />
  </UiDialog>
</template>

<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';
import { UiDialog, UiIconButton, vTooltip } from '../ui';
import { useDiffStore } from '../stores/diff.js';
import DiffPanel from './diff/DiffPanel.vue';

const diff = useDiffStore();

function onDialogOpenChange(open: boolean): void {
  if (!open) {
    diff.close();
  }
}

watch(
  () => diff.open,
  (open) => {
    document.documentElement.classList.toggle('diff-modal-open', open);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  document.documentElement.classList.remove('diff-modal-open');
});
</script>

<style scoped>
.diff-dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}

.diff-dialog__title {
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
}

.diff-dialog__panel {
  flex: 1;
  min-height: 0;
}
</style>
