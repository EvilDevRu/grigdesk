import type { Component } from 'vue';
import { asyncView } from '../../shared/asyncView.ts';

const preferences = asyncView(() => import('./pages/PreferencesPage.vue'));
const speech = asyncView(() => import('./pages/SpeechPage.vue'));
const device = asyncView(() => import('./pages/InterfacePage.vue'));

export const SETTINGS_PAGE_COMPONENTS: Record<string, Component> = {
  'interface.behavior': device,
  'interface.notifications': device,
  'interface.shortcuts': device,
  'automation.chats': preferences,
  'automation.context': preferences,
  'automation.launch': preferences,
  'automation.monitoring': preferences,
  'automation.arbiter': preferences,
  'agents.models': preferences,
  'connections.devices': asyncView(() => import('./pages/DevicesPage.vue')),
  'connections.b24': asyncView(() => import('./pages/ConnectionsPage.vue')),
  'connections.mobile': asyncView(() => import('./pages/ConnectionsPage.vue')),
  'system.startup': asyncView(() => import('./pages/SystemPage.vue')),
  'system.updates': asyncView(() => import('./pages/SystemPage.vue')),
  'system.processes': asyncView(() => import('./pages/ProcessesPage.vue')),
  'plugins.installed': asyncView(() => import('./pages/PluginWorkspacePage.vue')),
  'agents.providers': asyncView(() => import('./pages/ProviderPage.vue')),
  'speech.dictation': speech,
  'speech.video': speech,
  'speech.language': speech,
  'speech.models': speech,
  'speech.advanced': speech,
  'system.diagnostics': asyncView(() => import('./pages/DiagnosticsPage.vue')),
};
