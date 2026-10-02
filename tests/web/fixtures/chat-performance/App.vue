<template>
  <div class="performance-fixture">
    <ChatList />
    <ChatSession v-if="chat.activeId" :key="chat.activeId" :sid="chat.activeId" />
  </div>
</template>

<script setup>
import ChatList from '../../../../web/src/views/chat/ChatList.vue';
import ChatSession from '../../../../web/src/views/chat/ChatSession.vue';
import { useChatStore } from '../../../../web/src/stores/chat.js';

const chat = useChatStore();
</script>

<style>
html, body, #app { height: 100%; margin: 0; }
.performance-fixture { display: flex; height: 100%; }
.performance-fixture > .cs { flex: 1; min-width: 0; }
</style>
