<template>
  <UiLoadingState :label="label" :description="description" :failed="failed">
    <div class="cards" :class="{ compact }">
      <div v-for="index in 3" :key="index" class="loading-card" data-loading-region="card">
        <div class="header" data-loading-region="header">
          <UiSkeleton width="48px" height="20px" />
          <UiSkeleton width="40%" height="20px" />
          <UiSkeleton width="16%" />
        </div>
        <template v-if="!compact">
          <UiSkeleton height="6px" />
          <div class="nodes">
            <UiSkeleton v-for="node in 5" :key="node" shape="block" height="48px" />
          </div>
          <UiSkeleton v-if="loopsOn" width="65%" />
          <UiSkeletonLayout layout="text" :header="false" :rows="1" />
        </template>
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
  compact?: boolean;
  loopsOn?: boolean;
}>(), {
  label: undefined,
  description: undefined,
  failed: false,
  compact: false,
  loopsOn: false,
});
</script>

<style scoped>
.cards { display: grid; gap: 16px; }
.loading-card { padding: 14px 16px; border: 1px solid var(--line); border-left-width: 3px;
  border-radius: var(--radius); min-width: 0; }
.header { display: flex; align-items: center; gap: 10px; height: 28px; margin-bottom: 10px; }
.compact .header { height: 24px; }
.nodes { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin: 16px 0; }
@media (max-width: 600px) {
  .loading-card { padding: 10px 12px; }
  .header, .compact .header { display: grid; grid-template-columns: 48px minmax(0, 1fr);
    grid-template-rows: repeat(2, 44px); gap: 4px 10px; height: 92px; }
  .nodes { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
