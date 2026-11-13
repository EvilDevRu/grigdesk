import { t } from './ui.ts';

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
    redirect: (to) => ({
      path: '/ext/studio3d',
      query: to.query,
      hash: to.hash,
    }),
  },
  {
    path: '/board',
    name: 'board',
    component: () => import('./views/BoardView.vue'),
    meta: { get title() {
      return t('core.board');
    } },
  },
  {
    path: '/pipeline',
    name: 'pipeline',
    component: () => import('./views/PipelineView.vue'),
    meta: { get title() {
      return t('core.pipeline');
    }, layout: 'workspace' },
  },
  {
    path: '/sandboxes',
    name: 'sandboxes',
    component: () => import('./views/SandboxesView.vue'),
    meta: { get title() {
      return t('core.sandboxes');
    }, layout: 'workspace' },
  },
  {
    path: '/browser',
    name: 'browser',
    component: () => import('./views/BrowserView.vue'),
    meta: {
      layout: 'workspace',
      get title() {
        return t('core.browserTitle');
      },
    },
  },
  {
    path: '/showcase/:id?',
    name: 'showcase',
    component: () => import('./views/ShowcaseView.vue'),
    meta: { get title() {
      return t('core.navShowcase');
    }, layout: 'workspace' },
  },
  {
    path: '/chats',
    name: 'chats',
    component: () => import('./views/ChatsView.vue'),
    meta: {
      layout: 'workspace',
      get title() {
        return t('settings.chats');
      },
    },
  },
  { path: '/agents', redirect: '/routes' },
  {
    path: '/diff',
    name: 'diff',
    component: () => import('./views/DiffView.vue'),
    meta: {
      get title() {
        return t('core.coreDif');
      },
      layout: 'workspace',
    },
  },
  {
    path: '/help/:id?',
    name: 'help',
    component: () => import('./views/HelpView.vue'),
    meta: {
      layout: 'workspace',
      get title() {
        return t('core.helpTitle');
      },
    },
  },
  {
    path: '/documents',
    name: 'documents',
    component: () => import('./views/DocumentsView.vue'),
    meta: { get title() {
      return t('core.coreDokument');
    } },
  },
  {
    path: '/terminal',
    name: 'terminal',
    component: () => import('./views/TerminalView.vue'),
    meta: {
      layout: 'workspace',
      get title() {
        return t('core.terminal');
      },
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
    meta: {
      get title() {
        return t('core.databases');
      },
      tool: 'db',
      layout: 'workspace',
    },
  },
  {
    path: '/docker',
    name: 'docker',
    component: () => import('./views/DockerView.vue'),
    meta: {
      get title() {
        return t('core.docker');
      },
      tool: 'docker',
      layout: 'workspace',
    },
  },
  {
    path: '/routes',
    name: 'routes',
    component: () => import('./views/RoutesView.vue'),
    meta: { get title() {
      return t('core.routes');
    }, layout: 'workspace' },
  },
  {
    path: '/projects/:id?',
    name: 'projects',
    component: () => import('./views/ProjectsView.vue'),
    meta: {
      get title() {
        return t('core.projects');
      },
      layout: 'workspace',
    },
  },
  {
    path: '/code',
    name: 'code',
    component: () => import('./views/CodeView.vue'),
    meta: {
      layout: 'workspace',
      get title() {
        return t('core.code');
      },
      tool: 'code',
    },
  },
  {
    path: '/shelf',
    name: 'shelf',
    component: () => import('./views/ShelfView.vue'),
    meta: {
      get title() {
        return t('core.shelf');
      },
      tool: 'shelf',
      layout: 'workspace',
    },
  },
  {
    path: '/tools',
    name: 'tools',
    component: () => import('./views/ToolsView.vue'),
    meta: { get title() {
      return t('core.tools');
    }, layout: 'workspace' },
  },
  // Страница пользовательского плагина: панель-iframe ведёт ToolHost, id — из адреса.
  {
    path: '/ext/:id',
    name: 'ext',
    component: () => import('./views/PluginView.vue'),
    meta: { get title() {
      return t('core.corePlagin');
    }, tool: 'ext' },
  },
  {
    path: '/video',
    name: 'video',
    component: () => import('./views/VideoView.vue'),
    meta: { get title() {
      return t('core.navVideo');
    }, layout: 'workspace' },
  },
  {
    path: '/inbox',
    name: 'inbox',
    component: () => import('./views/InboxView.vue'),
    meta: { get title() {
      return t('core.navInbox');
    }, layout: 'workspace' },
  },
  {
    path: '/github',
    name: 'github',
    component: () => import('./views/GitHubView.vue'),
    meta: { title: 'GitHub', layout: 'workspace' },
  },
  {
    path: '/telegram',
    name: 'telegram',
    component: () => import('./views/TelegramView.vue'),
    meta: { get title() {
      return t('core.pluginTelegram');
    }, layout: 'workspace' },
  },
  {
    path: '/surface',
    name: 'surface',
    component: { render: () => null },
    meta: { get title() {
      return t('core.taskCard');
    } },
  },
  {
    path: '/settings',
    name: 'settings',
    component: SettingsRouteStub,
    meta: { get title() {
      return t('core.settings');
    } },
  },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
