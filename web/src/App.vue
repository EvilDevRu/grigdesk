<template>
  <!-- Пока не знаем состояние входа — не рисуем ничего: иначе на миг мелькает либо форма
       у вошедшего, либо интерфейс у невошедшего. -->
  <!-- На экране входа обновление остаётся доступно без AppShell: оно работает с SW,
       а не с закрытым API. После входа уведомление переезжает в штатный топбар. -->
  <UpdateBanner v-if="!auth.authenticated" standalone />
  <UiDialogHost />

  <template v-if="auth.ready">
    <LoginView v-if="!auth.authenticated" />
    <!-- Provider существует только в authenticated-ветке: logout размонтирует его
         вместе с единственным mic-controller и немедленно отзывает browser resources. -->
    <SpeechProvider v-else>
      <AppShell>
        <router-view v-slot="{ Component }">
          <component :is="Component" />
        </router-view>
      </AppShell>
      <TaskModal />
      <CompanionHost />
      <DiffModal />
      <DocumentModal />
    </SpeechProvider>
  </template>
</template>

<script setup>
import { onMounted, watch } from 'vue';
import { UiDialogHost } from './ui';
import AppShell from './shared/layout/AppShell.vue';
import LoginView from './views/LoginView.vue';
import UpdateBanner from './features/pwa/UpdateBanner.vue';
import TaskModal from './views/TaskModal.vue';
import DiffModal from './views/DiffModal.vue';
import DocumentModal from './views/DocumentModal.vue';
import CompanionHost from './features/companion/CompanionHost.vue';
import { SpeechProvider } from './features/speech/provider.js';
import { useBoardStore } from './stores/board.js';
import { useSystemStore } from './stores/system.js';
import { useAuthStore } from './stores/auth.js';
import { useTaskFavoritesStore } from './stores/task-favorites.js';
import { useTaskShelfStore } from './stores/task-shelf.js';
import { useTaskSeenStore } from './stores/task-seen.js';
import { useVideoSessionStore } from './stores/video-session.js';

const auth = useAuthStore();

// Фоновые поллинги запускаем ТОЛЬКО после входа: иначе они молотят в закрытый API,
// ловят 401 и засоряют консоль на экране логина.
function startPolling() {
  // Отметки просмотра нужны всему приложению, а не только доске: без них чип «Доска»
  // в навигации не знает, какие задачи новые, на какой бы странице человек ни стоял.
  useTaskSeenStore().load(true);
  useBoardStore().startPolling();
  useSystemStore().startPolling();
  useTaskShelfStore().start();
}

onMounted(async () => {
  // Одноразовая best-effort уборка настройки удалённой плавающей панели. Ключ
  // полноразмерного composer-а не трогаем: его высота по-прежнему нужна /chats.
  try { localStorage.removeItem('cockpit-chat-panel-composer-h'); } catch { /* storage может быть недоступен */ }
  auth.watchUnauthorized();
  await auth.load();
  if (auth.authenticated) startPolling();
});

// Вошли позже (через форму) — поднимаем поллинги тогда. Потеряли сессию — гасим:
// иначе интервалы продолжают долбить закрытый API и сыплют 401 в консоль на экране входа.
watch(() => auth.authenticated, (on, was) => {
  if (on && !was) startPolling();
  if (!on && was) {
    useBoardStore().stopPolling();
    useSystemStore().stopPolling();
    useTaskFavoritesStore().clear();
    useTaskShelfStore().stop();
    useTaskShelfStore().clear();
    useTaskSeenStore().clear();
    // Разбор встречи набран человеком и потому переживает выход, а вот его поллинг —
    // нет: без сессии он молотил бы в закрытый API теми же 401 каждые две секунды.
    useVideoSessionStore().stopPoll();
  }
});
</script>
