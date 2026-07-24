<script setup>
import { onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useChatStore } from '../stores/chat.js';
import ChatList from './chat/ChatList.vue';
import ChatSession from './chat/ChatSession.vue';

// Рабочее место агентов в телеграм-раскладке: слева список чатов, справа активный чат.
const chat = useChatStore();
const { activeId } = storeToRefs(chat);

onMounted(() => { chat.ensure(); chat.loadConveyor(); });
</script>

<template>
  <div class="agents">
    <ChatList />
    <div class="stage">
      <ChatSession v-if="activeId" :key="activeId" :sid="activeId" variant="page" />
    </div>
  </div>
</template>

<style scoped>
.agents { display: flex; height: 100%; min-height: 0;
  background: var(--surface); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.stage { flex: 1; min-width: 0; display: flex; }
.stage :deep(.cs) { flex: 1; }
</style>
