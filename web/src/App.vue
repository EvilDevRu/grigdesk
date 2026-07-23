<script setup>
import { onMounted } from 'vue';
import AppShell from './shared/layout/AppShell.vue';
import TaskModal from './views/TaskModal.vue';
import ChatPanel from './views/ChatPanel.vue';
import { useBoardStore } from './stores/board.js';
import { useSystemStore } from './stores/system.js';

// Фоновый прогрев кешей: доска подтягивается периодически (мгновенный показ при
// переходе), нагрузка ПК — часто для индикатора.
onMounted(() => {
  useBoardStore().startPolling();
  useSystemStore().startPolling();
});
</script>

<template>
  <AppShell>
    <router-view v-slot="{ Component }">
      <component :is="Component" />
    </router-view>
  </AppShell>
  <TaskModal />
  <ChatPanel />
</template>
