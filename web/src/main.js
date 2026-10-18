import './shared/legacyStorage.ts';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { router } from './router.js';
import { useDeviceStore } from './stores/device.js';
import { useAuthStore } from './stores/auth.js';
import { api, isReportedApiError, setApiLogSink } from './shared/apiClient.ts';
import { setSseLogSink } from './composables/useSse.ts';
import { createWebLogRuntime } from './shared/webLogRuntime.ts';
import { getUiLayerDiagnostics, subscribeUiLayerDiagnostics, showToast } from './ui.ts';
import {
  currentDesktopMode,
  installSettingsRouteGuard,
  openSettingsWindow,
} from './shared/desktopSettings.ts';
import App from './App.vue';
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
webLog.attachAuthStore(useAuthStore(pinia));

const removeSettingsGuard = installSettingsRouteGuard(router, currentDesktopMode(), openSettingsWindow);

const removeRouteError = router.onError(() => showToast({
  id: 'section-load-failed',
  title: 'Не удалось открыть раздел. Закройте и снова запустите приложение.',
  tone: 'danger',
}));

app.use(router).mount('#app');
import.meta.hot?.dispose(() => {
  setApiLogSink(null);
  setSseLogSink(null);
  webLog.dispose();
  removeSettingsGuard();
  removeRouteError();
});

const device = useDeviceStore(pinia);

// Настройка Screen Wake Lock действует на корне SPA: смена страницы её не сбрасывает,
// а после возвращения из фона стор запрашивает блокировку повторно.
device.initWakeLock();
// Permission только синхронизируем. Сам запрос идёт по кнопке в настройках — браузеру
// для него обязательно нужно явное действие пользователя.
device.initNotifications();
