<template>
  <div class="plugin-loading">
  <UiLoadingState style="height: 100%" :label="label" :failed="failed">
    <UiSkeleton shape="block" height="100%" />
  </UiLoadingState>
  </div>
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
.plugin-loading { height: 100%; min-height: 240px; }
</style>
