<template>
  <UiLoadingState :label="label" :description="description" :failed="failed">
    <div v-if="compact" class="board-phone-loading" data-loading-region="phone-primary">
      <div class="phone-controls">
        <UiSkeleton height="44px" />
        <UiSkeleton height="44px" />
      </div>
      <div v-for="index in 3" :key="index" class="phone-task">
        <UiSkeleton width="90%" height="18px" />
        <UiSkeleton width="65%" height="18px" />
        <UiSkeleton width="40%" height="12px" />
      </div>
    </div>
    <div v-else class="board-loading" :class="{ 'ui-workspace': includeOwnTasks }">
      <div v-if="includeOwnTasks" class="own-tasks" data-loading-region="own-tasks">
        <div class="own-heading">
          <h3><UiSkeleton width="130px" height="20px" /></h3>
          <UiSkeleton width="150px" height="32px" />
        </div>
        <div class="own-list" />
      </div>
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
  includeOwnTasks?: boolean;
  compact?: boolean;
}>(), {
  label: undefined,
  description: undefined,
  failed: false,
  includeOwnTasks: false,
  compact: false,
});
</script>

<style scoped>
.board-phone-loading { display: grid; gap: 8px; min-width: 0; }
.phone-controls { display: grid; grid-template-columns: minmax(0, 1fr) 44px; gap: 8px; }
.phone-task { display: grid; gap: 6px; padding: 12px;
  border-bottom: 1px solid var(--line); }
.board-loading { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.own-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.own-list { display: grid; margin-block: 1em; }
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
  .header { height: 74px; }
}
</style>
