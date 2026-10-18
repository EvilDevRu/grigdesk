<template>
  <!-- До проверки сессии не рисуем интерфейс или отказ: оба могут оказаться неверными
       в промежутке между созданием документа и ответом сервера. -->
  <UiDialogHost />
  <UiTooltipHost />

  <template v-if="auth.ready">
    <NoAccessView v-if="!auth.authenticated" />
    <!-- Provider существует только в authenticated-ветке: потеря сессии размонтирует его
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
      <SettingsModal v-if="settings.isOpen" />
      <UiToastHost />
    </SpeechProvider>
  </template>
</template>

<script setup>
import { asyncView } from './shared/asyncView.ts';
import { showSectionLoadFailure } from './shared/sectionLoadFailure.ts';
import { onMounted, watch } from 'vue';
import { UiDialogHost, UiTooltipHost, UiToastHost } from './ui';
import { clearAlertHistory, dismissAllAlerts } from './shared/alerts.ts';
import AppShell from './shared/layout/AppShell.vue';
import NoAccessView from './views/NoAccessView.vue';
import TaskModal from './views/TaskModal.vue';
import DiffModal from './views/DiffModal.vue';
import DocumentModal from './views/DocumentModal.vue';
import { SpeechProvider } from './features/speech/provider.js';
import { useBoardStore } from './stores/board.js';
import { useSystemStore } from './stores/system.js';
import { useAuthStore } from './stores/auth.js';
import { useSettingsStore } from './stores/settings.ts';
import { useTaskFavoritesStore } from './stores/task-favorites.js';
import { useTaskShelfStore } from './stores/taskShelf.ts';
import { useTaskSeenStore } from './stores/task-seen.js';
import { useVideoSessionStore } from './stores/videoSession.ts';

const auth = useAuthStore();
const settings = useSettingsStore();
const SettingsModal = asyncView(() => import('./views/settings/SettingsModal.vue'), undefined, () => {
  settings.dispose('load-failed');
  showSectionLoadFailure();
});

let pollingStarted = false;

// Фоновые поллинги запускаем ТОЛЬКО после входа: иначе они молотят в закрытый API,
// ловят 401 и засоряют консоль на экране отказа.
function startPolling() {
  if (pollingStarted) {
    return;
  }

  pollingStarted = true;

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
    localStorage.removeItem('grigdesk-chat-panel-composer-h');
    localStorage.removeItem('grigdesk-companion-device-v1');
  } catch { /* storage может быть недоступен */ }
  auth.watchUnauthorized();
  await auth.load();

  if (auth.authenticated) {
    settings.setAuthenticated(true);
    startPolling();
  }
});

// Подтверждённый вход запускает поллинги. Потеря сессии останавливает их:
// иначе интервалы продолжают долбить закрытый API и сыплют 401 в консоль на экране входа.
watch(() => auth.authenticated, (on, was) => {
  if (on && !was) {
    settings.setAuthenticated(true);
    startPolling();
  }

  if (!on && was) {
    settings.dispose('auth-lost');
    pollingStarted = false;
    useBoardStore().stopPolling();
    useSystemStore().stopPolling();
    useTaskFavoritesStore().clear();
    useTaskShelfStore().stop();
    useTaskShelfStore().clear();
    dismissAllAlerts();
    clearAlertHistory();
    useTaskSeenStore().clear();
    // Разбор встречи набран человеком и потому переживает потерю сессии, а вот его поллинг —
    // нет: без сессии он молотил бы в закрытый API теми же 401 каждые две секунды.
    useVideoSessionStore().stopPoll();
  }
});
</script>
