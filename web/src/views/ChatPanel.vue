<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { storeToRefs } from 'pinia';
import { useRouter, useRoute } from 'vue-router';
import { useChatStore } from '../stores/chat.js';
import ChatTabs from './chat/ChatTabs.vue';
import ChatSession from './chat/ChatSession.vue';

const chat = useChatStore();
const router = useRouter();
const route = useRoute();
const { open, activeId } = storeToRefs(chat);
const panel = ref(null);

// На странице «Агенты» плавающий чат не нужен — там своя большая рабочая область.
const onChats = computed(() => route.name === 'chats');
// Непрочитанные чаты — на кнопке, чтобы ответ агента было видно из любого раздела.
// История уже загружена оболочкой (AppShell зовёт ensure), стор общий.
const unread = computed(() => chat.unreadCount);
watch(onChats, (v) => { if (v) chat.close(); });

// Закрытие по клику вне панели (мышью). Слушатель живёт только пока панель открыта.
function onDocDown(e) {
  if (panel.value && !panel.value.contains(e.target)) chat.close();
}
watch(open, (v) => {
  if (v) {
    chat.ensure();
    // Вешаем на следующий тик, чтобы клик-открытие само себя не закрыло.
    setTimeout(() => document.addEventListener('mousedown', onDocDown), 0);
  } else {
    document.removeEventListener('mousedown', onDocDown);
  }
});
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocDown));

function openFull() { chat.close(); router.push('/chats'); }
</script>

<template>
  <div v-if="!onChats" class="chatw">
    <Transition name="fab">
      <button v-if="!open" class="fab" :title="unread ? `Чат с агентом · непрочитанных: ${unread}` : 'Чат с агентом'"
              @click="chat.toggle()">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
          <path d="M12 2.2c.4 0 .75.26.87.64l1.9 5.9 5.9 1.9a.92.92 0 0 1 0 1.74l-5.9 1.9-1.9 5.9a.92.92 0 0 1-1.74 0l-1.9-5.9-5.9-1.9a.92.92 0 0 1 0-1.74l5.9-1.9 1.9-5.9c.12-.38.47-.64.87-.64Z" />
        </svg>
        <span v-if="unread" class="fbadge">{{ unread }}</span>
      </button>
    </Transition>

    <Transition name="pop">
      <div v-if="open" ref="panel" class="panel">
        <header class="ph">
          <ChatTabs variant="panel" />
          <div class="ph-r">
            <button class="mini" title="Открыть в разделе «Агенты»" @click="openFull">⤢</button>
            <button class="mini" title="Свернуть" @click="chat.close()">✕</button>
          </div>
        </header>
        <div class="pbody">
          <ChatSession v-if="activeId" :key="activeId" :sid="activeId" variant="panel" />
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.fab { position: fixed; right: 18px; bottom: 18px; z-index: 90; width: 52px; height: 52px; border-radius: 16px;
  display: grid; place-items: center;
  background: linear-gradient(150deg, #d97757, #c15f3c); color: #fff; border: none; cursor: pointer;
  box-shadow: 0 6px 22px #0009, inset 0 1px 0 #ffffff2e; transition: transform .12s, box-shadow .12s; }
.fab:hover { transform: translateY(-2px); box-shadow: 0 10px 28px #000a, inset 0 1px 0 #ffffff2e; }
/* Счётчик непрочитанных. Кнопка сама оранжевая, поэтому бейдж — синий акцент,
   с обводкой под фон страницы, чтобы читался на любом экране. */
.fbadge { position: absolute; top: -5px; right: -5px; min-width: 19px; height: 19px; padding: 0 5px;
  border-radius: 999px; background: var(--accent); color: #fff; font-size: 11px; font-weight: 700;
  display: grid; place-items: center; line-height: 1; box-shadow: 0 0 0 2px var(--ground); }

.panel { position: fixed; right: 18px; bottom: 18px; z-index: 95; width: min(460px, calc(100vw - 24px));
  height: min(74vh, 660px); display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--line-2); border-radius: 16px; box-shadow: 0 18px 50px #000c; overflow: hidden; }
.ph { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-bottom: 1px solid var(--line); }
.ph :deep(.tabs) { flex: 1; min-width: 0; }
.ph-r { display: flex; gap: 6px; flex: none; }
.mini { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid); border-radius: 8px; width: 30px; height: 30px; cursor: pointer; font-size: 13px; }
.mini:hover { color: var(--ink); border-color: var(--line-2); }
.pbody { flex: 1; min-height: 0; display: flex; }
.pbody :deep(.cs) { flex: 1; }

/* Анимации */
.pop-enter-active, .pop-leave-active { transition: transform .2s cubic-bezier(.2,.7,.3,1), opacity .18s; }
.pop-enter-from, .pop-leave-to { transform: translateY(14px) scale(.98); opacity: 0; }
.fab-enter-active, .fab-leave-active { transition: transform .18s, opacity .18s; }
.fab-enter-from, .fab-leave-to { transform: scale(.6); opacity: 0; }
@media (prefers-reduced-motion: reduce) { .pop-enter-active, .pop-leave-active, .fab-enter-active, .fab-leave-active { transition: none; } }

@media (max-width: 759px) {
  .fab { bottom: 74px; }
  .panel { bottom: 8px; right: 8px; left: 8px; width: auto; height: min(82vh, 640px); }
}
</style>
