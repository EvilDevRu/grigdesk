<template>
  <!-- До проверки сессии не рисуем интерфейс или отказ: оба могут оказаться неверными
       в промежутке между созданием документа и ответом сервера. -->
  <UiDialogHost />
  <UiTooltipHost />
  <UiDesktopContextMenu v-if="desktopDocument" />
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
        <MachineWelcome v-if="!workspaceStarted && shell.present && !shell.profile" />
        <div v-else-if="!workspaceStarted" class="workspace-waiting">
          <WorkspaceLoading v-if="shell.status === 'connecting' || shell.status === 'online'"
            :label="connectionMessage" :route-name="String($route.name || '')" />
          <UiInlineMessage v-else :tone="connectionTone">
            {{ connectionMessage }}
          </UiInlineMessage>
        </div>
        <router-view v-else v-slot="{ Component }">
          <component :is="Component" />
        </router-view>
      </AppShell>
      <TaskModal v-if="!surfaceDocument" />
      <OnboardingHost v-if="!surfaceDocument" />
      <DiffModal />
      <DocumentModal />
      <MediaViewer />
      <SettingsModal v-if="settings.isOpen" />
      <UiToastHost />
      </div>
    </SpeechProvider>
    <LockOverlay v-if="shell.present && shell.status === 'locked'" />
  </template>
  <DesktopWindowControls v-if="currentDesktopMode() === 'main'" />
</template>

<script setup lang="ts">
import { useGrigdeskTasksStore } from './stores/grigdeskTasks.ts';
import { useTasksStore } from './stores/tasks.ts';
import { useUiStore } from './stores/ui.ts';
import WorkspaceLoading from './shared/layout/WorkspaceLoading.vue';
import SettingsModalLoading from './views/settings/SettingsModalLoading.vue';

import { asyncView } from './shared/asyncView.ts';
import { showSectionLoadFailure } from './shared/sectionLoadFailure.ts';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  connectionStatusText,
  connectionDetailText,
  machineProfileName,
} from '../../shared/client/clientShell.ts';
import {
  t,
  uiLocale,
  UiDialogHost,
  UiTooltipHost,
  UiDesktopContextMenu,
  UiToastHost,
  UiInlineMessage,
} from './ui';
import { clearAlertHistory, dismissAllAlerts } from './shared/alerts.ts';
import AppShell from './shared/layout/AppShell.vue';
import OnboardingHost from './shared/onboarding/OnboardingHost.vue';
import DesktopExitHost from './shared/layout/DesktopExitHost.vue';
import DesktopWindowControls from './shared/layout/DesktopWindowControls.vue';
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
import MediaViewer from './views/MediaViewer.vue';
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
import MachineWelcome from './shared/layout/MachineWelcome.vue';

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
const SettingsModal = asyncView(
  () => import('./views/settings/SettingsModal.vue'),
  SettingsModalLoading,
  () => {
    settings.dispose('load-failed');
    showSectionLoadFailure();
  },
);

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
    reload: () => Promise.allSettled([favorites.load(true), seen.load(true),
      favorites.own.load(true), seen.own.load(true)]),
  });
  const stopSync = startTaskWindowSync({
    channel: new BroadcastChannel('grigdesk-task-data-v1'),
    stores: [
      { store: favorites, actions: ['setFavorite'] },
      { store: seen, actions: ['markSeen'] },
      { store: useTaskFavoritesStore().own as unknown as typeof favorites, actions: ['setFavorite'] },
      { store: useTaskSeenStore().own as unknown as typeof seen, actions: ['markSeen'] },
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
    sourceState: () => ({ key: board.sourceKey, suspended: board.sourceSuspended }),
    invalidate: (suspended) => board.clearSource(suspended),
    recheck: () => board.load(),
    watchInvalidation: (callback) => board.$onAction(({ name, after }) => {
      if (['clearSource', 'beginSourceChange', 'finishSourceChange'].includes(name)) {
        after(() => callback());
      }
    }),
    role: surfaceDocument ? 'mirror' : 'source',
    channel: new BroadcastChannel('grigdesk-board-v1'),
    snapshot: () => (board.data ? {
      data: JSON.parse(JSON.stringify(board.data)),
      readAt: board.readAt,
      sourceKey: board.sourceKey,
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
    apply: (data, readAt, sourceKey) => board.applySnapshot(data, readAt, sourceKey),
    mirror: (request) => board.setMirror(request),
  });

  if (surfaceDocument) {
    void board.load();
  }

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
    acknowledge: (id, source, taskSource) => shelf.acknowledge(id, { source, taskSource }),
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
  void useGrigdeskTasksStore().load();
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
  auth.stopRecovery();
  shell.stop();
});
watch(() => shell.status, (status, previous) => {
  if (shell.present && status !== 'online') {
    auth.stopRecovery();
    auth.logEpoch += 1;
    auth.logReason = 'shell-' + status;
    auth.authenticated = false;
  }

  if (shell.present && status === 'online' && previous !== 'online') {
    void auth.load('shell-online');
  }
}, { immediate: true });

// Смена машины или владельца локальной сессии снимает снимок до следующего рендера.
// Ключ Б24 отдельно проверяется локальным GET перед принятием HTTP или relay.
watch([() => shell.profile?.id, () => auth.clientScope], () => {
  useBoardStore().clearSource();
  useTaskFavoritesStore().clear();
  useTaskSeenStore().clear();
  useTaskShelfStore().clear();
  useGrigdeskTasksStore().clear();
  useTasksStore().invalidate();
  useUiStore().close();
}, { flush: 'sync' });

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
    useBoardStore().clearSource();
    useSystemStore().stopPolling();
    useTaskShelfStore().stop();
    dismissAllAlerts();

    if (!shell.present) {
      useGrigdeskTasksStore().clear();
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
  height: 100%;
  min-height: 0;
}

</style>
