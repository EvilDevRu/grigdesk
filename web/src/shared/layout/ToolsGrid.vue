<template>
  <nav class="tools-grid" aria-label="Инструменты">
    <router-link v-for="item in items" :key="item.id || item.to" :to="item.to"
                 :aria-label="item.label + (badges[item.to] ? ' · ' + badges[item.to].title : '')"
                 v-tooltip="badges[item.to]?.title" class="tool-tile" active-class="active" @click="$emit('select', item)">
      <span class="tool-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path :d="NAV_ICONS[item.icon] || NAV_ICONS.plugin" />
        </svg>
        <NavigationCount :badge="badges[item.to]" />
      </span>
      <span>{{ item.label }}</span>
    </router-link>
  </nav>
</template>

<script setup>
import { NAV_ICONS } from '../navIcons.ts';
import { vTooltip } from '../../ui';
import NavigationCount from './NavigationCount.vue';

defineProps({
  items: { type: Array, default: () => [] },
  badges: { type: Object, default: () => ({}) },
});
defineEmits(['select']);
</script>

<style scoped>
.tools-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); gap: 10px; }
.tool-tile { min-width: 0; min-height: 104px; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 10px; padding: 14px 10px; border: 1px solid var(--line); border-radius: 12px;
  background: var(--surface); color: var(--ink-mid); text-align: center; font-size: 13px; }
.tool-tile:hover { color: var(--ink); border-color: var(--line-2); background: var(--surface-2); }
.tool-tile.active { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 42%, var(--line)); }
.tool-icon { display: grid; justify-items: center; gap: 1px; }
.tool-icon svg { width: 28px; height: 28px; }
</style>
