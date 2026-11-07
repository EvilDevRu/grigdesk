<template>
  <UiLoadingState :label="label" :failed="failed">
    <div class="graph">
      <div v-for="row in 3" :key="row" class="row">
        <UiSkeleton v-for="node in 3" :key="node" shape="block" height="64px" />
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
}>(), {
  label: undefined,
  description: undefined,
  failed: false,
});
</script>

<style scoped>
.graph { display: grid; gap: 40px; padding: 32px; min-height: 320px; }
.row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 32px; }
.row + .row { border-top: 1px solid var(--line); padding-top: 32px; }
@media (max-width: 600px) {
  .graph { padding: 16px; }
  .row { gap: 12px; }
}
</style>
