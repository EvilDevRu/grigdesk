<template>
  <!-- До проверки сессии не рисуем интерфейс или отказ: оба могут оказаться неверными
       в промежутке между созданием документа и ответом сервера. -->
  <UiDialogHost />
  <UiTooltipHost />

  <template v-if="shell.initialized">
    <ConnectionsView v-if="showMachines" />
    <NoAccessView v-else-if="!shell.present && auth.ready && !auth.authenticated" />
    <!-- Речь принадлежит рабочему документу и сохраняет один controller при потере связи.
         Без оболочки потеря входа размонтирует Provider и освобождает browser resources. -->
    <SpeechProvider v-else-if="shell.present || auth.authenticated">
      <div class="shell-workspace" :inert="shell.present && shell.status === 'locked' ? '' : undefined">
      <AppShell :active="auth.authenticated && (!shell.present || shell.status === 'online')">
        <div v-if="!workspaceStarted" class="workspace-waiting" role="status">
          <UiInlineMessage :tone="connectionTone">
            <span class="workspace-connection-message">
              <UiSpinner v-if="shell.status === 'connecting' || shell.status === 'online'" decorative />
              {{ connectionMessage }}
            </span>
          </UiInlineMessage>
        </div>
        <router-view v-else v-slot="{ Component }">
          <component :is="Component" />
        </router-view>
      </AppShell>
      <TaskModal />
      <DiffModal />
      <DocumentModal />
      <SettingsModal v-if="settings.isOpen" />
      <UiToastHost />
      </div>
    </SpeechProvider>
    <LockOverlay v-if="shell.present && shell.status === 'locked'" />
  </template>
</template>

<script setup>
import { asyncView } from './shared/asyncView.ts';
import { showSectionLoadFailure } from './shared/sectionLoadFailure.ts';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { CONNECTION_TEXT, connectionDetailText } from '../../shared/client/clientShell.ts';
import { UiDialogHost, UiTooltipHost, UiToastHost, UiInlineMessage, UiSpinner } from './ui';
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
import { setSseEnabled } from './composables/useSse.ts';
import { useShellStore } from './stores/shell.ts';
import ConnectionsView from './views/ConnectionsView.vue';
import LockOverlay from './shared/layout/LockOverlay.vue';

const auth = useAuthStore();
const shell = useShellStore();
const showMachines = computed(() => shell.present && shell.showConnections);
const workspaceStarted = ref(auth.authenticated);
const connectionTone = computed(() => ['unpaired', 'revoked', 'identityMismatch', 'incompatible']
  .includes(shell.status) ? 'warning' : 'info');
const connectionMessage = computed(() => {
  const detail = connectionDetailText(shell.detail);

  if (detail) {
    return detail;
  }

  if (!shell.profile) {
    return 'Выберите компьютер через значок машин в верхней панели.';
  }

  if (shell.status === 'connecting' || shell.status === 'online') {
    return 'Подключаемся к «' + shell.profile.name + '». Рабочие данные появятся автоматически.';
  }

  return shell.profile.name + ': ' + CONNECTION_TEXT[shell.status] + '.';
});
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
  await shell.start();

  if (!shell.present) {
    await auth.load();
  }

  if (auth.authenticated) {
    settings.setAuthenticated(true);
    startPolling();
  }
});

onBeforeUnmount(() => shell.stop());
watch(() => shell.status, (status, previous) => {
  if (shell.present && status !== 'online') {
    auth.logEpoch += 1;
    auth.logReason = 'shell-' + status;
    auth.authenticated = false;
  }

  if (shell.present && status === 'online' && previous !== 'online') {
    void auth.load('shell-online');
  }
}, { immediate: true });

watch(() => auth.authenticated && (!shell.present || shell.status === 'online'), setSseEnabled,
  { immediate: true });

// Подтверждённый вход запускает поллинги. Потеря сессии останавливает их:
// иначе интервалы продолжают долбить закрытый API и сыплют 401 в консоль на экране входа.
watch(() => auth.authenticated, (on, was) => {
  if (on && !was) {
    workspaceStarted.value = true;
    settings.setAuthenticated(true);
    startPolling();
  }

  if (!on && was) {
    settings.dispose('auth-lost');
    pollingStarted = false;
    useBoardStore().stopPolling();
    useSystemStore().stopPolling();
    useTaskShelfStore().stop();
    dismissAllAlerts();

    if (!shell.present) {
      useTaskFavoritesStore().clear();
      useTaskShelfStore().clear();
      clearAlertHistory();
      useTaskSeenStore().clear();
    }
    // Разбор встречи набран человеком и потому переживает потерю сессии, а вот его поллинг —
    // нет: без сессии он молотил бы в закрытый API теми же 401 каждые две секунды.
    useVideoSessionStore().stopPoll();
  }
});
</script>

<style scoped>
.shell-workspace {
  display: contents;
}

.workspace-waiting {
  padding: var(--page-gutter);
}

.workspace-connection-message {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
