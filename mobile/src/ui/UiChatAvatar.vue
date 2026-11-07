<template>
  <span
    class="row-avatar chat-avatar"
    :data-running="running || undefined"
    :style="provider?.color ? { '--prov': provider.color } : undefined"
    :aria-label="label"
    role="img"
  >
    <svg
      v-if="icon"
      class="provider-icon"
      :viewBox="icon.viewBox"
      :fill="icon.stroke ? 'none' : 'currentColor'"
      :stroke="icon.stroke ? 'currentColor' : 'none'"
      stroke-width="2.4"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path v-for="(path, index) in icon.paths" :key="index" :d="path" />
    </svg>
    <span v-else aria-hidden="true">{{ initial(provider?.name || title) }}</span>
    <svg v-if="running" class="chat-live-ring" viewBox="0 0 44 44" aria-hidden="true">
      <circle cx="22" cy="22" r="21" />
      <circle class="chat-live-arc" cx="22" cy="22" r="21" />
    </svg>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { ChatProvider } from '../api/contract.ts';
import { initial } from './format.ts';
import { providerIcons } from './providerIcons.ts';

const props = defineProps<{
  title: string;
  provider?: ChatProvider;
  running?: boolean;
}>();
const icon = computed(() => providerIcons[props.provider?.id || '']);
const label = computed(() =>
  [props.provider?.name || props.title, props.running ? 'Агент работает' : ''].filter(Boolean).join(' · '),
);
</script>
