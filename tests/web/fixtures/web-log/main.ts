import { createApp, defineComponent, h } from 'vue';
import { createPinia, defineStore } from 'pinia';
import { createRouter, createWebHashHistory } from 'vue-router';

import App from './App.vue';
import { api, isReportedApiError, setApiLogSink } from '../../../../web/src/shared/apiClient.ts';
import { createWebLogRuntime } from '../../../../web/src/shared/webLogRuntime.ts';
import { getUiLayerDiagnostics, registerUiLayer, subscribeUiLayerDiagnostics }
  from '../../../../web/src/services/layers/stack.ts';

// Изолированный стенд общего журнала: настоящие ядро, транспорт, ловушки и
// API-клиент, но свой приёмник и никаких данных рабочего Кокпита.
const RouteBody = defineComponent({ render: () => h('div', 'Маршрут') });
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: RouteBody },
    { path: '/chats', component: RouteBody },
  ],
});
const pinia = createPinia();
const FailMount = defineComponent({
  name: 'FixtureFailMount',
  render() {
    throw new Error('synthetic_mount_failure');
  },
});
const app = createApp(new URLSearchParams(location.search).has('fail') ? FailMount : App);
const useAuth = defineStore('fixture-auth', {
  state: () => ({
    ready: false,
    authenticated: false,
    logEpoch: 0,
    logConfirmation: 0,
    logReason: 'load',
  }),
});
const useFixture = defineStore('fixture', {
  actions: {
    explode() {
      throw new TypeError('synthetic_store_failure');
    },
    async loadItem(id: string) {
      return api.get(`/api/fixture/items/${id}?token=secret`);
    },
  },
});
let registeredLayer: ReturnType<typeof registerUiLayer> | null = null;

const runtime = createWebLogRuntime({
  app,
  router,
  pinia,
  win: window,
  doc: document,
  fetch: (url, init) => window.fetch(url, init),
  url: '/api/web-log',
  routesUrl: '/api/web-log/routes',
  policyUrl: '/api/settings/factory-debug?scope=global',
  storage: window.sessionStorage,
  beacon: (url, body) => navigator.sendBeacon(url, body),
  isReportedError: isReportedApiError,
  layers: { get: getUiLayerDiagnostics, subscribe: subscribeUiLayerDiagnostics },
});

setApiLogSink((event, data) => runtime.recordApi(event, data));
app.use(pinia);

const auth = useAuth(pinia);

runtime.attachAuthStore(auth);

let mountFailed = false;

try {
  app.use(router).mount('#app');
} catch {
  mountFailed = true;
}

auth.ready = true;
auth.authenticated = true;
auth.logConfirmation += 1;

(window as unknown as { __webLogFixture: unknown }).__webLogFixture = {
  runtime,
  mountFailed,
  navigate: (path: string) => router.push(path),
  storeFailure: () => useFixture(pinia).explode(),
  apiFailure: () => useFixture(pinia).loadItem('private-42').catch(() => undefined),
  openLayer() {
    registeredLayer = registerUiLayer('fixture-layer', { name: 'dialog', close: () => true });
  },
  closeLayer() {
    registeredLayer?.unregister();
    registeredLayer = null;
  },
  dispose() {
    registeredLayer?.unregister();
    setApiLogSink(null);
    runtime.dispose();
  },
};
