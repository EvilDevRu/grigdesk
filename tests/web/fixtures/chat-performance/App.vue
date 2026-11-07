<template>
  <div class="performance-fixture">
    <ChatList />
    <ChatSession v-if="chat.activeId" :key="chat.activeId" :sid="chat.activeId" />
  </div>
</template>

<script setup>
import { onUnmounted, watch } from 'vue';
import ChatList from '../../../../web/src/views/chat/ChatList.vue';
import ChatSession from '../../../../web/src/views/chat/ChatSession.vue';
import { useChatStore } from '../../../../web/src/stores/chat.ts';

const chat = useChatStore();
const surface = chat.registerSurface('performance-fixture');

watch(() => chat.activeId, (chatId) => {
  surface.update({ chatId, visible: true });
}, { immediate: true });
onUnmounted(() => surface.dispose());
</script>

<style>
html, body, #app { height: 100%; margin: 0; }
.performance-fixture { display: flex; height: 100%; }
.performance-fixture > .cs { flex: 1; min-width: 0; }
</style>
