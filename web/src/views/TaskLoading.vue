<template>
  <UiLoadingState :label="label" :description="description" :failed="failed">
    <div :class="['task-loading', area]">
      <UiSkeleton v-if="area === 'options'" width="50%" />
      <template v-else-if="area === 'window'">
        <div class="window-overview">
          <UiSkeleton width="72%" height="22px" />
          <UiSkeleton width="58%" />
        </div>
        <div class="window-navigation">
          <UiSkeleton width="72px" />
          <UiSkeleton width="48px" />
          <UiSkeleton width="96px" />
        </div>
        <div class="window-content">
          <UiSkeletonLayout layout="text" />
        </div>
      </template>
      <UiSkeletonLayout v-else :layout="area === 'comments' ? 'list' : 'text'" :header="false" />
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
  area?: 'description' | 'options' | 'comments' | 'window';
}>(), {
  label: undefined,
  description: undefined,
  failed: false,
  area: 'description',
});
</script>

<style scoped>
.task-loading { min-width: 0; }
.options { display: flex; align-items: center; height: 36px; padding: 8px 12px; }
.window {
  container: task-loading / inline-size;
}
.window-overview {
  display: grid;
  gap: 12px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--line);
}
.window-navigation {
  display: flex;
  align-items: center;
  gap: 24px;
  min-height: 43px;
  padding-inline: 20px;
  border-bottom: 1px solid var(--line);
}
.window-content {
  padding: 20px;
}
@container task-loading (max-width: 480px) {
  .window-content {
    padding: 14px 12px;
  }
  .window-overview,
  .window-navigation {
    padding-inline: 12px;
  }
}
</style>
