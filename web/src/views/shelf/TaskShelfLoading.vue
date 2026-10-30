<template>
  <div class="shelf-loading-panel">
    <UiLoadingState :label="label" :failed="failed" style="height: 100%">
      <div class="shelf">
        <div class="header"><UiSkeleton width="34%" height="18px" /></div>
        <div class="toolbar">
          <UiSkeleton class="search" height="32px" />
          <div class="filters"><UiSkeleton width="100%" height="28px" /></div>
        </div>
        <div class="body">
          <UiSkeleton width="160px" height="18px" />
          <UiSkeletonLayout :header="false" :rows="4" />
        </div>
      </div>
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
.shelf-loading-panel {
  container: shelf-loading / inline-size;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.shelf {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  min-width: 0;
}

.header {
  display: flex;
  flex: none;
  align-items: center;
  min-height: 36px;
  padding-inline: 12px;
  border-bottom: 1px solid var(--line);
}

.toolbar {
  display: flex;
  flex: none;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}

.search {
  flex: 1 1 220px;
  max-width: 360px;
}

.filters {
  flex: 0 1 380px;
  min-width: 0;
}

.body {
  display: grid;
  align-content: start;
  gap: 20px;
  padding: 12px;
  overflow: hidden;
}

@container shelf-loading (max-width: 700px) {
  .search,
  .filters {
    flex: 1 1 100%;
    max-width: none;
  }
}
</style>
