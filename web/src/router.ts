import { createRouter, createWebHashHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import SettingsRouteStub from './views/settings/settingsRouteStub.ts';

// Hash history сохраняет навигацию SPA при обычной отдаче статики.
// Переходы между разделами не требуют серверных rewrite-правил.
const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/board' },
  {
    path: '/3d',
    name: 'studio3d',
    component: () => import('./views/Studio3dView.vue'),
    meta: { title: '3D', tool: 'studio3d' },
  },
  {
    path: '/board',
    name: 'board',
    component: () => import('./views/BoardView.vue'),
    meta: { title: 'Доска' },
  },
  {
    path: '/pipeline',
    name: 'pipeline',
    component: () => import('./views/PipelineView.vue'),
    meta: { title: 'Конвейер' },
  },
  {
    path: '/sandboxes',
    name: 'sandboxes',
    component: () => import('./views/SandboxesView.vue'),
    meta: { title: 'Песочницы', layout: 'workspace' },
  },
  {
    path: '/showcase/:id?',
    name: 'showcase',
    component: () => import('./views/ShowcaseView.vue'),
    meta: { title: 'Презентации' },
  },
  {
    path: '/chats',
    name: 'chats',
    component: () => import('./views/ChatsView.vue'),
    meta: {
      layout: 'workspace',
      title: 'Чаты',
    },
  },
  {
    path: '/agents',
    name: 'agents',
    component: () => import('./views/AgentsView.vue'),
    meta: { title: 'Агенты', layout: 'workspace' },
  },
  {
    path: '/diff',
    name: 'diff',
    component: () => import('./views/DiffView.vue'),
    meta: {
      title: 'Диф',
      layout: 'workspace',
    },
  },
  {
    path: '/documents',
    name: 'documents',
    component: () => import('./views/DocumentsView.vue'),
    meta: { title: 'Документ' },
  },
  {
    path: '/terminal',
    name: 'terminal',
    component: () => import('./views/TerminalView.vue'),
    meta: {
      layout: 'workspace',
      title: 'Терминал',
      tool: 'terminal',
    },
  },
  {
    path: '/ssh',
    name: 'ssh',
    component: () => import('./views/SshView.vue'),
    meta: {
      layout: 'workspace',
      title: 'SSH',
      tool: 'ssh',
    },
  },
  {
    path: '/db',
    name: 'db',
    component: () => import('./views/DbView.vue'),
    meta: { title: 'Базы', tool: 'db' },
  },
  {
    path: '/docker',
    name: 'docker',
    component: () => import('./views/DockerView.vue'),
    meta: { title: 'Докер', tool: 'docker' },
  },
  {
    path: '/routes',
    name: 'routes',
    component: () => import('./views/RoutesView.vue'),
    meta: { title: 'Маршруты', layout: 'workspace' },
  },
  {
    path: '/projects/:id?',
    name: 'projects',
    component: () => import('./views/ProjectsView.vue'),
    meta: {
      title: 'Проекты',
      layout: 'workspace',
    },
  },
  {
    path: '/code',
    name: 'code',
    component: () => import('./views/CodeView.vue'),
    meta: {
      layout: 'workspace',
      title: 'Код',
      tool: 'code',
    },
  },
  {
    path: '/shelf',
    name: 'shelf',
    component: () => import('./views/ShelfView.vue'),
    meta: { title: 'Полка', tool: 'shelf' },
  },
  {
    path: '/tools',
    name: 'tools',
    component: () => import('./views/ToolsView.vue'),
    meta: { title: 'Инструменты' },
  },
  // Страница пользовательского плагина: панель-iframe ведёт ToolHost, id — из адреса.
  {
    path: '/ext/:id',
    name: 'ext',
    component: () => import('./views/ExtPluginView.vue'),
    meta: { title: 'Плагин', tool: 'ext' },
  },
  {
    path: '/video',
    name: 'video',
    component: () => import('./views/VideoView.vue'),
    meta: { title: 'Видео' },
  },
  {
    path: '/inbox',
    name: 'inbox',
    component: () => import('./views/InboxView.vue'),
    meta: { title: 'Входящие' },
  },
  {
    path: '/github',
    name: 'github',
    component: () => import('./views/GitHubView.vue'),
    meta: { title: 'GitHub' },
  },
  {
    path: '/telegram',
    name: 'telegram',
    component: () => import('./views/TelegramView.vue'),
    meta: { title: 'Телеграм' },
  },
  {
    path: '/surface',
    name: 'surface',
    component: { render: () => null },
    meta: { title: 'Карточка задачи' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: SettingsRouteStub,
    meta: { title: 'Настройки' },
  },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
