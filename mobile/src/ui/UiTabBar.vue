<template>
  <nav class="app-nav" aria-label="Разделы">
    <div class="app-nav-brand" aria-hidden="true">
      <UiBrandMark class="brand-mark" />
      <span class="app-brand-name">Кокпит</span>
    </div>
    <RouterLink
      v-for="tab in tabs"
      :key="tab.path"
      :to="tab.path"
      class="app-nav-item"
      :class="{ 'is-active': active(tab) }"
      :aria-current="active(tab) ? 'page' : undefined"
      :aria-label="tab.title"
    >
      <span class="app-nav-icon">
        <UiIcon :name="tab.icon" />
        <span
          v-if="attention.badges[tab.path]"
          class="nav-badge"
          :data-tone="attention.badges[tab.path]!.tone"
          role="status"
          :aria-label="attention.badges[tab.path]!.label"
        >{{ Math.min(99, attention.badges[tab.path]!.count) }}{{
          attention.badges[tab.path]!.count > 99 ? '+' : ''
        }}</span>
      </span>
      <span class="app-nav-label">{{ tab.title }}</span>
    </RouterLink>
    <UiLinkStatus class="app-nav-status" />
  </nav>
</template>

<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router';

import type { IconName } from './icons.ts';
import UiBrandMark from './UiBrandMark.vue';
import UiIcon from './UiIcon.vue';
import UiLinkStatus from './UiLinkStatus.vue';
import { useAttentionStore } from '../stores/attention.ts';
import { useReload } from '../composables/useReload.ts';

type Tab = {
  path: string;
  title: string;
  icon: IconName;
  also?: string;
};

const route = useRoute();
const attention = useAttentionStore();
const tabs: Tab[] = [
  {
    path: '/chats',
    title: 'Чаты',
    icon: 'chats',
  },
  {
    path: '/tasks',
    title: 'Конвейер',
    icon: 'pipeline',
  },
  {
    path: '/b24',
    title: 'Задачи',
    icon: 'board',
  },
  {
    path: '/more',
    title: 'Настройки',
    icon: 'settings',
    also: '/relays',
  },
];

// Посредники относятся к настройкам и подсвечивают этот раздел на собственном адресе.
const active = (tab: Tab) =>
  [tab.path, tab.also].some(
    (path) => path && (route.path === path || route.path.startsWith(path + '/')),
  );

useReload(attention.load, ['chats', 'chat', 'waiting', 'tasks'], (value) => value?.kind !== 'progress');
</script>
