<template>
  <UiDialog
    data-perf-target="diff"
    :data-perf-key="String(diff.taskId || '')"
    :open="diff.open"
    class="diff-dialog"
    layer="diff-workspace"
    size="workspace"
    :title="t('core.diffDesignDialogTitle', { task: diff.taskId || '—' })"
    :close-label="t('core.diffZakrytDif')"
    :close-tooltip="t('core.docZakrytEsc')"
    :body-inset="false"
    fade-only
    @update:open="onDialogOpenChange"
  >
    <!-- Пустая строка вместо null: у панели нет «задачи не выбрано», и её
         собственное значение по умолчанию — та же пустая строка. -->
    <DiffPanel :task-id="diff.taskId ?? ''" class="diff-dialog__panel" />
  </UiDialog>
</template>

<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';
import { UiDialog, t } from '../ui';
import { useDiffStore } from '../stores/diff.ts';
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


.diff-dialog__panel {
  flex: 1;
  min-height: 0;
}
</style>
