<template>
  <UiLoadingState :label="label" :description="description" :failed="failed">
    <div class="board-loading">
      <div class="summary" data-loading-region="summary">
        <div v-for="index in 4" :key="index" class="stat">
          <UiSkeleton width="62%" height="16px" />
          <UiSkeleton width="36%" height="24px" />
          <UiSkeleton width="75%" height="16px" />
        </div>
      </div>
      <div class="columns">
        <div class="primary" data-loading-region="primary">
          <div class="header" data-loading-region="header">
            <UiSkeleton width="28%" height="24px" />
            <UiSkeleton width="30%" height="32px" />
          </div>
          <UiSkeletonLayout :header="false" :rows="5" />
        </div>
      </div>
    </div>
  </UiLoadingState>
</template>

<script setup lang="ts">
import { UiLoadingState, UiSkeleton, UiSkeletonLayout } from '../ui';

defineOptions({ inheritAttrs: false });

withDefaults(defineProps<{
  label?: string;
  description?: string;
  failed?: boolean;
}>(), {
  label: undefined,
  description: undefined,
  failed: false,
});
</script>

<style scoped>
.board-loading { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.stat { display: flex; flex-direction: column; justify-content: space-between; gap: 7px;
  padding: 12px 16px; height: 132px; border: 1px solid var(--line); border-radius: var(--radius); }
.columns { display: flex; gap: 16px; }
.primary { flex: 2 1 720px; min-width: 0; padding: 14px;
  border: 1px solid var(--line); border-radius: var(--radius); }
.header { display: flex; align-items: center; justify-content: space-between;
  height: 36px; margin: 6px 0 10px; }
@container board-page (min-width: 720px) {
  .summary { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
@container board-page (max-width: 500px) {
  .summary { display: flex; align-items: center; height: 36px; }
  .stat { display: none; }
  .stat:first-child { display: flex; width: 60%; height: 16px; padding: 0; border: 0; }
  .stat:first-child > :not(:first-child) { display: none; }
}
@media (max-width: 600px) {
  .board-loading { gap: 10px; }
  .primary { padding: 10px; }
  .header { height: 82px; }
}
</style>
