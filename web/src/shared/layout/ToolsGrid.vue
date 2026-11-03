<template>
  <nav class="tools-grid" data-ui-tools :class="{
    'tools-grid--list': layout === 'list',
    'tools-grid--grouped': groups.length > 0,
  }" :aria-label="t('core.tools')"
       :tabindex="searchable ? -1 : undefined">
    <UiSearchInput
      v-if="searchable"
      v-model="query"
      :aria-label="t('core.sectionsSearch')"
      :placeholder="t('core.sectionsSearch')"
    />
    <p v-if="searchable && !visibleItems.length" role="status">
      {{ t('core.sectionsEmpty') }}
    </p>
    <section v-for="group in visibleGroups" :key="group.id" class="tools-grid__group"
             :aria-label="group.label || undefined">
      <h2 v-if="group.label" class="tools-grid__group-title">{{ group.label }}</h2>
      <div class="tools-grid__items">
        <router-link v-for="item in group.items" :key="item.id || item.to" v-slot="{ href, navigate, isActive }"
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
                <path :d="navIconPath(item.icon)" />
              </svg>
              <NavigationCount v-if="layout === 'grid'" :badge="badges[item.to]" />
            </span>
            <span class="tool-label">{{ item.label }}</span>
            <NavigationCount v-if="layout === 'list'" :badge="badges[item.to]" />
          </UiActionLink>
        </router-link>
      </div>
    </section>
  </nav>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import { t, UiActionLink, UiSearchInput, vTooltip } from '../../ui.ts';

import { navIconPath } from '../navIcons.ts';
import NavigationCount from './NavigationCount.vue';
import type { PropType } from 'vue';

interface ToolNavItem {
  id?: string;
  to: string;
  label: string;
  icon: string;
  section?: string;
}

interface ToolNavGroup {
  id: string;
  label: string;
}

type Badge = InstanceType<typeof NavigationCount>['$props']['badge'];

const props = defineProps({
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
  groups: {
    type: Array as PropType<ToolNavGroup[]>,
    default: () => [],
  },
  searchable: {
    type: Boolean,
    default: false,
  },
});

defineEmits(['select']);

const query = ref('');
const visibleItems = computed(() => {
  const needle = props.searchable ? query.value.trim().toLocaleLowerCase() : '';

  return needle
    ? props.items.filter((item) => item.label.toLocaleLowerCase().includes(needle))
    : props.items;
});
const visibleGroups = computed(() => {
  if (!props.groups.length) {
    return [{
      id: '',
      label: '',
      items: visibleItems.value,
    }];
  }

  return props.groups.map((group) => ({
    ...group,
    items: visibleItems.value.filter((item) => item.section === group.id),
  })).filter((group) => group.items.length > 0);
});
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

.tools-grid__group,
.tools-grid__items {
  display: contents;
}

.tools-grid--grouped {
  gap: 24px;
}

.tools-grid--grouped .tools-grid__group {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.tools-grid--grouped .tools-grid__items {
  display: grid;
  gap: 2px;
  min-width: 0;
}
</style>
