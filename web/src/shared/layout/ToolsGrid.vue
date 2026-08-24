<template>
  <nav class="tools-grid" aria-label="Инструменты">
    <router-link v-for="item in items" :key="item.id || item.to" :to="item.to"
                 class="tool-tile" active-class="active" @click="$emit('select', item)">
      <span class="tool-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path :d="NAV_ICONS[item.icon] || NAV_ICONS.plugin" />
        </svg>
        <span v-if="badges[item.to]" class="tile-badge" :class="badges[item.to].kind"
              role="status" :aria-label="badges[item.to].title" :title="badges[item.to].title">
          {{ badges[item.to].n > 99 ? '99+' : badges[item.to].n }}
        </span>
      </span>
      <span>{{ item.label }}</span>
    </router-link>
  </nav>
</template>

<script setup>
import { NAV_ICONS } from '../nav-icons.js';

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
.tool-icon { position: relative; display: inline-flex; }
.tool-icon svg { width: 28px; height: 28px; }
.tile-badge { position: absolute; top: -8px; right: -13px; min-width: 17px; height: 17px; padding: 0 4px;
  display: grid; place-items: center; border-radius: 999px; background: var(--accent); color: #fff;
  font-size: 9.5px; font-weight: 750; box-shadow: 0 0 0 2px var(--surface); }
.tile-badge.wait { background: var(--warn); color: #1a1206; }
.tile-badge.stall { background: var(--bad); }
</style>
