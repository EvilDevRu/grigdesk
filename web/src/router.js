import { createRouter, createWebHashHistory } from 'vue-router';

// Hash-history — чтобы SPA работал при отдаче статики без серверных rewrite-правил
// (и одинаково из поддиректории, и с VPS-витрины).
const routes = [
  { path: '/', redirect: '/board' },
  { path: '/board', name: 'board', component: () => import('./views/BoardView.vue'), meta: { title: 'Доска' } },
  { path: '/pipeline', name: 'pipeline', component: () => import('./views/PipelineView.vue'), meta: { title: 'Конвейер' } },
  { path: '/agents', name: 'agents', component: () => import('./views/AgentsView.vue'), meta: { title: 'Агенты' } },
  { path: '/code', name: 'code', component: () => import('./views/CodeView.vue'), meta: { title: 'Код' } },
  { path: '/terminal', name: 'terminal', component: () => import('./views/TerminalView.vue'), meta: { title: 'Терминал' } },
  { path: '/routes', name: 'routes', component: () => import('./views/RoutesView.vue'), meta: { title: 'Маршруты' } },
  { path: '/video', name: 'video', component: () => import('./views/VideoView.vue'), meta: { title: 'Видео' } },
  { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue'), meta: { title: 'Настройки' } },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
