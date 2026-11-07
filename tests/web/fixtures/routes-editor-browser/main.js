import { createApp, h } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHashHistory, RouterView } from 'vue-router';

import RoutesView from '../../../../web/src/views/RoutesView.vue';
import { useRoutesStore } from '../../../../web/src/stores/routes.ts';
import '../../../../web/src/styles/index.css';

// Только синтетический браузерный стенд: измеряем количество общих SSE,
// не подменяя саму реализацию транспорта в продукте.
const Source = window.EventSource;
const sources = { created: 0, active: 0, peak: 0 };
window.EventSource = class extends Source {
  constructor(...args) {
    super(...args);
    sources.created += 1;
    sources.active += 1;
    sources.peak = Math.max(sources.peak, sources.active);
    this.addEventListener('error', () => {
      // Native EventSource сам переподключается; это всё ещё один экземпляр.
    });
  }

  close() {
    if (this.readyState !== Source.CLOSED) sources.active -= 1;
    super.close();
  }
};

const pinia = createPinia();
const router = createRouter({ history: createWebHashHistory(), routes: [
  { path: '/routes', component: RoutesView },
  { path: '/:pathMatch(.*)*', redirect: '/routes' },
] });
const app = createApp({ render: () => h(RouterView) });
app.use(pinia);
app.use(router);
app.mount('#app');

window.__routesEditorFixture = { router, sources,
  get store() { return useRoutesStore(pinia); },
  async monacoModels() {
    const { monaco } = await import('../../../../web/src/shared/monaco.ts');
    return monaco.editor.getModels().length;
  },
};
