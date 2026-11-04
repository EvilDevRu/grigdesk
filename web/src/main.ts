import { toolWindowText } from './shared/tools/toolWindowMessages.ts';

import './shared/legacyStorage.ts';
import { bootstrapUiLocale } from './shared/uiLocale.ts';
import { createApp, nextTick, watch } from 'vue';
import { createToolWindowCoordinator } from './stores/toolWindows.ts';
import { useDockStore } from './stores/dock.ts';
import { useUiContextStore } from './stores/uiContext.ts';
import { useChatStore } from './stores/chat.ts';
import { getToolPanelPorts, nativeToolId, registryToolId } from './shared/tools/toolWindowState.ts';
import { shellAction } from './shared/shellClient.ts';
import { recordOrNull } from '../../shared/lib/objects.ts';
import { viewportCanDock } from './shared/tools/viewport.ts';
import { installPluginRuntime } from './pluginRuntime/bootstrap.ts';

import { createPinia } from 'pinia';
import { router } from './router.ts';
import { useDeviceStore } from './stores/device.ts';
import { useAuthStore } from './stores/auth.ts';
import { api, isReportedApiError, setApiLogSink } from './shared/apiClient.ts';
import { setWebDiagnosticSink } from './shared/webDiagnostics.ts';
import { resetApiDiagnostics } from './shared/apiDiagnostics.ts';
import { setSseLogSink, configureSseRelay, sseSubscribe } from './composables/useSse.ts';
import { currentDesktopMode } from './shared/desktopSettings.ts';
import { parseMainRequest } from '../../shared/desktop/surfaceContract.ts';
import { useUiStore } from './stores/ui.ts';
import { createWebLogRuntime } from './shared/webLogRuntime.ts';
import { getUiLayerDiagnostics, subscribeUiLayerDiagnostics, setUiDownloadAdapter } from './ui.ts';
import { canSaveInShell, saveLinkedFile } from './shared/saveFile.ts';
import {
  installSettingsRouteGuard,
  installSettingsOpenListener,
} from './shared/settingsNavigation.ts';
import { useSettingsStore } from './stores/settings.ts';
import { showSectionLoadFailure } from './shared/sectionLoadFailure.ts';
import App from './App.vue';
import { useShellStore } from './stores/shell.ts';
import { installBrowserHostRuntime } from './shared/browser/browserHostRuntime.ts';
import { installBackAction } from './shared/backAction.ts';
import { installAppViewport } from './shared/appViewport.ts';
import './styles/index.css';
// Системные плагины веба регистрируют свои размещения в слотах до первой отрисовки.
import './plugins/index.ts';

declare global {
  interface Window {
    grigdeskToolClosed?: (value: unknown) => void;
    grigdeskSurfaceMain?: (request: unknown) => Promise<boolean>;
  }
}

const SSE_RELAY_ROLES = {
  main: 'source',
  surface: 'mirror',
  page: 'off',
} as const;

configureSseRelay(SSE_RELAY_ROLES[currentDesktopMode()]);

const pinia = createPinia();
const app = createApp(App);
const removeUiLocale = bootstrapUiLocale({ window, shell: useShellStore(pinia) });
let logStorage: Storage | null = null;

try {
  logStorage = window.sessionStorage;
} catch {
  /* storage может быть отключён */
}

// Журнал окна ставится до router, stores и mount: первый сбой тоже попадает в него.
const webLog = createWebLogRuntime({
  app,
  router,
  pinia,
  win: window,
  doc: document,
  fetch: (url, init) => window.fetch(url, init),
  url: api.url('/api/web-log'),
  routesUrl: api.url('/api/web-log/routes'),
  storage: logStorage,
  policyUrl: api.url('/api/settings/factory-debug?scope=global'),
  policySse: true,
  beacon: (url, body) => navigator.sendBeacon(url, body),
  isReportedError: isReportedApiError,
  layers: { get: getUiLayerDiagnostics, subscribe: subscribeUiLayerDiagnostics },
});

setApiLogSink((event, data) => webLog.recordApi(event, data), () => webLog.log.level() === 'verbose');
setWebDiagnosticSink((event, data) => webLog.log.record(event, data));

const stopApiDiagnosticPolicy = webLog.log.subscribeLevel(resetApiDiagnostics);

setSseLogSink((event, data) => {
  if (event === 'sse.hello' && (typeof data.boot === 'string' || data.boot === null)) {
    webLog.setBoot(data.boot);
  }

  webLog.log.record(event, data);
});
app.use(pinia);

const removePluginRuntime = installPluginRuntime(pinia, router, {
  chat: useChatStore(pinia),
  subscribe: sseSubscribe,
});

setUiDownloadAdapter({ available: canSaveInShell, save: saveLinkedFile });
webLog.attachAuthStore(useAuthStore(pinia));

const settings = useSettingsStore(pinia);
const removeSettingsGuard = installSettingsRouteGuard(router, settings);
const removeSettingsListener = installSettingsOpenListener(window,
  (request) => settings.requestOpen(request));

const removeRouteError = router.onError(showSectionLoadFailure);

const removeBackAction = installBackAction(router, () => {
  const shell = useShellStore(pinia);

  if (!shell.showConnections) {
    return false;
  }

  shell.showConnections = false;

  return true;
});
const removeAppViewport = installAppViewport();

/**
 * Native передаёт только закрытое назначение в текущий авторизованный main.
 * Подтверждение ждёт загрузки маршрута, чтобы карточка не закрылась раньше перехода.
 */
function installSurfaceMainHandler() {
  if (currentDesktopMode() !== 'main') {
    return () => {};
  }

  const allowed = () => {
    const auth = useAuthStore(pinia);
    const shell = useShellStore(pinia);

    return auth.ready && auth.authenticated && shell.initialized && shell.present
      && shell.status === 'online' && shell.capabilities.includes('windows');
  };
  /**
   * Обработчик отвечает после завершения перехода и повторной проверки доступа.
   * Отказ маршрута сохраняет открытый документ карточки и его черновик.
   */
  const handler = async (value: unknown): Promise<boolean> => {
    const request = parseMainRequest(value);

    if (!request || !allowed()) {
      return false;
    }

    try {
      if (request.destination === 'pipeline') {
        await router.push('/pipeline');

        return allowed() && router.currentRoute.value.path === '/pipeline';
      }

      useUiStore(pinia).openTaskInline(request.target.id, request.target.source);
      await nextTick();

      return allowed();
    } catch {
      return false;
    }
  };

  window.grigdeskSurfaceMain = handler;

  return () => {
    if (window.grigdeskSurfaceMain === handler) {
      delete window.grigdeskSurfaceMain;
    }
  };
}

const removeSurfaceMain = installSurfaceMainHandler();
let toolCoordinator: ReturnType<typeof createToolWindowCoordinator> | null = null;

const removeToolWatch = watch(() => {
  const auth = useAuthStore(pinia);
  const shell = useShellStore(pinia);

  return shell.capabilities.includes('windows') && auth.ready ? auth.clientScope : null;
}, async (scope) => {
  if (currentDesktopMode() !== 'main') {
    return;
  }

  toolCoordinator?.dispose();
  toolCoordinator = null;

  if (scope === null) {
    return;
  }

  const dock = useDockStore(pinia);
  const control = async (body: unknown) => shellAction('POST', '/surfaces/tool', body);

  toolCoordinator = createToolWindowCoordinator({
    origin: location.origin,
    scope,
    epoch: crypto.randomUUID(),
    dock,
    context: useUiContextStore(pinia),
    channel: new BroadcastChannel('grigdesk-tool-windows-v1'),
    router,
    canDock: viewportCanDock,
    chat: useChatStore(pinia),
    allowed: () => useAuthStore(pinia).authenticated && useShellStore(pinia).status === 'online',
    native: {
/**
 * Отправляет создание один раз, а потерянный ответ оставляет неизвестным исходом.
 * Сверка native status не должна превращаться в повтор POST открытия.
 */
      async open(id) {
        try {
          return recordOrNull(await control({ action: 'open', id: nativeToolId(id) })) ?? {};
        } catch {
          return { status: 'unknown' };
        }
      },
      async status() {
        const result = await control({ action: 'status' });

        return Array.isArray(result) ? result.flatMap((value) => {
          const item = recordOrNull(value);

          return typeof item?.id === 'string' && typeof item.instance === 'string'
            ? [{ id: registryToolId(item.id), instance: item.instance }] : [];
        }) : [];
      },
      async focus(id, instance) {
        return recordOrNull(await control({
          action: 'focus',
          id: nativeToolId(id),
          instance,
        }))
          ?.focused === true;
      },
      async close(id, instance) {
        return recordOrNull(await control({
          action: 'close',
          id: nativeToolId(id),
          instance,
        }))
          ?.closed === true;
      },
    },
    panels: {
      async exportState(id) {
        const ports = getToolPanelPorts(dock);

        if (!ports) {
          throw new Error(toolWindowText('toolSourceNotReady'));
        }

        return ports.exportState(id);
      },
      async unmount(id) {
        await getToolPanelPorts(dock)?.unmount(id);
      },
      async mount(id, state) {
        await getToolPanelPorts(dock)?.mount(id, state);
      },
    },
  });
  await toolCoordinator.reconcile(true);
}, { flush: 'post' });

const reconcileToolWindows = () => {
  void toolCoordinator?.reconcile();
};

window.addEventListener('focus', reconcileToolWindows);

window.grigdeskToolClosed = (value) => {
  const item = recordOrNull(value);

  if (typeof item?.id === 'string' && typeof item.instance === 'string') {
    toolCoordinator?.closed({ id: registryToolId(item.id), instance: item.instance });
  }
};

const removeBrowserHost = installBrowserHostRuntime(pinia);

app.use(router).mount('#app');
import.meta.hot?.dispose(() => {
  removeBrowserHost();
  removePluginRuntime();
  setApiLogSink(null);
  setWebDiagnosticSink(null);
  stopApiDiagnosticPolicy();
  setUiDownloadAdapter(null);
  setSseLogSink(null);
  webLog.dispose();
  removeSettingsGuard();
  removeSettingsListener();
  removeRouteError();
  removeBackAction();
  removeAppViewport();
  removeUiLocale();
  removeSurfaceMain();
  removeToolWatch();
  window.removeEventListener('focus', reconcileToolWindows);
  toolCoordinator?.dispose();
  delete window.grigdeskToolClosed;
  configureSseRelay('off');
});

const device = useDeviceStore(pinia);

// Настройка Screen Wake Lock действует на корне SPA: смена страницы её не сбрасывает,
// а после возвращения из фона стор запрашивает блокировку повторно.
device.initWakeLock();
// Permission только синхронизируем. Сам запрос идёт по кнопке в настройках — браузеру
// для него обязательно нужно явное действие пользователя.
device.initNotifications();
