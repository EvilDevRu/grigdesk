<template>
  <!-- Пока не знаем состояние входа — не рисуем ничего: иначе на миг мелькает либо форма
       у вошедшего, либо интерфейс у невошедшего. -->
  <!-- На экране входа обновление остаётся доступно без AppShell: оно работает с SW,
       а не с закрытым API. После входа тот же компонент стоит плиткой в конце рейки. -->
  <CockpitVersionTile v-if="!auth.authenticated" standalone />
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
      <DiffModal />
      <DocumentModal />
      <UiToastHost />
    </SpeechProvider>
  </template>
</template>

<script setup>
import { onMounted, watch } from 'vue';
import { UiDialogHost, UiToastHost } from './ui';
import { clearAlertHistory, dismissAllAlerts } from './shared/alerts.ts';
import AppShell from './shared/layout/AppShell.vue';
import LoginView from './views/LoginView.vue';
import CockpitVersionTile from './features/cockpit-update/CockpitVersionTile.vue';
import TaskModal from './views/TaskModal.vue';
import DiffModal from './views/DiffModal.vue';
import DocumentModal from './views/DocumentModal.vue';
import { SpeechProvider } from './features/speech/provider.js';
import { useBoardStore } from './stores/board.js';
import { useSystemStore } from './stores/system.js';
import { useAuthStore } from './stores/auth.js';
import { useTaskFavoritesStore } from './stores/task-favorites.js';
import { useTaskShelfStore } from './stores/taskShelf.ts';
import { useTaskSeenStore } from './stores/task-seen.js';
import { useVideoSessionStore } from './stores/videoSession.ts';

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
  // Одноразовая best-effort уборка настроек удалённых поверхностей: плавающей панели
  // чата и компактного компаньона. Ключ полноразмерного composer-а не трогаем: его
  // высота по-прежнему нужна /chats.
  try {
    localStorage.removeItem('cockpit-chat-panel-composer-h');
    localStorage.removeItem('cockpit-companion-device-v1');
  } catch { /* storage может быть недоступен */ }
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
    dismissAllAlerts();
    clearAlertHistory();
    useTaskSeenStore().clear();
    // Разбор встречи набран человеком и потому переживает выход, а вот его поллинг —
    // нет: без сессии он молотил бы в закрытый API теми же 401 каждые две секунды.
    useVideoSessionStore().stopPoll();
  }
});
</script>
