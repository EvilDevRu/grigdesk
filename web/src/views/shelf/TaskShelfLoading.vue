<template>
  <UiLoadingState :label="label" :failed="failed">
    <div class="shelf">
      <UiSkeleton width="30%" height="24px" />
      <UiSkeleton height="32px" />
      <UiSkeleton width="24%" />
      <UiSkeletonLayout :header="false" />
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
.shelf { display: grid; gap: 16px; padding: 16px; min-width: 0; }
</style>
