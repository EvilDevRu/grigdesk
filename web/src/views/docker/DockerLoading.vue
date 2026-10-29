<template>
  <UiLoadingState :label="label" :description="description" :failed="failed">
    <div :class="['docker-loading', area]">
      <template v-if="area === 'panel'">
        <UiSkeleton height="56px" />
        <div class="facts"><UiSkeleton v-for="i in 4" :key="i" shape="block" /></div>
        <UiSkeleton height="36px" />
        <UiSkeleton height="32px" width="64%" />
      </template>
      <div v-if="area === 'usage'" class="table" data-loading-region="table">
        <div v-for="i in 6" :key="i" class="table-row">
          <UiSkeleton width="16px" height="16px" />
          <UiSkeleton width="80%" />
          <UiSkeleton width="70%" />
          <UiSkeleton width="70%" />
        </div>
      </div>
      <div v-else class="group">
        <div class="group-head"><UiSkeleton width="30%" height="20px" /></div>
        <div v-for="i in 3" :key="i" class="row" data-loading-region="row">
          <UiSkeletonLayout layout="text" :header="false" :rows="1" />
          <UiSkeleton width="70%" />
          <UiSkeleton width="70%" />
          <UiSkeleton width="70%" />
        </div>
      </div>
    </div>
  </UiLoadingState>
</template>

<script setup lang="ts">
import { UiLoadingState, UiSkeleton, UiSkeletonLayout } from '../../ui';

defineOptions({ inheritAttrs: false });

withDefaults(defineProps<{
  label?: string;
  description?: string;
  failed?: boolean;
  area?: 'containers' | 'usage' | 'panel';
}>(), {
  label: undefined,
  description: undefined,
  failed: false,
  area: 'containers',
});
</script>

<style scoped>
.docker-loading { display: grid; gap: 16px; min-width: 0; }
.panel { padding: 16px; }
.facts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.group { border: 1px solid var(--line); border-radius: var(--radius); }
.group-head { display: flex; align-items: center; min-height: 56px; padding: 12px 16px; }
.row { display: grid; grid-template-columns: 2fr 1.2fr .7fr .9fr; align-items: center;
  gap: 14px; min-height: 91px; padding: 14px 16px; border-top: 1px solid var(--line); }
.table { width: 100%; }
.table-row { display: grid; grid-template-columns: 36px minmax(0, 1fr) 20% 25%;
  align-items: center; gap: 8px; padding: 14px 12px; min-height: 64px; border-bottom: 1px solid var(--line); }
@media (max-width: 760px) {
  .row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}

</style>
