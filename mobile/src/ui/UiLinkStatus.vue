<template>
  <span class="link-status" :data-state="state">
    <span class="link-status-dot" aria-hidden="true"></span>
    <span class="link-status-label">{{ label }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { useLinkStore } from '../stores/link.ts';

const link = useLinkStore();
const state = computed(() => (link.network === 'online' ? 'online' : link.network || 'offline'));
const label = computed(
  () =>
    ({
      online: 'В сети',
      connecting: 'Подключение',
      waiting_vpn: 'Ждёт VPN',
    })[state.value] || 'Нет связи',
);
</script>
