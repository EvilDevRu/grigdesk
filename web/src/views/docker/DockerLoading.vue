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
          <UiSkeleton class="actions" width="90%" height="var(--toolbar-control-h)" />
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
.docker-loading { display: grid; gap: 16px; min-width: 0; container: docker-loading / inline-size; }
.panel { padding: 16px; }
.facts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.group { border: 1px solid var(--line); border-radius: var(--radius); }
.group-head { display: flex; align-items: center; min-height: 56px; padding: 12px 16px; }
.row { display: grid; grid-template-columns: 2fr 1.2fr .7fr .9fr; align-items: center;
  gap: 14px; min-height: 91px; padding: 14px 16px; border-top: 1px solid var(--line); }
.containers .group { border: 0; border-radius: 0; }
.containers .group-head { min-height: 42px; padding: 6px 0; border-bottom: 1px solid var(--line); }
.containers .row { grid-template-columns: minmax(180px, 1fr) minmax(130px, .7fr) 54px 84px 156px;
  gap: 12px; min-height: 62px; padding: 10px; }
.table { width: 100%; }
.table-row { display: grid; grid-template-columns: 36px minmax(0, 1fr) 20% 25%;
  align-items: center; gap: 8px; padding: 14px 12px; min-height: 64px; border-bottom: 1px solid var(--line); }
@media (max-width: 760px) {
  .row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}
@container docker-loading (max-width: 960px) {
  .containers .row { grid-template-columns: minmax(0, 1fr) auto auto; gap: 10px 16px; }
  .containers .row > :nth-child(1) { grid-column: 1; grid-row: 1; }
  .containers .row > :nth-child(2) { grid-column: 1; grid-row: 2; }
  .containers .row > :nth-child(3) { grid-column: 2; grid-row: 1; }
  .containers .row > :nth-child(4) { grid-column: 3; grid-row: 1; }
  .containers .actions { grid-column: 2 / 4; grid-row: 2; }
}
@container docker-loading (max-width: 600px) {
  .containers .row { grid-template-columns: 1fr 1fr; min-height: 160px; padding: 10px 0; gap: 8px; }
  .containers .row > :nth-child(1) { grid-column: 1 / -1; }
  .containers .row > :nth-child(2) { grid-column: 1 / -1; }
  .containers .row > :nth-child(3) { grid-column: 1; grid-row: 3; }
  .containers .row > :nth-child(4) { grid-column: 2; grid-row: 3; }
  .containers .actions { grid-column: 1 / -1; grid-row: 4; justify-self: end; }
}

</style>
