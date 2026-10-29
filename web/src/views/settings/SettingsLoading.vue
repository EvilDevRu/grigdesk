<template>
  <UiLoadingState :label="label" :failed="failed">
    <div v-if="pageId === 'plugins.installed' || area === 'catalog'" class="settings-loading catalog-loading">
      <div class="catalog-toolbar" data-loading-region="tabs">
        <div class="catalog-tabs"><UiSkeleton width="200px" height="var(--control-height, 32px)" /></div>
        <UiSkeleton class="catalog-install" width="155px" height="var(--control-height, 32px)" />
      </div>
      <div class="catalog-filters" data-loading-region="filters">
        <UiSkeleton v-for="i in 4" :key="i" shape="block" height="var(--control-height, 32px)" />
      </div>
      <UiSkeleton width="45%" height="20px" />
      <div class="catalog-layout">
        <div class="catalog-list" data-loading-region="catalog">
          <UiSkeleton v-for="i in 4" :key="i" shape="block" height="84px" />
        </div>
        <div class="catalog-card" data-loading-region="passport">
          <UiSkeletonLayout layout="text" :rows="4" />
        </div>
      </div>
    </div>
    <div v-else :class="['settings-loading', { split: pageId === 'agents.providers' }]">
      <UiSkeletonLayout v-if="pageId === 'agents.providers'" layout="list" />
      <div>
        <div v-if="pageId === 'connections.b24'" class="connection-intro">
          <UiSkeleton width="60%" height="21px" />
          <UiSkeleton shape="block" height="38px" />
        </div>
        <div v-if="pageId === 'system.processes' || area === 'processes'" class="facts">
          <UiSkeleton v-for="i in 3" :key="i" shape="block" />
        </div>
        <UiSkeletonLayout :layout="pageId === 'system.processes' ? 'list' : 'form'" :header="false"
          :rows="pageId === 'connections.b24' ? 3 : 4" />
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
  pageId?: string;
  area?: 'form' | 'list' | 'providers' | 'catalog' | 'processes';
}>(), {
  label: undefined,
  description: undefined,
  failed: false,
  pageId: '',
  area: 'form',
});
</script>

<style scoped>
.settings-loading { min-width: 0; }
.split { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 24px; }
.facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
.connection-intro {
  display: grid;
  gap: 12px;
  margin-bottom: 12px;
}
.catalog-loading {
  container: loading-plugin-catalog / inline-size;
  display: grid;
  gap: 12px;
}
.catalog-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.catalog-tabs {
  flex: 1 1 220px;
  min-width: 0;
}
.catalog-tabs > *,
.catalog-install {
  max-width: 100%;
}
.catalog-filters {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 160px 160px 32px;
  gap: 8px;
}
.catalog-layout {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 16px;
}
.catalog-list {
  display: grid;
  align-content: start;
  gap: 8px;
  min-width: 0;
}
.catalog-card {
  min-width: 0;
  padding-left: 16px;
  border-left: 1px solid var(--line);
}
@container loading-plugin-catalog (max-width: 700px) {
  .catalog-filters {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 32px;
  }
  .catalog-filters > :first-child {
    grid-column: 1 / -1;
  }
}
@container loading-plugin-catalog (max-width: 600px) {
  .catalog-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .catalog-card {
    display: none;
  }
}
@container loading-plugin-catalog (max-width: 340px) {
  .catalog-filters {
    grid-template-columns: minmax(0, 1fr) 32px;
  }
  .catalog-filters > :nth-child(2) {
    grid-column: 1 / -1;
  }
}
@media (max-width: 600px) {
  .split { grid-template-columns: minmax(0, 1fr); }
}
</style>
