import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { registerSW } from 'virtual:pwa-register';
import { router } from './router.js';
import { usePwaStore } from './stores/pwa.js';
import { useAuthStore } from './stores/auth.js';
import { api, isReportedApiError, setApiLogSink } from './shared/apiClient.ts';
import { setSseLogSink } from './composables/useSse.ts';
import { createWebLogRuntime } from './shared/webLogRuntime.ts';
import { getUiLayerDiagnostics, subscribeUiLayerDiagnostics } from './ui.ts';
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
app.use(router).mount('#app');
import.meta.hot?.dispose(() => {
  setApiLogSink(null);
  setSseLogSink(null);
  webLog.dispose();
});

// Ловим предложение установки на устройство (beforeinstallprompt). Слушатель надо повесить
// как можно раньше: событие прилетает один раз на загрузку, пропустим — кнопки не будет.
const pwa = usePwaStore(pinia);
pwa.initInstall();
// Настройка Screen Wake Lock действует на корне SPA: смена страницы её не сбрасывает,
// а после возвращения из фона стор запрашивает блокировку повторно.
pwa.initWakeLock();
// Permission только синхронизируем. Сам запрос идёт по кнопке в настройках — браузеру
// для него обязательно нужно явное действие пользователя.
pwa.initNotifications();

// ВАЖНО: НЕ вешаем глобальный слушатель controllerchange с reload() — с включённым
// в DevTools «Update on reload» воркер обновляется на каждую загрузку, controllerchange
// сыпется постоянно, и такой слушатель зациклил бы перезагрузки (страница висла).
// Перезагрузку делает штатный updateSW(true) — он ставит разовый обработчик только
// при клике пользователя по «Обновить» (см. stores/pwa.js).

// Регистрация service worker: при появлении новой версии показываем баннер «Обновить».
const updateSW = registerSW({
  onNeedRefresh() {
    webLog.onSwNeedRefresh();
    usePwaStore(pinia).onNeedRefresh(updateSW);
  },
  onRegisteredSW(swUrl, r) {
    if (!r) return;
    r.addEventListener('updatefound', () => webLog.onSwUpdateFound());
    // Периодически опрашиваем сервер на новую версию, чтобы баннер появлялся сам,
    // без ручной перезагрузки страницы. Плюс проверка при возврате на вкладку.
    const check = () => { if (!document.hidden) r.update().catch(() => {}); };
    setInterval(check, 30 * 1000);
    document.addEventListener('visibilitychange', check);
  },
});
