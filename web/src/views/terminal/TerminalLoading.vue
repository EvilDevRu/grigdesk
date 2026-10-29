<template>
  <div class="panel" :class="{ compact }">
    <UiLoadingState style="height: 100%" :label="label" :failed="failed">
      <div class="outline">
        <div class="header">
          <UiSkeleton width="96px" height="12px" />
          <UiSkeleton shape="block" width="80px" height="var(--control-height)" />
          <UiSkeleton class="action" shape="block" width="140px" height="var(--control-height)" />
        </div>
        <div class="console"><UiSkeletonLayout layout="text" :header="false" :rows="12" /></div>
      </div>
    </UiLoadingState>
  </div>
</template>

<script setup lang="ts">
import { UiLoadingState, UiSkeleton, UiSkeletonLayout } from '../../ui';

defineOptions({ inheritAttrs: false });

withDefaults(defineProps<{
  compact?: boolean;
  label?: string;
  description?: string;
  failed?: boolean;
}>(), {
  compact: false,
  label: undefined,
  description: undefined,
  failed: false,
});
</script>

<style scoped>
.panel, .outline { height: 100%; min-height: 0; }
.outline { display: flex; flex-direction: column; }
.header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 8px 12px; border-bottom: 1px solid var(--line); }
.action { margin-left: auto; }
.console { flex: 1; min-height: 0; padding: 8px 10px; overflow: hidden; }
.compact .header { gap: 8px; padding: 7px var(--tool-dock-actions-space, 9px) 7px 9px; }
</style>
