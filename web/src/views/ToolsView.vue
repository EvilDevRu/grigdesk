<template>
  <UiWorkspacePage>
      <template #title><h1>{{ t('core.tools') }}</h1></template>
    <div class="tools-page">
    <p class="ui-workspace-intro">{{ t('core.toolsPageDescription') }}</p>
    <ToolsGrid v-if="items.length" :items="items" :badges="badges" />
    <div v-else class="empty">{{ t('core.noToolsWithPages') }}</div>
    </div>
  </UiWorkspacePage>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';

import { t, UiWorkspacePage } from '../ui.ts';
import { usePluginsStore } from '../stores/plugins.ts';
import ToolsGrid from '../shared/layout/ToolsGrid.vue';

const plugins = usePluginsStore();
const router = useRouter();

if (!plugins.loaded) {
  plugins.load();
}

const items = computed(() => plugins.toolsNav.filter((item: { to: string }) =>
  router.resolve(item.to).matched.length));
const badges = {};
</script>

<style scoped>
.tools-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.tools-page :deep(.tools-grid) { max-width: 1100px; }
.empty { padding: 42px 16px; color: var(--ink-mid); text-align: center; }
</style>
