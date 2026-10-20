<template>
  <main class="task-window-page" aria-label="Карточка задачи Битрикс24">
    <header class="task-window-titlebar">
      <span>GrigDesk · Задача Битрикс24</span>
    </header>
    <TaskModal v-if="target && ready" presentation="document" />
    <p v-else-if="target" class="task-window-waiting" role="status">Подключаемся к GrigDesk…</p>
    <p v-else role="alert">Не удалось определить задачу. Закройте окно и откройте карточку снова.</p>
  </main>
</template>

<script setup lang="ts">
import { onUnmounted, watch } from 'vue';
import { sseSubscribe } from '../composables/useSse.ts';
import { useAuthStore } from '../stores/auth.js';
import { useChatStore } from '../stores/chat.js';
import type { SurfaceTarget } from '../../../shared/desktop/surfaceContract.ts';
import { useUiStore } from '../stores/ui.js';
import TaskModal from './TaskModal.vue';

const props = defineProps<{
  target: SurfaceTarget | null;
  ready: boolean;
}>();
const ui = useUiStore();
const auth = useAuthStore();
const chat = useChatStore();
// В главном окне настройки речи загружает чат; здесь чата нет, поэтому снимок речи сверяется
// после каждого входа, после переподключения главного окна (hello) и по событию настройки.
const stopSpeech = sseSubscribe((name, data) => {
  if (name === 'speech-settings') {
    chat.setSpeechSnapshot(data);
  }
  else if (name === 'hello') {
    void chat.syncSpeech();
  }
});

watch(() => auth.authenticated, (on) => {
  if (on) {
    void chat.syncSpeech();
  }
}, { immediate: true });
onUnmounted(stopSpeech);


watch(() => props.target?.id, (id) => {
  if (id && String(ui.taskId ?? '') !== id) {
    ui.openTaskInline(id);
    document.title = 'Задача #' + id + ' — GrigDesk';
  }
}, { immediate: true });
// Закрытие карточки её действиями завершает только этот native-документ.
// Нулевая начальная задача и ошибка target не закрывают диагностическую страницу.
watch(() => ui.taskId, (id, previous) => {
  if (id === null && previous !== null) {
    window.close();
  }
});
</script>

<style scoped>
.task-window-page {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100dvh;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--surface);
}
.task-window-titlebar {
  display: flex;
  flex: none;
  align-items: center;
  height: max(36px, env(titlebar-area-height, 36px));
  padding-inline-start: calc(env(titlebar-area-x, 0px) + 12px);
  padding-inline-end: max(12px, calc(100% - env(titlebar-area-x, 0px)
    - env(titlebar-area-width, 100%)));
  color: var(--ink-mid);
  background: var(--bg);
  font-size: 12px;
  app-region: drag;
}
.task-window-waiting {
  padding: var(--page-gutter);
  color: var(--ink-mid);
}
</style>
