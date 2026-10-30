<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] || NAV_ICONS.settings" />
  </svg>
</template>

<script setup lang="ts">
import { NAV_ICONS } from '../../shared/navIcons.ts';

withDefaults(defineProps<{ name?: string }>(), { name: 'settings' });

const paths: Record<string, string> = {
  interface: 'M4 4h16a1 1 0 0 1 1 1v12H3V5a1 1 0 0 1 1-1z M8 21h8 M12 17v4',
  agents: NAV_ICONS.agents,
  automation: NAV_ICONS.pipeline,
  speech: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5z M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3 M8 22h8',
  connections: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
  tools: NAV_ICONS.tools,
  plugins: NAV_ICONS.plugin,
  system: 'M4 3h16v7H4z M4 14h16v7H4z M8 6.5h.01 M8 17.5h.01 M12 6.5h5 M12 17.5h5',
  search: 'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15z M16 16l5 5',
};
</script>

<style scoped>
svg {
  display: block;
  width: 20px;
  height: 20px;
  flex: none;
}
</style>
