<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { usePluginsStore } from '../stores/plugins.js';
import ToolsGrid from '../shared/layout/ToolsGrid.vue';

const plugins = usePluginsStore();
const router = useRouter();
if (!plugins.loaded) plugins.load();
const items = computed(() => plugins.toolsNav.filter((item) => router.resolve(item.to).matched.length));
const badges = {};
</script>

<template>
  <div class="tools-page">
    <p class="hint">Редкие рабочие разделы собраны здесь, чтобы основная навигация оставалась короткой.</p>
    <ToolsGrid v-if="items.length" :items="items" :badges="badges" />
    <div v-else class="empty">Включённых инструментов с отдельными страницами пока нет.</div>
  </div>
</template>

<style scoped>
.tools-page { max-width: 820px; margin: 0 auto; }
.hint { margin: 0 0 16px; color: var(--ink-mid); font-size: 13px; }
.empty { padding: 42px 16px; color: var(--ink-mid); text-align: center; }
</style>
