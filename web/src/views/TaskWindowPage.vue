<template>
  <main class="task-window-page" aria-label="Карточка задачи Битрикс24">
    <TaskModal v-if="target && ready" presentation="document" />
    <template v-else>
      <header class="task-window-titlebar">
        <span>GrigDesk · Задача Битрикс24</span>
        <UiIconButton label="Закрыть окно" @click="closeWindow">✕</UiIconButton>
      </header>
      <UiLoadingState v-if="target" label="Подключаемся к GrigDesk…" variant="document" />
      <p v-else class="task-window-waiting" role="alert">
        Не удалось определить задачу. Закройте окно и откройте карточку снова.
      </p>
    </template>
  </main>
</template>

<script setup lang="ts">
import { onUnmounted, watch } from 'vue';
import { sseSubscribe } from '../composables/useSse.ts';
import { useAuthStore } from '../stores/auth.ts';
import { useChatStore } from '../stores/chat.ts';
import type { SurfaceTarget } from '../../../shared/desktop/surfaceContract.ts';
import { useUiStore } from '../stores/ui.ts';
import { UiIconButton, UiLoadingState } from '../ui';
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

// У окна нет системных кнопок: пока карточки нет, закрывает его собственная полоса.
function closeWindow(): void {
  window.close();
}
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
/* Полоса нужна только до появления карточки: двигает окно и даёт закрыть его. */
.task-window-titlebar {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 36px;
  padding-inline: 12px 4px;
  color: var(--ink-mid);
  background: var(--bg);
  font-size: 12px;
  -webkit-app-region: drag;
  user-select: none;
}
.task-window-titlebar > :last-child {
  -webkit-app-region: no-drag;
}
.task-window-waiting {
  padding: var(--page-gutter);
  color: var(--ink-mid);
}
</style>
