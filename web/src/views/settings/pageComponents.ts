import { defineComponent, h } from 'vue';
import type { Component } from 'vue';

import { asyncView } from '../../shared/asyncView.ts';
import SettingsLoading from './SettingsLoading.vue';

/**
 * Ключ замыкается при регистрации, пока код страницы ещё не загружен.
 * Каркас получает только известную вкладку, без чтения настроек или запросов.
 */
function loading(pageId: string): Component {
  return defineComponent({
    inheritAttrs: false,
    setup: () => () => h(SettingsLoading, { pageId }),
  });
}

export const SETTINGS_PAGE_COMPONENTS: Record<string, Component> = {
  'interface.behavior': asyncView(() => import('./pages/InterfacePage.vue'), loading('interface.behavior')),
  'interface.notifications': asyncView(
    () => import('./pages/InterfacePage.vue'),
    loading('interface.notifications'),
  ),
  'interface.shortcuts': asyncView(() => import('./pages/InterfacePage.vue'), loading('interface.shortcuts')),
  'automation.chats': asyncView(() => import('./pages/PreferencesPage.vue'), loading('automation.chats')),
  'automation.context': asyncView(() => import('./pages/PreferencesPage.vue'), loading('automation.context')),
  'automation.launch': asyncView(() => import('./pages/PreferencesPage.vue'), loading('automation.launch')),
  'automation.monitoring': asyncView(
    () => import('./pages/PreferencesPage.vue'),
    loading('automation.monitoring'),
  ),
  'automation.arbiter': asyncView(() => import('./pages/PreferencesPage.vue'), loading('automation.arbiter')),
  'agents.models': asyncView(() => import('./pages/PreferencesPage.vue'), loading('agents.models')),
  'connections.devices': asyncView(() => import('./pages/DevicesPage.vue'), loading('connections.devices')),
  'connections.mobile': asyncView(() => import('./pages/DevicesPage.vue'), loading('connections.mobile')),
  'system.startup': asyncView(() => import('./pages/SystemPage.vue'), loading('system.startup')),
  'system.updates': asyncView(() => import('./pages/SystemPage.vue'), loading('system.updates')),
  'system.processes': asyncView(() => import('./pages/ProcessesPage.vue'), loading('system.processes')),
  'plugins.installed': asyncView(
    () => import('./pages/PluginWorkspacePage.vue'),
    loading('plugins.installed'),
  ),
  'connections.ssh': asyncView(() => import('./pages/PluginPage.vue'), loading('connections.ssh')),
  'connections.db': asyncView(() => import('./pages/PluginPage.vue'), loading('connections.db')),
  'connections.telegram': asyncView(
    () => import('./pages/PluginPage.vue'),
    loading('connections.telegram'),
  ),
  'connections.github': asyncView(
    () => import('./pages/PluginPage.vue'),
    loading('connections.github'),
  ),
  'automation.analysis': asyncView(
    () => import('./pages/PluginPage.vue'),
    loading('automation.analysis'),
  ),
  'automation.shelf': asyncView(() => import('./pages/PluginPage.vue'), loading('automation.shelf')),
  'automation.inbox': asyncView(() => import('./pages/PluginPage.vue'), loading('automation.inbox')),
  'speech.videoTasks': asyncView(
    () => import('./pages/PluginPage.vue'),
    loading('speech.videoTasks'),
  ),
  'interface.usageForecast': asyncView(
    () => import('./pages/PluginPage.vue'),
    loading('interface.usageForecast'),
  ),
  'tools.code': asyncView(() => import('./pages/PluginPage.vue'), loading('tools.code')),
  'tools.docker': asyncView(() => import('./pages/PluginPage.vue'), loading('tools.docker')),
  'tools.studio3d': asyncView(() => import('./pages/PluginPage.vue'), loading('tools.studio3d')),
  'tools.showcase': asyncView(() => import('./pages/PluginPage.vue'), loading('tools.showcase')),
  'agents.providers': asyncView(() => import('./pages/ProviderPage.vue'), loading('agents.providers')),
  'speech.dictation': asyncView(() => import('./pages/SpeechPage.vue'), loading('speech.dictation')),
  'speech.video': asyncView(() => import('./pages/SpeechPage.vue'), loading('speech.video')),
  'speech.language': asyncView(() => import('./pages/SpeechPage.vue'), loading('speech.language')),
  'speech.models': asyncView(() => import('./pages/SpeechPage.vue'), loading('speech.models')),
  'speech.advanced': asyncView(() => import('./pages/SpeechPage.vue'), loading('speech.advanced')),
  'system.diagnostics': asyncView(() => import('./pages/DiagnosticsPage.vue'), loading('system.diagnostics')),
};
