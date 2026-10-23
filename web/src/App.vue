<template>
  <!-- До проверки сессии не рисуем интерфейс или отказ: оба могут оказаться неверными
       в промежутке между созданием документа и ответом сервера. -->
  <UiDialogHost />
  <UiTooltipHost />
  <DesktopExitHost v-if="currentDesktopMode() === 'main'" />

  <template v-if="shell.initialized">
    <ConnectionsView v-if="showMachines" />
    <NoAccessView v-else-if="!shell.present && auth.ready && !auth.authenticated" />
    <!-- Речь принадлежит рабочему документу и сохраняет один controller при потере связи.
         Без оболочки потеря входа размонтирует Provider и освобождает browser resources. -->
    <SpeechProvider v-else-if="shell.present || auth.authenticated">
      <div class="shell-workspace" :inert="shell.present && shell.status === 'locked' ? true : undefined">
      <ToolWindowPage v-if="surfaceDocument && surfaceTarget?.kind === 'tool'"
                      :target="surfaceTarget" :ready="surfaceStarted" />
      <TaskWindowPage v-else-if="surfaceDocument" :target="surfaceTarget" :ready="surfaceStarted" />
      <AppShell v-else :active="auth.authenticated && (!shell.present || shell.status === 'online')">
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
      <TaskModal v-if="!surfaceDocument" />
      <DiffModal />
      <DocumentModal />
      <SettingsModal v-if="settings.isOpen" />
      <UiToastHost />
      </div>
    </SpeechProvider>
    <LockOverlay v-if="shell.present && shell.status === 'locked'" />
  </template>
</template>

<script setup lang="ts">
import { asyncView } from './shared/asyncView.ts';
import { showSectionLoadFailure } from './shared/sectionLoadFailure.ts';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  connectionStatusText,
  connectionDetailText,
  machineProfileName,
} from '../../shared/client/clientShell.ts';
import { t, uiLocale, UiDialogHost, UiTooltipHost, UiToastHost, UiInlineMessage, UiSpinner } from './ui';
import { clearAlertHistory, dismissAllAlerts } from './shared/alerts.ts';
import AppShell from './shared/layout/AppShell.vue';
import DesktopExitHost from './shared/layout/DesktopExitHost.vue';
import NoAccessView from './views/NoAccessView.vue';
import TaskModal from './views/TaskModal.vue';
import ToolWindowPage from './views/ToolWindowPage.vue';
import { startToolShelfRelay } from './shared/tools/toolWindowRelay.ts';

import TaskWindowPage from './views/TaskWindowPage.vue';
import { currentDesktopMode } from './shared/desktopSettings.ts';
import { surfaceTargetFromUrl } from '../../shared/desktop/surfaceContract.ts';
import { usePluginsStore } from './stores/plugins.ts';
import { startBoardRelay, startShellRelay, startShelfRelay } from './shared/windowRelay.ts';
import { startTaskWindowSync, createQueuedReload } from './shared/taskWindowSync.ts';
import DiffModal from './views/DiffModal.vue';
import DocumentModal from './views/DocumentModal.vue';
import { SpeechProvider } from './features/speech/provider.ts';
import { useBoardStore } from './stores/board.ts';
import { useSystemStore } from './stores/system.ts';
import { useAuthStore } from './stores/auth.ts';
import { useSettingsStore } from './stores/settings.ts';
import { useTaskFavoritesStore } from './stores/taskFavorites.ts';
import { useTaskShelfStore } from './stores/taskShelf.ts';
import { useTaskSeenStore } from './stores/taskSeen.ts';
import { useVideoSessionStore } from './stores/videoSession.ts';
import { setSseEnabled, sseSubscribe } from './composables/useSse.ts';
import { useShellStore } from './stores/shell.ts';
import ConnectionsView from './views/ConnectionsView.vue';
import LockOverlay from './shared/layout/LockOverlay.vue';

const surfaceDocument = currentDesktopMode() === 'surface';
const surfaceTarget = surfaceDocument
  ? surfaceTargetFromUrl(window.location.href, window.location.origin)
  : null;
const desktopDocument = surfaceDocument || currentDesktopMode() === 'main';
// Готовность однократна: offline и повторный вход не уничтожают черновик карточки.
// Подписки устанавливаются до первого mount карточки и её отметки просмотра.
const surfaceStarted = ref(false);

if (surfaceDocument) {
  useTaskShelfStore().setPassive(true);

  if (surfaceTarget?.kind === 'tool' && surfaceTarget.id === 'shelf') {
    useTaskShelfStore().setViewMirror(true);
  }
}

const auth = useAuthStore();
const shell = useShellStore();
const showMachines = computed(() => shell.present && shell.showConnections);
const workspaceStarted = ref(auth.authenticated);
const connectionTone = computed(() => ['unpaired', 'revoked', 'identityMismatch', 'incompatible']
  .includes(shell.status) ? 'warning' : 'neutral');
const connectionMessage = computed(() => {
  const detail = connectionDetailText(shell.detail, uiLocale.value);

  if (detail) {
    return detail;
  }

  if (!shell.profile) {
    return t('core.chooseMachine');
  }

  if (shell.status === 'connecting' || shell.status === 'online') {
    return t('core.connectingMachine', { name: machineProfileName(shell.profile, uiLocale.value) });
  }

  const name = machineProfileName(shell.profile, uiLocale.value);
  const status = connectionStatusText(shell.status, uiLocale.value);

  return `${name}: ${status}.`;
});
const settings = useSettingsStore();
const SettingsModal = asyncView(() => import('./views/settings/SettingsModal.vue'), undefined, () => {
  settings.dispose('load-failed');
  showSectionLoadFailure();
});

let pollingStarted = false;
let pollingGeneration = 0;
let stopShellRelay: (() => void) | null = null;
let stopTaskWindowSync: (() => void) | null = null;

/**
 * Сигналы оболочки живут через offline, чтобы карточка могла восстановить подключение.
 * Только главное окно наблюдает ревизию long-poll, карточка делает короткий refresh.
 */
function startDocumentShellRelay() {
  if (!desktopDocument || stopShellRelay || typeof BroadcastChannel === 'undefined') {
    return;
  }

  stopShellRelay = startShellRelay({
    role: surfaceDocument ? 'mirror' : 'source',
    channel: new BroadcastChannel('grigdesk-shell-v1'),
    watchRevision: (callback) => watch(() => shell.snapshot?.rev, callback),
    refresh: () => shell.refresh(),
  });
}

/**
 * Подписки принадлежат авторизованному документу desktop и не переживают смену профиля.
 * Доской делится документ, который её прочитал; избранное и отметки перечитываются по сигналу.
 */
function startWindowSync() {
  if (stopTaskWindowSync || !desktopDocument || typeof BroadcastChannel === 'undefined') {
    return;
  }

  const board = useBoardStore();
  const favorites = useTaskFavoritesStore();
  const seen = useTaskSeenStore();
  const shelf = useTaskShelfStore();
  const refresh = createQueuedReload({
    busy: () => favorites.loading || seen.loading,
    subscribe: (callback) => watch(
      () => [favorites.loading, seen.loading],
      callback,
      { flush: 'post' },
    ),
    reload: () => Promise.allSettled([favorites.load(true), seen.load(true)]),
  });
  const stopSync = startTaskWindowSync({
    channel: new BroadcastChannel('grigdesk-task-data-v1'),
    stores: [
      { store: favorites, actions: ['setFavorite'] },
      { store: seen, actions: ['markSeen'] },
    ],
    invalidate: () => refresh.request(),
  });
  const stopShelf = surfaceDocument ? sseSubscribe((name) => {
    if (name === 'task-shelf-changed') {
      void shelf.load(true, { silent: true });
    }
  }) : () => {
  };
  const stopBoard = startBoardRelay({
    role: surfaceDocument ? 'mirror' : 'source',
    channel: new BroadcastChannel('grigdesk-board-v1'),
    snapshot: () => (board.data ? {
      data: JSON.parse(JSON.stringify(board.data)),
      readAt: board.readAt,
    } : null),
    watchLoads: (callback) => board.$onAction(({ name, after }: {
      name: string;
      after: (callback: (readAt: unknown) => void) => void;
    }) => {
      if (name === 'load') {
        after((readAt) => {
          if (typeof readAt === 'number' && readAt === board.readAt) {
            callback();
          }
        });
      }
    }),
    apply: (data, readAt) => board.applySnapshot(data, readAt),
    mirror: (request) => board.setMirror(request),
  });

  const stopToolShelf = !surfaceDocument || surfaceTarget?.id === 'shelf'
    ? startToolShelfRelay({
      role: surfaceDocument ? 'mirror' : 'source',
      channel: new BroadcastChannel('grigdesk-tool-shelf-v1'),
      store: shelf,
      instance: 'shelf-document',
    })
    : () => {};

  const stopShelfAcknowledge = surfaceDocument ? () => {} : startShelfRelay({
    role: 'source',
    channel: new BroadcastChannel('grigdesk-task-data-v1'),
    acknowledge: (id) => shelf.acknowledge(id),
  });

  stopTaskWindowSync = () => {
    stopToolShelf();
    stopShelfAcknowledge();
    stopSync();
    stopShelf();
    stopBoard();
    refresh.dispose();
  };
}
/**
 * Закрытие каналов обязательно и для browser fixture, и при потере входа.
 * Старый disposer не должен удерживать живые Node/browser resources.
 */
function stopWindowSync() {
  stopTaskWindowSync?.();
  stopTaskWindowSync = null;
}



/**
 * Фоновые источники запускаются только после входа, чтобы не читать закрытый API.
 * Карточка принимает снимки и пассивную полку, главным поллингом владеет основной документ.
 */
function startPolling() {
  if (pollingStarted) {
    return;
  }

  pollingStarted = true;

  const generation = ++pollingGeneration;

  // Отметки просмотра нужны всему приложению, а не только доске: без них чип «Доска»
  // в навигации не знает, какие задачи новые, на какой бы странице человек ни стоял.
  useTaskSeenStore().load(true);
  startWindowSync();

  if (surfaceDocument) {
    surfaceStarted.value = true;
    void Promise.resolve(usePluginsStore().load()).then(() => {
      if (pollingStarted && generation === pollingGeneration && auth.authenticated) {
        return useTaskShelfStore().load(true, { silent: true });
      }
    }).catch(() => undefined);

    return;
  }

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
  startDocumentShellRelay();
  await shell.start(surfaceDocument ? { poll: false } : undefined);

  if (!shell.present) {
    await auth.load();
  }

  if (auth.authenticated) {
    settings.setAuthenticated(true);
    startPolling();
  }
});

onBeforeUnmount(() => {
  pollingGeneration += 1;
  pollingStarted = false;
  stopWindowSync();
  stopShellRelay?.();
  shell.stop();
});
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
    stopWindowSync();
    pollingGeneration += 1;
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
