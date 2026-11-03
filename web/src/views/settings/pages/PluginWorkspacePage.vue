<template>
  <div class="plugins-workspace ui-workspace" data-plugins-workspace data-ui-workspace>
    <div class="plugins-toolbar">
      <h3 id="settings-page-title">{{ t('settings.plugins') }}</h3>
      <div class="plugins-tabs">
        <UiTabs v-model="state.tab" :label="t('settings.grigdeskPlugins')" data-ui-settings-tabs>
          <UiTab
            id="plugins-catalog-tab"
            value="catalog"
            controls="plugins-catalog-panel"
            data-plugins-tab="catalog"
          >
            {{ t('settings.marketplaceCatalog') }}
          </UiTab>
          <UiTab
            id="plugins-installed-tab"
            value="installed"
            controls="plugins-installed-panel"
            data-plugins-tab="installed"
          >
            {{ t('settings.installed') }}
          </UiTab>
        </UiTabs>
      </div>
      <div class="plugins-toolbar-actions">
        <UiButton
          v-if="installer.job || installer.recoveryError"
          variant="text"
          data-context="workspace-form"
          data-install-job
          @click="openJob"
        >
          {{ t('settings.pluginInstallationJob') }}
        </UiButton>
        <UiButton
          variant="text"
          data-context="workspace-form"
          data-install-git
          :disabled="recoveryBlocked"
          @click="openGit"
        >
          {{ t('settings.marketplaceInstallGit') }}
        </UiButton>
      </div>
    </div>
    <div v-if="state.tab === 'catalog' && (recoveryBlocked || plugins.loadError)" class="plugins-notices">
      <UiInlineMessage v-if="recoveryBlocked" tone="warning"
                       :heading="t('settings.pluginRecoveryRequired')">
        {{ installer.recoveryError?.message ?? installer.job?.error?.message }}
      </UiInlineMessage>
      <UiInlineMessage v-if="plugins.loadError" tone="warning"
                       :heading="t('settings.pluginCatalogFailure')">
        {{ plugins.loadError }}
        <template #actions>
          <UiButton data-context="workspace-form" @click="plugins.load()">
            {{ t('settings.retryLoading') }}
          </UiButton>
        </template>
      </UiInlineMessage>
    </div>
    <section
      id="plugins-catalog-panel"
      v-if="state.tab === 'catalog'"
      role="tabpanel"
      aria-labelledby="plugins-catalog-tab"
    >
      <PluginCatalogPanel @install="openSelection" @configure="configure" />
    </section>
    <section
      id="plugins-installed-panel"
      v-show="state.tab === 'installed'"
      role="tabpanel"
      aria-labelledby="plugins-installed-tab"
    >
      <PluginPage :active="active && state.tab === 'installed'" />
    </section>
    <PluginInstallDialog
      v-if="installOpen"
      v-model:open="installOpen"
      :mode="installMode"
      :resume="resumeJob"
      :plugin="installPlugin"
      :catalog-selection="selection"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue';

import { UiTabs, UiTab, UiButton, UiInlineMessage, t } from '../../../ui.ts';
import { useSettingsStore } from '../../../stores/settings.ts';
import { usePluginInstallStore } from '../../../stores/pluginInstall.ts';
import { usePluginCatalogStore } from '../../../stores/pluginCatalog.ts';
import { usePluginsStore } from '../../../stores/plugins.ts';
import { usePluginMarketplaceState } from '../../../features/settings/pluginMarketplace.ts';
import { pluginSettingsTarget } from '../../../features/settings/pluginPages.ts';
import type { CatalogSelection } from '../../../../../shared/plugins/pluginCatalogPolicy.ts';
import type { PluginListItem } from '../../../../../shared/plugins/pluginsContracts.ts';
import PluginPage from './PluginPage.vue';
import PluginCatalogPanel from './PluginCatalogPanel.vue';
import PluginInstallDialog from '../PluginInstallDialog.vue';

defineProps<{ active: boolean }>();

const settings = useSettingsStore();
const installer = usePluginInstallStore();
const catalog = usePluginCatalogStore();
const plugins = usePluginsStore();
const state = usePluginMarketplaceState();
const installOpen = ref(false);
const installMode = ref<'install' | 'update'>('install');
const resumeJob = ref(false);
const installPlugin = shallowRef<PluginListItem | null>(null);
const selection = shallowRef<CatalogSelection | null>(null);
const recoveryBlocked = computed(() => Boolean(installer.recoveryError)
  || installer.job?.status === 'recovery_required');

/**
 * Общая ручная установка не наследует id выбранного редактора или прежний preset.
 * Это отдельное немедленное действие, которое не сохраняет черновики настроек.
 */
function openGit(): void {
  if (recoveryBlocked.value) {
    return;
  }

  selection.value = null;
  installPlugin.value = null;
  installMode.value = 'install';
  resumeJob.value = false;
  installOpen.value = true;
}

/**
 * Текущее задание открывается без прежнего preset каталога: иначе «Попробовать снова»
 * подставил бы адрес и версию давно закрытого выбора. Recovery здесь не блокирует открытие.
 */
function openJob(): void {
  selection.value = null;
  installPlugin.value = null;
  installMode.value = 'install';
  resumeJob.value = true;
  installOpen.value = true;
}

/**
 * Карточка передаёт один immutable по смыслу выбор в прежний диалог установки.
 * Update получает установленный объект; чужой источник отсекается правилами карточки.
 */
function openSelection(next: CatalogSelection, installed: PluginListItem | null): void {
  if (recoveryBlocked.value) {
    return;
  }

  selection.value = {
    ...next,
    source: { ...next.source },
    target: { ...next.target }
  };
  installPlugin.value = installed;
  installMode.value = installed?.install ? 'update' : 'install';
  resumeJob.value = false;
  installOpen.value = true;
}

/**
 * Настройки плагина открываются на его странице: системные живут в тематических
 * разделах, пользовательские — в списке «Установленные» с явным выбором.
 */
function configure(id: string): void {
  const entry = plugins.list.find((item) => item.id === id);
  const target = pluginSettingsTarget(id, entry?.system === true);

  settings.selectPage(target.pageId, target.entityId);

  if (target.pageId === 'plugins.installed') {
    state.tab = 'installed';
  }
}

watch([() => settings.entityId, () => settings.revealTarget], ([id, target]) => {
  if (id || target?.pageId === 'plugins.installed') {
    state.tab = 'installed';
  }
}, { immediate: true });

onMounted(() => {
  void catalog.loadIndex();
  void installer.loadJob();

  if (!plugins.loaded) {
    void plugins.load();
  }
});
</script>

<style scoped>
.plugins-workspace {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.plugins-workspace > [role='tabpanel'] {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
.plugins-workspace > #plugins-installed-panel {
  display: flex;
  overflow: hidden;
}
.plugins-tabs {
  flex: 1 1 160px;
  min-width: 0;
}
.plugins-notices {
  display: grid;
  flex: none;
  gap: 8px;
  max-height: 40%;
  padding: 12px 16px;
  overflow: auto;
}
.plugins-toolbar {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  flex: none;
  gap: 4px 16px;
  min-height: 52px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--line);
}
.plugins-toolbar h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.plugins-workspace > #plugins-catalog-panel {
  padding: 16px;
}
.plugins-toolbar-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
}
</style>
