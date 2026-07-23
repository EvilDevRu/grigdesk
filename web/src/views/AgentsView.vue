<script setup>
import { onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useChatStore } from '../stores/chat.js';
import ChatTabs from './chat/ChatTabs.vue';
import ChatSession from './chat/ChatSession.vue';

// Рабочее место агентов: много вкладок (как в VS Code), в каждой — свой чат/задача.
const chat = useChatStore();
const { activeId } = storeToRefs(chat);

onMounted(() => { chat.ensure(); chat.loadConveyor(); });
</script>

<template>
  <div class="agents">
    <ChatTabs variant="page" />
    <div class="stage">
      <ChatSession v-if="activeId" :key="activeId" :sid="activeId" variant="page" />
    </div>
  </div>
</template>

<style scoped>
.agents { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.stage { flex: 1; min-height: 0; display: flex;
  background: var(--surface); border: 1px solid var(--line); border-radius: 0 12px 12px 12px; overflow: hidden; }
.stage :deep(.cs) { flex: 1; }
</style>
