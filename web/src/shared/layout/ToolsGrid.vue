<template>
  <nav class="tools-grid" :class="{ 'tools-grid--list': layout === 'list' }" :aria-label="t('core.tools')">
    <router-link v-for="item in items" :key="item.id || item.to" v-slot="{ href, navigate, isActive }"
                 :to="item.to" custom>
      <UiActionLink
        :href="href"
        variant="ghost"
        :data-context="layout === 'list' ? 'tool-menu-item' : 'tool-tile'"
        :aria-current="isActive ? 'page' : undefined"
        :aria-label="item.label + (badges[item.to] ? ' · ' + badges[item.to]?.title : '')"
        v-tooltip="badges[item.to]?.title"
        @click="
          navigate($event);
          $emit('select', item);
        "
      >
        <span class="tool-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path :d="icons[item.icon] || icons.plugin" />
          </svg>
          <NavigationCount v-if="layout === 'grid'" :badge="badges[item.to]" />
        </span>
        <span class="tool-label">{{ item.label }}</span>
        <NavigationCount v-if="layout === 'list'" :badge="badges[item.to]" />
      </UiActionLink>
    </router-link>
  </nav>
</template>

<script setup lang="ts">
import { t, UiActionLink, vTooltip } from '../../ui.ts';

import { NAV_ICONS } from '../navIcons.ts';
import NavigationCount from './NavigationCount.vue';
import type { PropType } from 'vue';

interface ToolNavItem {
  id?: string;
  to: string;
  label: string;
  icon: string;
}

type Badge = InstanceType<typeof NavigationCount>['$props']['badge'];

const icons: Readonly<Record<string, string>> = NAV_ICONS;

defineProps({
  items: {
    type: Array as PropType<ToolNavItem[]>,
    default: () => [],
  },
  badges: {
    type: Object as PropType<Record<string, Badge>>,
    default: () => ({}),
  },
  layout: {
    type: String as PropType<'grid' | 'list'>,
    default: 'grid',
  },
});
defineEmits(['select']);
</script>

<style scoped>
.tools-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
  gap: 10px;
}

.tools-grid--list {
  grid-template-columns: minmax(0, 1fr);
  gap: 4px;
}
</style>
