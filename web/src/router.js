import { createRouter, createWebHashHistory } from 'vue-router';

// Hash-history — чтобы SPA работал при отдаче статики без серверных rewrite-правил
// (и одинаково из поддиректории, и с VPS-витрины).
const routes = [
  { path: '/', redirect: '/board' },
  { path: '/board', name: 'board', component: () => import('./views/BoardView.vue'), meta: { title: 'Доска' } },
  { path: '/pipeline', name: 'pipeline', component: () => import('./views/PipelineView.vue'), meta: { title: 'Конвейер' } },
  { path: '/chats', name: 'chats', component: () => import('./views/ChatsView.vue'), meta: { title: 'Чаты' } },
  { path: '/agents', name: 'agents', component: () => import('./views/AgentsView.vue'), meta: { title: 'Агенты' } },
  { path: '/diff', name: 'diff', component: () => import('./views/DiffView.vue'), meta: { title: 'Диф' } },
  { path: '/documents', name: 'documents', component: () => import('./views/DocumentsView.vue'), meta: { title: 'Документ' } },
  { path: '/terminal', name: 'terminal', component: () => import('./views/TerminalView.vue'), meta: { title: 'Терминал', tool: 'terminal' } },
  { path: '/ssh', name: 'ssh', component: () => import('./views/SshView.vue'), meta: { title: 'SSH', tool: 'ssh' } },
  { path: '/routes', name: 'routes', component: () => import('./views/RoutesView.vue'), meta: { title: 'Маршруты' } },
  { path: '/projects', name: 'projects', component: () => import('./views/ProjectsView.vue'), meta: { title: 'Проекты' } },
  { path: '/code', name: 'code', component: () => import('./views/CodeView.vue'), meta: { title: 'Код', tool: 'code' } },
  { path: '/shelf', name: 'shelf', component: () => import('./views/ShelfView.vue'), meta: { title: 'Полка', tool: 'shelf' } },
  { path: '/tools', name: 'tools', component: () => import('./views/ToolsView.vue'), meta: { title: 'Инструменты' } },
  { path: '/video', name: 'video', component: () => import('./views/VideoView.vue'), meta: { title: 'Видео' } },
  { path: '/inbox', name: 'inbox', component: () => import('./views/InboxView.vue'), meta: { title: 'Входящие' } },
  { path: '/github', name: 'github', component: () => import('./views/GitHubView.vue'), meta: { title: 'GitHub' } },
  { path: '/knowledge/:id?', name: 'knowledge', component: () => import('./views/KnowledgeView.vue'), meta: { title: 'Знания' } },
  { path: '/telegram', name: 'telegram', component: () => import('./views/TelegramView.vue'), meta: { title: 'Телеграм' } },
  { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue'), meta: { title: 'Настройки' } },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
