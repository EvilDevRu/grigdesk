import './shared/legacyStorage.ts';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { router } from './router.js';
import { useDeviceStore } from './stores/device.js';
import { useAuthStore } from './stores/auth.js';
import { api, isReportedApiError, setApiLogSink } from './shared/apiClient.ts';
import { setSseLogSink } from './composables/useSse.ts';
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
import { installBackAction } from './shared/backAction.ts';
import { installAppViewport } from './shared/appViewport.ts';
import './styles/index.css';
// Системные плагины веба регистрируют свои размещения в слотах до первой отрисовки.
import './plugins/index.ts';

const pinia = createPinia();
const app = createApp(App);
let logStorage = null;

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

setApiLogSink((event, data) => webLog.recordApi(event, data));
setSseLogSink((event, data) => {
  if (event === 'sse.hello') {
    webLog.setBoot(data.boot);
  }
  webLog.log.record(event, data);
});
app.use(pinia);
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

app.use(router).mount('#app');
import.meta.hot?.dispose(() => {
  setApiLogSink(null);
  setUiDownloadAdapter(null);
  setSseLogSink(null);
  webLog.dispose();
  removeSettingsGuard();
  removeSettingsListener();
  removeRouteError();
  removeBackAction();
  removeAppViewport();
});

const device = useDeviceStore(pinia);

// Настройка Screen Wake Lock действует на корне SPA: смена страницы её не сбрасывает,
// а после возвращения из фона стор запрашивает блокировку повторно.
device.initWakeLock();
// Permission только синхронизируем. Сам запрос идёт по кнопке в настройках — браузеру
// для него обязательно нужно явное действие пользователя.
device.initNotifications();
