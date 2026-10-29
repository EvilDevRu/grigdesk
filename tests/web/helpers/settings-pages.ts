export { default as PreferencesPage } from '../../../web/src/views/settings/pages/PreferencesPage.vue';
export { default as InterfacePage } from '../../../web/src/views/settings/pages/InterfacePage.vue';
export { default as DiagnosticsPage } from '../../../web/src/views/settings/pages/DiagnosticsPage.vue';
export { default as SpeechPage } from '../../../web/src/views/settings/pages/SpeechPage.vue';
export { default as ProviderPage } from '../../../web/src/views/settings/pages/ProviderPage.vue';
export { UiDialog } from '../../../web/src/ui.ts';
export { useSettingsStore } from '../../../web/src/stores/settings.ts';
export { SETTINGS_FIELDS } from '../../../web/src/features/settings/catalog.ts';
export { useDeviceStore } from '../../../web/src/stores/device.ts';
export { useHotkeysStore } from '../../../web/src/stores/hotkeys.ts';
export { useChatStore } from '../../../web/src/stores/chat.ts';
export { useProvidersStore } from '../../../web/src/stores/providers.ts';
export { defineProviderSettingsStore } from '../../../web/src/stores/providerSettings.ts';
export { ApiError } from '../../../web/src/shared/apiClient.ts';
export { createProviderNativeAdapter } from '../../../web/src/features/settings/resources/providers.ts';
export { createProviderCredentialsAdapter } from '../../../web/src/features/settings/resources/providers.ts';
export { createProviderEditor } from '../../../web/src/features/settings/providerEditor.ts';
export { reactive } from 'vue';
export { usePluginsStore } from '../../../web/src/stores/plugins.ts';
export { createPluginEditor } from '../../../web/src/features/settings/pluginEditor.ts';
export { default as PluginPage } from '../../../web/src/views/settings/pages/PluginPage.vue';
export { usePluginInstallStore } from '../../../web/src/stores/pluginInstall.ts';
export { default as ConnectionsPage } from '../../../web/src/views/settings/pages/ConnectionsPage.vue';
export { default as SystemPage } from '../../../web/src/views/settings/pages/SystemPage.vue';
export { default as ProcessesPage } from '../../../web/src/views/settings/pages/ProcessesPage.vue';
export { createProviderSettingsAdapter } from '../../../web/src/features/settings/resources/providers.ts';

export { default as DevicesPage } from '../../../web/src/views/settings/pages/DevicesPage.vue';

export { default as PluginCatalogPanel } from '../../../web/src/views/settings/pages/PluginCatalogPanel.vue';
export { usePluginCatalogStore } from '../../../web/src/stores/pluginCatalog.ts';
export { setUiLocale } from '../../../web/src/ui.ts';

export {
  default as PluginWorkspacePage,
} from '../../../web/src/views/settings/pages/PluginWorkspacePage.vue';

export { default as SettingsModal } from '../../../web/src/views/settings/SettingsModal.vue';
