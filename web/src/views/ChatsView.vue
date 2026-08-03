<script setup>
import { onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useChatStore } from '../stores/chat.js';
import ChatList from './chat/ChatList.vue';
import ChatSession from './chat/ChatSession.vue';

// Рабочее место агентов в телеграм-раскладке: слева список чатов, справа активный чат.
const chat = useChatStore();
const { activeId } = storeToRefs(chat);

// На узком экране колонка одна: показываем либо список, либо открытый чат. Переключение
// держим здесь классом, а не через matchMedia в JS: раскладку и так решает CSS, второй
// источник правды о ширине экрана рассинхронизируется на поворотах и ресайзе.
// Стартуем со списка — как в мессенджерах на телефоне.
const pane = ref('list');
onMounted(() => { chat.ensure(); chat.loadConveyor(); });
</script>

<template>
  <div class="agents" :class="`m-${pane}`">
    <ChatList @open="pane = 'chat'" />
    <div class="stage">
      <ChatSession v-if="activeId" :key="activeId" :sid="activeId" variant="page" @back="pane = 'list'" />
    </div>
  </div>
</template>

<style scoped>
.agents { display: flex; height: 100%; min-height: 0;
  background: var(--surface); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.stage { flex: 1; min-width: 0; display: flex; }
.stage :deep(.cs) { flex: 1; }

/* Узкий экран (планшет-портрет и телефон): на экране только одна колонка — список либо
   чат. Кнопка «назад» в шапке чата возвращает к списку; порог 900 общий с ChatSession. */
@media (max-width: 899px) {
  .agents.m-list .stage { display: none; }
  .agents.m-chat :deep(.cl) { display: none; }
}
</style>
