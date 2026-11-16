<template>
  <div
    class="settings-plugin"
    :data-plugin-page="plugin?.id"
    :data-ready="ready"
    :data-single="Boolean(singlePluginId)"
  >
    <div v-if="error || plugins.loadError || recoveryBlocked || actionError || removedName"
         class="settings-plugin-notices">
      <UiInlineMessage v-if="error || plugins.loadError" :tone="error ? 'danger' : 'warning'"
                       :heading="t('settings.pluginCatalogFailure')" data-plugin-load-error>
        {{ error || plugins.loadError }}
        <template #actions>
          <UiButton data-plugin-retry @click="load">{{ t('settings.retryLoading') }}</UiButton>
        </template>
      </UiInlineMessage>
      <UiInlineMessage v-if="recoveryBlocked" tone="warning"
                       :heading="t('settings.pluginRecoveryRequired')">
        {{ installer.recoveryError?.message ?? installer.job?.error?.message }}
      </UiInlineMessage>
      <UiInlineMessage v-if="actionError" tone="danger" :heading="t('settings.pluginActionFailed')"
                       dismissible data-plugin-action-error @dismiss="installer.error = null">
        {{ actionError }}
      </UiInlineMessage>
      <UiInlineMessage v-if="removedName" tone="success" :heading="t('settings.pluginRemoved')"
                       dismissible data-plugin-removed @dismiss="removedName = ''">
        {{ t('settings.pluginRemovedRestart', { pluginName: removedName }) }}
      </UiInlineMessage>
    </div>
    <p v-if="!ready && !plugins.loadError && !error" role="status" data-plugin-loading>
      {{ t('settings.loadingSection2') }}
    </p>
    <div class="settings-plugin-workspace">
      <aside
        v-if="!singlePluginId"
        class="settings-plugin-sidebar"
        :aria-label="t('settings.pluginSelection')"
      >
        <div class="settings-plugin-filters">
          <SettingsIcon name="search" />
          <UiSearchInput
            v-model="filters.query"
            data-plugin-filter
            data-context="plugin-list-search"
            :aria-label="t('settings.searchPlugins')"
            :placeholder="t('settings.findAPlugin')"
          />
          <UiPopover
            v-model:open="filtersOpen"
            placement="bottom-end"
            :aria-label="t('settings.pluginFilters')"
            data-ui-workspace
          >
            <template #trigger>
              <UiIconButton
                :label="t('settings.pluginFilters')"
                :tone="hasActiveFilters ? 'accent' : 'neutral'"
                data-plugin-filter-options
              >
                <svg
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  aria-hidden="true"
                >
                  <path d="M3 5h14M3 10h14M3 15h14M7 3v4M13 8v4M7 13v4" />
                </svg>
              </UiIconButton>
            </template>
            <div class="settings-plugin-filter-menu">
              <UiSelect v-model="filters.state" :aria-label="t('settings.pluginStatus')">
                <option value="all">{{ t('settings.all') }}</option>
                <option value="enabled">{{ t('settings.enabled') }}</option>
                <option value="disabled">{{ t('settings.disabled3') }}</option>
              </UiSelect>
              <UiCheckbox v-model="filters.configurable">{{ t('settings.withSettings') }}</UiCheckbox>
              <UiButton v-if="hasActiveFilters" variant="text" @click="clearFilters">
                {{ t('settings.resetFilters') }}
              </UiButton>
            </div>
          </UiPopover>
        </div>
        <div class="settings-plugin-picker">
          <UiSelect
            :model-value="plugin?.id || ''"
            :aria-label="t('settings.selectAPlugin')"
            @update:model-value="selectPlugin(String($event))"
          >
            <optgroup v-for="group in groups" :key="group.id" :label="group.label">
              <option v-for="entry in group.plugins" :key="entry.id" :value="entry.id">
                {{ entry.name }}
              </option>
            </optgroup>
          </UiSelect>
        </div>
        <div class="settings-plugin-catalog">
          <section class="settings-plugin-group"
            v-for="group in groups"
            :key="group.id"
            :data-plugin-category="group.id"
          >
            <h4>{{ group.label }} <span>{{ group.plugins.length }}</span></h4>
            <div class="settings-plugin-list">
              <UiSelectableRow
                v-for="entry in group.plugins"
                :key="entry.id"
                :data-select-plugin="entry.id"
                :selected="plugin?.id === entry.id"
                :pressed="plugin?.id === entry.id"
                data-context="workspace-catalog"
                data-ui-settings-plugin-row
                @select="selectPlugin(entry.id)"
              >
                <PluginIcon class="settings-plugin-icon" :src="entry.icon" />
                <span class="settings-plugin-copy">
                  <span class="settings-plugin-name">{{ entry.name }}</span>
                  <span class="settings-plugin-meta">
                    <span v-if="entry.version">{{ entry.version }}</span>
                    <span v-if="pluginInstallBadge(entry)" class="settings-plugin-badge">
                      {{ pluginInstallBadge(entry) === 'restart'
                        ? t('settings.waitingForRestart') : t('settings.update2') }}
                    </span>
                  </span>
                </span>
                <template #actions>
                  <UiCheckbox
                    :model-value="draftEnabled(entry.id)"
                    :aria-label="t('settings.enable2', { pluginName: entry.name })"
                    :data-plugin-enabled="entry.id"
                    :disabled="!ready || recoveryBlocked || Boolean(togglingId)
                      || entry.compatibility?.status === 'incompatible'"
                    @update:model-value="toggleEntry(entry.id, $event === true)"
                  />
                </template>
              </UiSelectableRow>
            </div>
          </section>
        </div>
        <p v-if="!groups.length && hasCustom">{{ t('settings.noPluginsFoundChangeTheQueryOr') }}</p>
        <p v-else-if="!groups.length">{{ t('settings.installAPluginFromGitToAdd') }}</p>
        <div v-if="list.some((entry) => entry.install)" class="settings-plugin-actions">
          <UiButton
            data-ui-settings-sidebar-action
            :disabled="recoveryBlocked || installer.checking"
            @click="installer.checkUpdates()"
          >
            {{ t('settings.checkForUpdates') }}
          </UiButton>
        </div>
      </aside>
      <section class="settings-plugin-editor" :aria-label="t('settings.selectedPluginSettings')">
        <template v-if="plugin && ready">
          <header v-if="!showcasePage" class="settings-plugin-title">
            <PluginIcon v-if="singlePluginId" class="settings-plugin-icon" :src="plugin.icon" />
            <div class="settings-plugin-heading">
              <h4>{{ plugin.name }}</h4>
              <span v-if="singlePluginId" class="settings-plugin-meta">{{ plugin.version }}</span>
            </div>
            <div v-if="!singlePluginId" class="settings-plugin-header-actions">
              <SettingsField :address="address('enabled')" presentation="action">
                <UiButton
                  data-plugin-enable-action
                  :disabled="recoveryBlocked || plugin.compatibility?.status === 'incompatible'"
                  :aria-label="enabled
                    ? t('settings.pluginDisableNamed', { pluginName: plugin.name })
                    : t('settings.enable2', { pluginName: plugin.name })"
                  @click="setEnabled(!enabled)"
                >
                  {{ enabled ? t('settings.disable') : t('settings.pluginEnable') }}
                </UiButton>
              </SettingsField>
              <span class="settings-plugin-meta">{{ plugin.version }}</span>
              <div v-if="!plugin.system" class="settings-plugin-package-actions">
                <UiIconButton
                  :label="t('settings.update')"
                  v-tooltip="t('settings.update')"
                  data-plugin-update-action
                  :disabled="packageActionsBlocked"
                  @click="openInstall(plugin.install ? 'update' : 'install')"
                >
                  <UiRefreshIcon />
                </UiIconButton>
                <UiIconButton
                  :label="t('settings.delete')"
                  v-tooltip="t('settings.delete')"
                  tone="danger"
                  data-plugin-remove-action
                  :disabled="packageActionsBlocked || activeInstall"
                  :loading="installer.pendingAction === 'remove'"
                  @click="removePlugin"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6" />
                  </svg>
                </UiIconButton>
              </div>
            </div>
            <p v-if="singlePluginId && plugin.description">{{ plugin.description }}</p>
          </header>
          <UiInlineMessage v-if="plugin.compatibility?.status === 'incompatible'" tone="danger">
            {{ plugin.compatibility.reason }}
          </UiInlineMessage>
          <UiInlineMessage v-if="!singlePluginId && plugin.serverError" tone="danger"
                           :heading="t('settings.pluginRuntimeError')"
                           class="settings-plugin-runtime-error">
            {{ plugin.serverError }}
          </UiInlineMessage>
          <div v-if="!singlePluginId" class="settings-plugin-detail-tabs">
            <UiTabs v-model="detailTab" :label="plugin.name" data-ui-settings-tabs>
              <UiTab
                :id="`${detailsId}-parameters-tab`"
                value="parameters"
                :controls="`${detailsId}-parameters`"
                data-plugin-details-tab="parameters"
              >
                {{ t('settings.parameters') }}
              </UiTab>
              <UiTab
                v-if="!plugin.system"
                :id="`${detailsId}-source-tab`"
                value="source"
                :controls="`${detailsId}-source`"
                data-plugin-details-tab="source"
              >
                {{ t('settings.source') }}
                <span v-if="sourceNeedsAttention" class="settings-plugin-badge" aria-hidden="true">•</span>
              </UiTab>
            </UiTabs>
          </div>
          <div
            :id="`${detailsId}-parameters`"
            v-show="singlePluginId || detailTab === 'parameters'"
            class="settings-plugin-content"
            :role="singlePluginId ? undefined : 'tabpanel'"
            :aria-labelledby="singlePluginId ? undefined : `${detailsId}-parameters-tab`"
            :data-ui-plugin-form="!singlePluginId || undefined"
          >
            <p v-if="!singlePluginId && plugin.description" class="settings-plugin-description">
              {{ plugin.description }}
            </p>
            <SettingsSection
              v-if="showcasePage"
              :heading="t('settings.showcaseSetupStartHeading')"
              :description="t('settings.showcaseSetupStartHint')"
            >
              <UiButton
                data-showcase-open
                data-context="workspace-form-wrap"
                :disabled="!baselineEnabled || !enabled || recoveryBlocked
                  || settings.snapshot.applying || settings.actionRunning"
                @click="openShowcase"
              >
                {{ t('settings.showcaseSetupOpen') }}
              </UiButton>
              <p v-if="!enabled">{{ t('settings.showcaseSetupEnableFirst') }}</p>
              <p v-else-if="!baselineEnabled">{{ t('settings.showcaseSetupApplyFirst') }}</p>
            </SettingsSection>
            <PluginSetupPanel
              v-if="baselineEnabled && plugin.setup && setupPlugin"
              :key="plugin.id"
              :plugin="setupPlugin"
              :active="active"
            />
            <UiInlineMessage v-if="singlePluginId && plugin.serverError" tone="danger">
              {{ plugin.serverError }}
            </UiInlineMessage>
            <SettingsScope v-if="singlePluginId">
              {{ t('settings.valuesAndPlacementsAreSavedWithApply') }}
            </SettingsScope>
            <SettingsField v-if="singlePluginId" :address="address('enabled')">
              <UiSwitch
                :model-value="enabled"
                :disabled="recoveryBlocked"
                :aria-label="t('settings.enable2', { pluginName: plugin.name })"
                @update:model-value="setEnabled"
              />
            </SettingsField>
            <p v-if="restartPending">{{ t('settings.waitingForRestart') }}</p>
            <p v-else-if="plugin.needsRestart && (singlePluginId || enabled !== baselineEnabled)">
              {{ t('settings.changingServerComponentStatusWillRequireA') }}
            </p>
            <SettingsSection
              v-if="plugin.system && plugin.id === 'telegram'"
              :heading="t('settings.telegramSetupHeading')"
              :description="t('settings.telegramSetupDescription')"
            >
              <UiButton
                data-telegram-setup
                data-context="workspace-form-wrap"
                :disabled="!baselineEnabled || !enabled || recoveryBlocked
                  || settings.snapshot.applying || settings.actionRunning"
                @click="openTelegram"
              >
                {{ t('settings.telegramSetupOpen') }}
              </UiButton>
              <p v-if="!enabled">{{ t('settings.telegramSetupEnableFirst') }}</p>
              <p v-else-if="!baselineEnabled">{{ t('settings.telegramSetupApplyFirst') }}</p>
            </SettingsSection>
            <h4 v-if="plugin.placements?.length">{{ t('settings.placement') }}</h4>
            <SettingsField
              v-for="slot in plugin.placements ?? []"
              :key="slot.slot"
              :address="address('placements', slot.slot)"
            >
              <UiCheckbox
                :model-value="value('placements', slot.slot) === true"
                :aria-label="slot.label"
                @update:model-value="set('placements', slot.slot, $event === true)"
              />
            </SettingsField>
            <h4 v-if="singlePluginId && plugin.settings.length">{{ t('settings.parameters') }}</h4>
            <SettingsField
              v-for="field in plugin.settings"
              :key="field.key"
              :address="address('values', field.key)"
            >
              <UiCheckbox
                :disabled="fieldUnavailable(field.key)"
                v-if="field.type === 'checkbox'"
                :model-value="value('values', field.key) === true"
                :aria-label="field.label"
                @update:model-value="set('values', field.key, $event === true)"
              />
              <template v-else-if="field.type === 'providers'">
                <UiCheckbox
                  :disabled="fieldUnavailable(field.key)"
                  v-for="entry in registry"
                  :key="entry.id"
                  :model-value="providerIds(field.key).includes(entry.id)"
                  @update:model-value="setProvider(field.key, entry.id, $event === true)"
                >
                  {{ entry.name }}
                </UiCheckbox>
                <p v-for="id in missingProviders(field.key)" :key="id">
                  {{ id }} {{ t('settings.missingFromRegistry2') }}
                  <UiButton @click="setProvider(field.key, id, false)">{{ t('settings.remove') }}</UiButton>
                </p>
                <p>{{ t('settings.noneSelectedMeansAll') }}</p>
              </template>
              <template v-else-if="field.type === 'model'">
                <ProviderModelSelect
                  :providers="registry"
                  :fallback-label="lostModel(field) || selectedModel(field.key)?.name || ''"
                  :disabled="fieldUnavailable(field.key)"
                  :model-value="modelOption(field.key)"
                  :aria-label="field.label"
                  @update:model-value="setModel(field.key, $event)"
                >
                  <option value="">{{ t('settings.notSelected') }}</option>
                  <option
                    v-if="lostModel(field) || modelUnavailable(field.key)"
                    :value="modelOption(field.key)"
                    :hidden="modelUnavailable(field.key)"
                    disabled
                  >
                    {{ lostModel(field) || selectedModel(field.key)?.name }}
                  </option>
                  <optgroup
                    v-for="group in modelGroups(field)"
                    :key="group.id"
                    :label="group.name"
                  >
                    <option
                      v-for="entry in group.models"
                      :key="entry.id"
                      :value="modelId(group.id, entry.id)"
                      :disabled="entry.nonChat"
                      :title="entry.nonChat ? entry.nonChatReason : undefined"
                    >
                      {{ entry.name }}
                    </option>
                  </optgroup>
                </ProviderModelSelect>
                <template v-if="efforts(field.key).length || modelValue(field.key)?.effort">
                  <p>{{ t('settings.effort') }}</p>
                  <UiSelect
                    :disabled="fieldUnavailable(field.key)"
                    :model-value="modelValue(field.key)?.effort || ''"
                    :aria-label="t('settings.effort')"
                    @update:model-value="setEffort(field.key, $event)"
                  >
                    <option value="">{{ t('settings.providerDefault') }}</option>
                    <option v-if="lostEffort(field.key)" :value="lostEffort(field.key)">
                      {{ lostEffort(field.key) }} {{ t('settings.unavailableForThisModel') }}
                    </option>
                    <option
                      v-for="effort in efforts(field.key)"
                      :key="effort"
                      :value="effort"
                    >
                      {{ effort }}
                    </option>
                  </UiSelect>
                  <p>{{ selectedModel(field.key)?.effortHints?.[modelValue(field.key)?.effort || ''] }}</p>
                </template>
              </template>
              <UiNumberInput
                :disabled="fieldUnavailable(field.key)"
                v-else-if="field.type === 'number'"
                :model-value="numberValue(field.key)"
                :min="field.min"
                :max="field.max"
                :step="field.step ?? 'any'"
                :aria-label="field.label"
                @update:model-value="set('values', field.key, $event)"
              />
              <UiSelect
                :disabled="fieldUnavailable(field.key)"
                v-else-if="field.type === 'select'"
                :model-value="textValue(field.key)"
                :aria-label="field.label"
                @update:model-value="set('values', field.key, String($event))"
              >
                <option
                  v-if="!field.options?.includes(textValue(field.key))"
                  :value="textValue(field.key)"
                  disabled
                >
                  {{ textValue(field.key) }} {{ t('settings.missingFromList') }}
                </option>
                <option
                  v-for="option in field.options"
                  :key="option"
                  :value="option"
                >
                  {{ option }}
                </option>
              </UiSelect>
              <UiPasswordInput
                :disabled="fieldUnavailable(field.key)"
                v-else-if="['password', 'secret'].includes(field.type ?? '')"
                :model-value="textValue(field.key)"
                :aria-label="field.label"
                autocomplete="new-password"
                @update:model-value="set('values', field.key, $event)"
              />
              <UiInput
                :disabled="fieldUnavailable(field.key)"
                v-else
                :model-value="textValue(field.key)"
                :aria-label="field.label"
                @update:model-value="set('values', field.key, $event)"
              />
              <UiButton
                v-if="fieldUnavailable(field.key)"
                @click="discard(pluginValueKey('values', field.key))"
              >
                {{ t('settings.discardEdit') }}
              </UiButton>
            </SettingsField>
          </div>
          <section
            v-if="!plugin.system"
            :id="`${detailsId}-source`"
            v-show="detailTab === 'source'"
            class="settings-plugin-content"
            role="tabpanel"
            :aria-labelledby="`${detailsId}-source-tab`"
          >
            <p class="settings-plugin-description" :data-installed-source="plugin.id">
              {{ provenance(plugin) }}
            </p>
            <PluginSourcePanel
              :key="plugin.id"
              :plugin="plugin"
              embedded
              @update="openInstall('update')"
              @bind="openInstall('install')"
            />
          </section>
        </template>
        <p v-else-if="ready && !plugin && (settings.entityId || singlePluginId)"
           data-plugin-missing>{{ t('settings.thePluginIsNoLongerAvailable') }}</p>
        <div v-else-if="ready && !plugin" class="settings-plugin-empty">
          <h4>{{ hasCustom ? t('settings.selectAPlugin') : t('settings.noPluginsInstalled') }}</h4>
          <p>
            {{ hasCustom ? t('settings.selectAPluginFromTheListTo')
              : t('settings.installAPluginFromGitToAdd') }}
          </p>
        </div>
        <SettingsField
          v-for="field in unavailable"
          :key="field.key"
          :address="field.address"
        >
          <UiButton @click="discard(field.key)">{{ t('settings.discardEdit') }}</UiButton>
        </SettingsField>
      </section>
    </div>
    <PluginInstallDialog
      v-if="installOpen"
      v-model:open="installOpen"
      :mode="installMode"
      :plugin="plugin ?? null"
    />
  </div>
</template>

<script setup lang="ts">
import PluginIcon from '../../../shared/PluginIcon.vue';

import { t, uiLocale } from '../../../ui.ts';

import { localizePluginMetadata, localizePluginCategory } from '../../../features/settings/metadataLocale.ts';

import SettingsScope from '../SettingsScope.vue';
import SettingsIcon from '../SettingsIcon.vue';
import { computed, reactive, ref, watch, onMounted, onBeforeUnmount, useId } from 'vue';
import { isNavigationFailure, NavigationFailureType, useRouter } from 'vue-router';
import {
  UiRefreshIcon,
  UiSwitch, UiCheckbox, UiInput, UiNumberInput, UiSelect, UiPasswordInput, UiButton, UiInlineMessage,
  UiSearchInput, UiSelectableRow, UiIconButton, UiPopover, UiTabs, UiTab, confirmDialog, messageRef, vTooltip,
} from '../../../ui.ts';
import type {
  PluginListItem, PluginModelValue, PluginSetting,
} from '../../../../../shared/plugins/pluginsContracts.ts';
import type { ProviderEntry } from '../../../../../shared/chat/providersContracts.ts';
import { useSettingsStore } from '../../../stores/settings.ts';
import { pluginCategoryOf, usePluginsStore } from '../../../stores/plugins.ts';
import { usePluginCatalogStore } from '../../../stores/pluginCatalog.ts';
import {
  sourceMembership, type SourceMembership,
} from '../../../../../shared/plugins/pluginCatalogPolicy.ts';
import { usePluginInstallStore } from '../../../stores/pluginInstall.ts';
import { isActiveInstallJob, pluginInstallBadge } from '../../../shared/pluginInstall.ts';
import { PLUGIN_CATEGORIES } from '../../../../../shared/plugins/pluginsContracts.ts';
import PluginSourcePanel from '../PluginSourcePanel.vue';
import PluginInstallDialog from '../PluginInstallDialog.vue';
import PluginSetupPanel from './PluginSetupPanel.vue';
import { useProvidersStore } from '../../../stores/providers.ts';
import ProviderModelSelect from '../../../shared/ProviderModelSelect.vue';
import {
  isSelectableModelProvider, modelSelectValue as modelId,
} from '../../../shared/providerModelSelect.ts';
import { createPluginEditor } from '../../../features/settings/pluginEditor.ts';
import { pluginValueKey, type PluginStorePort } from '../../../features/settings/resources/plugins.ts';
import {
  pluginFieldAddress, pluginSettingsTarget, systemPluginOfPage,
} from '../../../features/settings/pluginPages.ts';
import type { FieldAddress, JsonValue } from '../../../features/settings/contracts.ts';
import { failureText } from '../../../shared/apiClient.ts';
import SettingsField from '../SettingsField.vue';
import SettingsSection from '../SettingsSection.vue';

const props = defineProps<{ active: boolean }>();
const settings = useSettingsStore();
const router = useRouter();
const plugins = usePluginsStore();
const installer = usePluginInstallStore();
const catalog = usePluginCatalogStore();
const filters = settings.sessionService('plugin-filters', () => reactive({
  query: '',
  state: 'all',
  configurable: false,
}));
const list = computed(() => (plugins.list as PluginListItem[])
  .map((entry) => localizePluginMetadata(entry, uiLocale.value)));
// Одиночный режим: страница из карты системных плагинов рисует форму одного
// плагина без списка и фильтров магазина.
const singlePluginId = computed(() => systemPluginOfPage(settings.pageId));
const showcasePage = computed(() => singlePluginId.value === 'showcase');
const pluginId = computed(() => singlePluginId.value ?? settings.entityId);

const visible = computed(() => list.value.filter((entry) => {
  const needle = filters.query.trim().toLocaleLowerCase('ru');
  const text = [entry.id, entry.name, entry.description, entry.nav?.label]
    .join(' ').toLocaleLowerCase('ru');

  return !entry.system
    && (!needle || text.includes(needle))
    && (filters.state === 'all' || (filters.state === 'enabled') === draftEnabled(entry.id))
    && (!filters.configurable || entry.settings.length > 0 || Boolean(entry.placements?.length));
}));

const hasCustom = computed(() => list.value.some((entry) => !entry.system));
const groups = computed(() => PLUGIN_CATEGORIES.map((category) => ({
  ...localizePluginCategory(category, uiLocale.value),
  plugins: visible.value.filter((entry) => pluginCategoryOf(entry) === category.id),
})).filter((group) => group.plugins.length));
const recoveryBlocked = computed(() => Boolean(installer.recoveryError)
  || installer.job?.status === 'recovery_required');
const installOpen = ref(false);
const actionError = computed(() => !installOpen.value ? installer.error : '');
const installMode = ref<'install' | 'update'>('install');
const confirmingRemoval = ref(false);
const removedName = ref('');
const activeInstall = computed(() => isActiveInstallJob(installer.job)
  || ['ready', 'awaiting_restart'].includes(installer.job?.status ?? ''));
const packageActionsBlocked = computed(() => recoveryBlocked.value || installer.busy
  || installer.reconciling || Boolean(installer.pendingAction) || confirmingRemoval.value
  || settings.snapshot.applying || settings.actionRunning);
const providers = useProvidersStore();
const registry = computed(() => providers.providers as ProviderEntry[]);
const plugin = computed(() => list.value.find((entry) => entry.id === pluginId.value
  && (!singlePluginId.value || entry.system === true)));
const resourceId = computed(() => `pluginSettings:${pluginId.value}`);
const enabledId = computed(() => `pluginEnabled:${pluginId.value}`);
const baselineEnabled = computed(() => {
  settings.snapshot;

  return settings.getBaseline(enabledId.value).enabled === true;
});
const setupPlugin = computed(() => plugin.value ? { ...plugin.value, enabled: baselineEnabled.value } : null);
const enabled = computed(() => {
  settings.snapshot;

  return settings.getValue(enabledId.value, 'enabled') === true;
});
const restartPending = computed(() =>
  (plugins.restartPending as Record<string, boolean>)[pluginId.value ?? '']);
const ready = ref(false);
const error = ref('');
const togglingId = ref('');
const detailTab = ref('parameters');
const detailsId = `plugin-details-${useId()}`;
const filtersOpen = ref(false);
const hasActiveFilters = computed(() => Boolean(filters.query
  || filters.state !== 'all' || filters.configurable));
const sourceNeedsAttention = computed(() => Boolean(plugin.value?.install
  && (plugin.value.install.updateAvailable || plugin.value.install.restartRequired
    || plugin.value.install.localChanges || plugin.value.install.checkError
    || plugin.value.install.rollbackError)));
const unavailable = computed(() => settings.snapshot.resources.find((item) => item.id === resourceId.value)
  ?.fields.filter((field) => field.dirty && field.unavailable
    && !plugin.value?.settings.some((item) => pluginValueKey('values', item.key) === field.key)
    && !plugin.value?.placements?.some((item) =>
      pluginValueKey('placements', item.slot) === field.key)) ?? []);
let editor: ReturnType<typeof createPluginEditor> | null = null;
let loadAttempt = 0;
let disposed = false;

const provenanceKeys: Record<SourceMembership, 'settings.marketplaceOfficial'
  | 'settings.marketplaceCommunity' | 'settings.marketplaceExternal'
  | 'settings.marketplaceUnverifiedSource' | 'settings.marketplaceManual'> = {
  official: 'settings.marketplaceOfficial',
  community: 'settings.marketplaceCommunity',
  external: 'settings.marketplaceExternal',
  unverified: 'settings.marketplaceUnverifiedSource',
  manual: 'settings.marketplaceManual',
};

/**
 * Badge описывает источник установленного пакета, а не один совпавший ID каталога.
 * Ручной пакет без managed metadata никогда не получает происхождение по догадке.
 */
function provenance(entry: PluginListItem): string {
  return t(provenanceKeys[sourceMembership(catalog.index, catalog.state,
    entry.id, entry.install?.source ?? null)]);
}

function selectPlugin(id: string): void {
  settings.selectPage('plugins.installed', id);
}

function draftEnabled(id: string): boolean {
  settings.snapshot;

  return settings.getValue(`pluginEnabled:${id}`, 'enabled') === undefined
    ? list.value.find((entry) => entry.id === id)?.enabled === true
    : settings.getValue(`pluginEnabled:${id}`, 'enabled') === true;
}

/**
 * Сброс возвращает список целиком, не затрагивая выбор и параметры плагина.
 * Значения фильтров хранятся лишь до завершения текущей сессии настроек.
 */
function clearFilters(): void {
  filters.query = '';
  filters.state = 'all';
  filters.configurable = false;
}

function openInstall(mode: 'install' | 'update'): void {
  if (!packageActionsBlocked.value) {
    installMode.value = mode;
    installOpen.value = true;
  }
}

/**
 * Подтверждение привязано к выбранному плагину и открытию настроек до await.
 * Только успешное удаление отбрасывает его черновик, сохраняя остальные изменения сессии.
 */
async function removePlugin(): Promise<void> {
  const selected = plugin.value;
  const opening = settings.snapshot.sessionId;

  if (disposed || !selected || selected.system || packageActionsBlocked.value || activeInstall.value) {
    return;
  }

  confirmingRemoval.value = true;

  let confirmed = false;

  try {
    confirmed = await confirmDialog(
      messageRef('settings.pluginRemoveConfirmation', { pluginName: selected.name }),
      { okText: messageRef('settings.delete'), danger: true },
    );
  } finally {
    confirmingRemoval.value = false;
  }

  if (!confirmed || disposed || !props.active || !settings.isOpen || settings.snapshot.sessionId !== opening
    || plugin.value?.id !== selected.id || packageActionsBlocked.value || activeInstall.value) {
    return;
  }

  const removed = await installer.remove(selected.id);

  if (!removed || disposed || !settings.isOpen || settings.snapshot.sessionId !== opening) {
    return;
  }

  removedName.value = selected.name;
  plugins.list = plugins.list.filter((entry) => entry.id !== selected.id);

  if (!settings.snapshot.applying) {
    for (const resource of settings.snapshot.resources.filter((entry) =>
      entry.id === `pluginSettings:${selected.id}` || entry.id === `pluginEnabled:${selected.id}`)) {
      for (const field of resource.fields) {
        settings.discardField(resource.id, field.key);
      }
    }
  }

  if (settings.entityId === selected.id) {
    settings.selectPage('plugins.installed', list.value.find((entry) => !entry.system)?.id);
  }
}

/**
 * Адрес поля принадлежит странице плагина: одиночная страница знает своего
 * владельца, а список «Установленные» адресуется явным выбором entity.
 */
function address(section: string, key?: string): FieldAddress {
  return pluginFieldAddress(String(pluginId.value), plugin.value?.system === true,
    key === undefined ? [section] : [section, key]);
}

function fieldUnavailable(key: string): boolean {
  return settings.snapshot.resources.find((entry) => entry.id === resourceId.value)?.fields
    .some((field) => field.key === pluginValueKey('values', key) && Boolean(field.unavailable)) === true;
}

function value(section: 'values' | 'placements', key: string): JsonValue | undefined {
  settings.snapshot;

  return settings.getValue(resourceId.value, pluginValueKey(section, key));
}

function set(section: 'values' | 'placements', key: string, next: JsonValue): void {
  settings.setField(resourceId.value, pluginValueKey(section, key), next);
}

function setEnabled(next: boolean): void {
  settings.setField(enabledId.value, 'enabled', next);
}

/**
 * Флажок списка меняет тот же черновик, что переключатель выбранного плагина.
 * Baseline читается до правки; закрытая сессия и recovery отбрасывают поздний результат.
 */
async function toggleEntry(id: string, next: boolean): Promise<void> {
  if (!ready.value || recoveryBlocked.value || togglingId.value) {
    return;
  }

  const opening = settings.snapshot.sessionId;

  togglingId.value = id;

  try {
    const loaded = await settings.loadResource(`pluginEnabled:${id}`);

    if (loaded && settings.isOpen && settings.snapshot.sessionId === opening && !recoveryBlocked.value) {
      settings.setField(`pluginEnabled:${id}`, 'enabled', next);
    }
  } finally {
    togglingId.value = '';
  }
}

/**
 * Настройка подключения открывает существующий раздел с токеном, чатами и пультом.
 * Общая политика перехода сохраняет выбор судьбы неприменённых настроек.
 */
async function openTelegram(): Promise<void> {
  await settings.requestAction(async () => {
    const failure = await router.push('/telegram');

    return !isNavigationFailure(failure)
      || isNavigationFailure(failure, NavigationFailureType.duplicated);
  });
}

/**
 * Создание ролика начинается в рабочем разделе, а настройки остаются подготовкой.
 * Общий переход сохраняет выбор судьбы всех неприменённых полей модала.
 */
async function openShowcase(): Promise<void> {
  await settings.requestAction(async () => {
    const failure = await router.push('/showcase');

    return !isNavigationFailure(failure)
      || isNavigationFailure(failure, NavigationFailureType.duplicated);
  });
}

function textValue(key: string): string {
  return String(value('values', key) ?? '');
}

function numberValue(key: string): number | '' {
  const current = value('values', key);

  return typeof current === 'number' ? current : '';
}

function providerIds(key: string): string[] {
  const current = value('values', key);

  return Array.isArray(current) ? current.filter((id): id is string => typeof id === 'string') : [];
}

function missingProviders(key: string): string[] {
  return providerIds(key).filter((id) => !registry.value.some((entry) => entry.id === id));
}

function setProvider(key: string, id: string, on: boolean): void {
  set('values', key, on ? [...providerIds(key).filter((item) => item !== id), id]
    : providerIds(key).filter((item) => item !== id));
}

function modelValue(key: string): PluginModelValue | null {
  const current = value('values', key);

  return current && typeof current === 'object' && !Array.isArray(current)
    && typeof current.provider === 'string' && typeof current.model === 'string'
    ? current as unknown as PluginModelValue : null;
}

function modelOption(key: string): string {
  const current = modelValue(key);

  return current ? modelId(current.provider, current.model) : '';
}

function selectedModel(key: string) {
  const current = modelValue(key);

  return registry.value.find((entry) => entry.id === current?.provider)?.models
    ?.find((entry) => entry.id === current?.model);
}

function efforts(key: string): string[] {
  return selectedModel(key)?.efforts ?? [];
}

function lostEffort(key: string): string {
  const effort = modelValue(key)?.effort ?? '';

  return effort && !efforts(key).includes(effort) ? effort : '';
}

function modelGroups(field: PluginSetting) {
  return registry.value.filter(isSelectableModelProvider).filter((entry) =>
    !field.requiresCapability || entry.capabilities?.[field.requiresCapability])
    .map((entry) => ({ ...entry, models: (providers.visibleModels as (
      entry: ProviderEntry, selected: string | null,
    ) => NonNullable<ProviderEntry['models']>)(entry, modelValue(field.key)?.model ?? null) }))
    .filter((entry) => entry.models.length);
}

/**
 * Пропавшая или несовместимая модель остаётся явным option сохранённого выбора.
 * Скрытый по доступности выбор сохраняется до явного действия человека.
 */
function lostModel(field: PluginSetting): string {
  const current = modelValue(field.key);

  if (!current) {
    return '';
  }

  const provider = registry.value.find((entry) => entry.id === current.provider);
  const model = selectedModel(field.key);

  if (!model) {
    return t('settings.missingFromRegistry', {
    currentProvider: current.provider,
    currentModel: current.model,
  });
  }

  return field.requiresCapability && !provider?.capabilities?.[field.requiresCapability]
    ? t('settings.notSuitableForThisSetting', { providerName: provider?.name, modelName: model.name }) : '';
}

function modelUnavailable(key: string): boolean {
  const current = modelValue(key);

  return registry.value.some((provider) => provider.id === current?.provider
    && !isSelectableModelProvider(provider));
}

/**
 * Option сопоставляется с исходной парой, без разбора двоеточий внутри model id.
 * Усилие переносится только если новая модель действительно его объявляет.
 */
function setModel(key: string, option: unknown): void {
  const selected = registry.value.flatMap((entry) => (entry.models ?? []).map((model) => ({ entry, model })))
    .find(({ entry, model }) => modelId(entry.id, model.id) === option);
  const effort = modelValue(key)?.effort;

  set('values', key, selected ? {
    provider: selected.entry.id,
    model: selected.model.id,
    ...effort && selected.model.efforts?.includes(effort) ? { effort } : {},
  } : null);
}

/**
 * Пустой выбор удаляет effort, сохраняя целую пару модели.
 * Отсутствующий уровень не подменяется произвольным значением из нового каталога.
 */
function setEffort(key: string, value: unknown): void {
  const current = modelValue(key);

  if (current) {
    const { effort: _drop, ...rest } = current;

    set('values', key, { ...rest, ...(value ? { effort: String(value) } : {}) });
  }
}

function discard(key: string): void {
  settings.discardField(resourceId.value, key);
  editor?.sync();
}

/**
 * Каждая загрузка принадлежит странице и открытию, выбранным до первого await.
 * Устаревший ответ не выбирает страницу и не регистрирует редакторы в новой сессии.
 */
async function load(): Promise<void> {
  const attempt = ++loadAttempt;

  if (!props.active || !settings.isOpen
    || (!singlePluginId.value && settings.pageId !== 'plugins.installed')) {
    return;
  }

  const opening = settings.snapshot.sessionId;
  const pageId = settings.pageId;
  const entityId = settings.entityId;
  const current = () => attempt === loadAttempt && props.active && settings.isOpen
    && settings.snapshot.sessionId === opening && settings.pageId === pageId
    && settings.entityId === entityId;

  ready.value = false;
  error.value = '';

  try {
    if (!plugins.loaded || plugins.loadError) {
      const result = await plugins.load();

      if (!current() || result.outcome !== 'accepted') {
        return;
      }
    }

    if (!current()) {
      return;
    }

    for (const entry of plugins.list as PluginListItem[]) {
      settings.sessionService(`plugin-editor:${entry.id}`, () =>
        createPluginEditor(entry.id, settings, plugins as unknown as PluginStorePort));
    }

    const legacy = plugins.list.find((entry) => entry.id === settings.entityId);
    const legacyTarget = legacy?.system ? pluginSettingsTarget(legacy.id, true) : null;

    if (!singlePluginId.value && legacyTarget && legacyTarget.pageId !== 'plugins.installed') {
      const target = settings.revealTarget;

      if (target?.pageId === 'plugins.installed' && target.entityId === legacy?.id) {
        settings.reveal({
          pageId: legacyTarget.pageId,
          fieldPath: [...target.fieldPath],
        });
      } else {
        settings.selectPage(legacyTarget.pageId);
      }

      return;
    }

    const firstCustom = (plugins.list as PluginListItem[]).find((entry) => !entry.system);

    if (!settings.entityId && !singlePluginId.value && firstCustom && !settings.navigationError) {
      settings.selectPage('plugins.installed', firstCustom.id);

      return;
    }

    const selected = plugin.value;

    if (!selected) {
      ready.value = true;

      return;
    }

    editor = settings.sessionService(`plugin-editor:${selected.id}`, () =>
      createPluginEditor(selected.id, settings, plugins as unknown as PluginStorePort));
    await editor.load();

    if (!current()) {
      return;
    }
    if (!providers.loaded && selected.settings.some((field) =>
      ['model', 'providers'].includes(field.type ?? ''))) {
      await providers.load();
    }
    if (current()) {
      ready.value = true;
    }
  } catch (cause) {
    if (current()) {
      error.value = failureText(cause);
    }
  }
}

onBeforeUnmount(() => {
  loadAttempt += 1;
  disposed = true;
});

onMounted(() => {
  void installer.loadJob();
});

watch(() => plugin.value?.id, () => {
  detailTab.value = sourceNeedsAttention.value ? 'source' : 'parameters';
});

watch(sourceNeedsAttention, (attention) => {
  if (attention) {
    detailTab.value = 'source';
  }
}, { immediate: true });

watch(() => settings.revealTarget, (target) => {
  if (target?.pageId === 'plugins.installed' && target.entityId === pluginId.value) {
    detailTab.value = 'parameters';
  }
}, { immediate: true });

watch([
  () => props.active,
  () => settings.isOpen,
  () => settings.pageId,
  () => settings.entityId,
  () => settings.snapshot.sessionId,
], load, { immediate: true });
</script>

<style scoped>
.settings-plugin {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  container: installed-plugins / inline-size;
}
.settings-plugin-workspace {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(260px, 38%) minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.settings-plugin-notices {
  display: grid;
  flex: none;
  gap: 8px;
  max-height: 40%;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
  overflow: auto;
  overscroll-behavior: contain;
}
.settings-plugin-sidebar {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--line);
}
.settings-plugin-filters {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  min-width: 0;
  min-height: 48px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  color: var(--ink-mid);
}
.settings-plugin-filters > .ui-search-input {
  flex: 1;
  min-width: 0;
}
.settings-plugin-filter-menu {
  display: grid;
  gap: 12px;
  width: min(220px, calc(100vw - 48px));
  padding: 8px;
}
.settings-plugin-catalog {
  display: grid;
  align-content: start;
  gap: 10px;
  min-width: 0;
  min-height: 0;
  padding-block: 8px;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.settings-plugin-list,
.settings-plugin-group {
  display: grid;
  min-width: 0;
}
.settings-plugin-group > h4 {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 12px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 11px;
  font-weight: 400;
  line-height: 18px;
}
.settings-plugin-group > h4 > span {
  color: var(--ink-low);
}
.settings-plugin-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.settings-plugin-name {
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
}
.settings-plugin-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px 8px;
  min-width: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.settings-plugin-badge {
  color: var(--accent);
}
.settings-plugin-icon {
  flex: none;
  width: 28px;
  height: 28px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  color: var(--ink-mid);
}
.settings-plugin-actions {
  display: grid;
  flex: none;
  margin-top: auto;
  padding: 8px 12px;
  border-top: 1px solid var(--line);
}
.settings-plugin-picker {
  display: none;
}
.settings-plugin-editor {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.settings-plugin p,
.settings-plugin h4 {
  margin: 0;
}
.settings-plugin-title {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px 12px;
  padding: 22px 24px 16px;
}
.settings-plugin-heading {
  display: grid;
  flex: 1;
  gap: 4px;
  min-width: 0;
}
.settings-plugin-title h4 {
  font-size: 20px;
  font-weight: 600;
  line-height: 27px;
  overflow-wrap: anywhere;
}
.settings-plugin-title > p {
  flex-basis: 100%;
}
.settings-plugin-header-actions {
  display: flex;
  flex-basis: 100%;
  align-items: start;
  gap: 8px 14px;
  min-width: 0;
}
.settings-plugin-header-actions > .settings-plugin-meta {
  align-self: start;
  min-height: var(--control-height);
}
.settings-plugin-package-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
  margin-inline-start: auto;
}
.settings-plugin-detail-tabs {
  flex: none;
  padding-inline: 24px;
}
.settings-plugin-runtime-error {
  flex: none;
  margin: 0 24px 12px;
}
.settings-plugin-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: 18px 24px;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.settings-plugin-description,
.settings-plugin-title > p {
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
.settings-plugin-content > .settings-plugin-description {
  margin-bottom: 18px;
}
.settings-plugin-content > h4 {
  padding: 14px 0 6px;
  font-size: 13px;
  font-weight: 600;
}
.settings-plugin-content > p:not(.settings-plugin-description) {
  padding-block: 8px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 18px;
}
.settings-plugin-empty {
  display: grid;
  align-content: start;
  gap: 10px;
  padding: 24px;
}
.settings-plugin-empty h4 {
  font-size: 14px;
  font-weight: 500;
}
.settings-plugin-empty p,
.settings-plugin-sidebar > p {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 18px;
}
.settings-plugin-sidebar > p {
  padding: 16px 12px;
}
.settings-plugin[data-single='true'] .settings-plugin-workspace {
  grid-template-columns: minmax(0, 1fr);
  overflow: visible;
}
.settings-plugin[data-single='true'] .settings-plugin-editor {
  display: grid;
  align-content: start;
  overflow: visible;
}
.settings-plugin[data-single='true'] .settings-plugin-title {
  padding: 0 0 16px;
}
.settings-plugin[data-single='true'] .settings-plugin-title h4 {
  font-size: 18px;
}
.settings-plugin[data-single='true'] .settings-plugin-content {
  padding: 0;
  overflow: visible;
}
@container installed-plugins (max-width: 680px) {
  .settings-plugin-workspace {
    display: flex;
    flex-direction: column;
    overflow: auto;
  }
  .settings-plugin-sidebar {
    flex: none;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .settings-plugin-catalog {
    display: none;
  }
  .settings-plugin-picker {
    display: block;
    padding: 0 12px 10px;
  }
  .settings-plugin-editor {
    flex: none;
    overflow: visible;
  }
  .settings-plugin-title {
    padding: 18px 16px 12px;
  }
  .settings-plugin-detail-tabs {
    padding-inline: 16px;
  }
  .settings-plugin-content {
    padding: 16px;
    overflow: visible;
  }
}
</style>
