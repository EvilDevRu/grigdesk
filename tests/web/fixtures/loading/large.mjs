import { createApp, h, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHashHistory } from 'vue-router';
import { board, boardData, shell, auth } from './largePorts.mjs';
import BoardView from '../../../../web/src/views/BoardView.vue';
import PipelineView from '../../../../web/src/views/PipelineView.vue';
import ChatsView from '../../../../web/src/views/ChatsView.vue';
import App from '../../../../web/src/App.vue';
import '../../../../web/src/styles/index.css';

const mode = new URL(location.href).searchParams.get('mode');
const workspace = mode.startsWith('workspace-');
const route = mode.endsWith('board') ? '/board' : mode.endsWith('unknown') ? '/unknown' : '/chats';
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/chats',
      name: 'chats',
      meta: { layout: 'workspace' },
      component: ChatsView
    },
    {
      path: '/board',
      name: 'board',
      meta: { title: 'Доска' },
      component: BoardView
    },
    {
      path: '/unknown',
      name: 'unknown',
      component: { render: () => h('main', 'Готово') }
    },
  ],
});

await router.push(route);
await router.isReady();

const app = createApp({
  render: () => workspace ? h(App) : h('main', {
    style: {
      padding: 'var(--page-gutter)',
      minWidth: '0',
      height: '100%',
      overflowY: 'auto',
      scrollbarGutter: 'stable',
    },
  }, h(mode === 'board' ? BoardView : PipelineView)),
});

app.use(createPinia());
app.use(router);
app.mount('#app');
window.loadingFixture = {
  async ready() {
    board.data = structuredClone(boardData);
    board.loading = false;
    await nextTick();
  },
  /**
   * Подключение открывает текущий маршрут, сохраняя удержанное чтение его данных.
   * Меняется настоящий источник готовности App, а не разметка оболочки.
   */
  async online() {
    shell.status = 'online';
    await nextTick();
    auth.authenticated = true;
    await nextTick();
  },
};
