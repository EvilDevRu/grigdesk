<template>
  <div
    class="settings-plugin"
    :data-plugin-page="plugin?.id"
    :data-ready="ready"
  >
    <p v-if="error" role="alert">{{ error }}</p>
    <div class="settings-plugin-filters">
      <UiInput
        v-model="filters.query"
        data-plugin-filter
        type="search"
        :aria-label="t('settings.searchPlugins')"
        :placeholder="t('settings.findAPlugin')"
      />
      <UiSelect v-model="filters.state" :aria-label="t('settings.pluginStatus')">
        <option value="all">{{ t('settings.all') }}</option>
        <option value="enabled">{{ t('settings.enabled') }}</option>
        <option value="disabled">{{ t('settings.disabled3') }}</option>
      </UiSelect>
      <div class="settings-plugin-filter-options">
        <UiCheckbox v-model="filters.configurable">{{ t('settings.withSettings') }}</UiCheckbox>
        <UiCheckbox v-model="filters.custom">{{ t('settings.customOnly') }}</UiCheckbox>
        <UiButton v-if="filters.query || filters.state !== 'all' || filters.configurable || filters.custom"
                  variant="text" data-context="workspace-form-wrap" @click="clearFilters">
          {{ t('settings.resetFilters') }}
        </UiButton>
      </div>
    </div>
    <div class="settings-plugin-workspace">
      <aside class="settings-plugin-sidebar" :aria-label="t('settings.pluginSelection')">
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
            <h4>{{ group.label }}</h4>
            <div class="settings-plugin-list">
              <div v-for="entry in group.plugins" :key="entry.id" class="settings-plugin-entry">
                <UiButton
                  :data-select-plugin="entry.id"
                  :pressed="plugin?.id === entry.id"
                  data-ui-settings-catalog data-context="plugin-entry"
                  @click="selectPlugin(entry.id)"
                >
                  <span class="ui-settings-catalog-copy">
                    <span class="ui-settings-catalog-title">{{ entry.name }}</span>
                    <small v-if="!entry.system">{{ provenance(entry) }}</small>
                    <span class="ui-settings-catalog-status" :data-available="draftEnabled(entry.id)">
                      {{ draftEnabled(entry.id) ? t('settings.enabled2') : t('settings.disabled') }}
                      <span v-if="pluginInstallBadge(entry)">
                        · {{ pluginInstallBadge(entry) === 'restart' ? t('settings.waitingForRestart') : t('settings.update2') }}
                      </span>
                    </span>
                  </span>
                </UiButton>
              </div>
            </div>
          </section>
        </div>
        <p v-if="!groups.length">{{ t('settings.noPluginsFoundChangeTheQueryOr') }}</p>
        <p v-if="installer.recoveryError" role="alert">{{ installer.recoveryError.message }}</p>
        <p v-else-if="installer.job?.status === 'recovery_required'" role="alert">
          {{ installer.job.error?.message }}
        </p>
        <div class="settings-plugin-actions">
          <UiButton
            v-if="list.some((entry) => entry.install)"
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
          <header class="settings-plugin-title">
            <SettingsIcon name="plugins" />
            <h4>{{ plugin.name }}</h4>
            <span>{{ plugin.version }}</span>
            <p>{{ plugin.description }}</p>
            <p v-if="!plugin.system" :data-installed-source="plugin.id">{{ provenance(plugin) }}</p>
          </header>
          <PluginSourcePanel
            v-if="!plugin.system"
            :key="plugin.id"
            :plugin="plugin"
            @update="openInstall('update')"
            @bind="openInstall('install')"
          />
          <PluginSetupPanel
            v-if="baselineEnabled && plugin.setup && setupPlugin"
            :key="plugin.id"
            :plugin="setupPlugin"
            :active="active"
          />
          <UiInlineMessage v-if="plugin.serverError" tone="danger">{{ plugin.serverError }}</UiInlineMessage>
          <SettingsScope>{{ t('settings.valuesAndPlacementsAreSavedWithApply') }}</SettingsScope>
          <SettingsField :address="address('enabled')">
            <UiSwitch
              :model-value="enabled"
              :disabled="recoveryBlocked"
              :aria-label="t('settings.enable2', { pluginName: plugin.name })"
              @update:model-value="setEnabled"
            />
          </SettingsField>
          <p v-if="restartPending">{{ t('settings.waitingForRestart') }}</p>
          <p v-else-if="plugin.needsRestart">{{ t('settings.changingServerComponentStatusWillRequireA') }}</p>
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
          <h4 v-if="plugin.settings.length">{{ t('settings.parameters') }}</h4>
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
              <UiSelect
                :disabled="fieldUnavailable(field.key)"
                :model-value="modelOption(field.key)"
                :aria-label="field.label"
                @update:model-value="setModel(field.key, $event)"
              >
                <option value="">{{ t('settings.notSelected') }}</option>
                <option
                  v-if="lostModel(field)"
                  :value="modelOption(field.key)"
                  disabled
                >
                  {{ lostModel(field) }}
                </option>
                <optgroup
                  v-for="group in modelGroups(field)"
                  :key="group.id"
                  :label="group.name + (group.available ? '' : t('settings.unavailable'))"
                >
                  <option
                    v-for="entry in group.models"
                    :key="entry.id"
                    :value="modelId(group.id, entry.id)"
                  >
                    {{ entry.name }}
                  </option>
                </optgroup>
              </UiSelect>
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
        </template>
        <p v-else-if="!plugin && settings.entityId">{{ t('settings.thePluginIsNoLongerAvailable') }}</p>
        <div v-else-if="!plugin" class="settings-plugin-empty">
          <h4>{{ list.length ? t('settings.selectAPlugin') : t('settings.noPluginsInstalled') }}</h4>
          <p>
            {{ list.length ? t('settings.selectAPluginFromTheListTo')
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
import { t, uiLocale } from '../../../ui.ts';

import { localizePluginMetadata, localizePluginCategory } from '../../../features/settings/metadataLocale.ts';

import SettingsScope from '../SettingsScope.vue';
import SettingsIcon from '../SettingsIcon.vue';
import { computed, reactive, ref, watch, onMounted } from 'vue';
import {
  UiSwitch, UiCheckbox, UiInput, UiNumberInput, UiSelect, UiPasswordInput, UiButton, UiInlineMessage,
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
import { pluginInstallBadge } from '../../../shared/pluginInstall.ts';
import { PLUGIN_CATEGORIES } from '../../../../../shared/plugins/pluginsContracts.ts';
import PluginSourcePanel from '../PluginSourcePanel.vue';
import PluginInstallDialog from '../PluginInstallDialog.vue';
import PluginSetupPanel from './PluginSetupPanel.vue';
import { useProvidersStore } from '../../../stores/providers.ts';
import { createPluginEditor } from '../../../features/settings/pluginEditor.ts';
import { pluginValueKey, type PluginStorePort } from '../../../features/settings/resources/plugins.ts';
import type { FieldAddress, JsonValue } from '../../../features/settings/contracts.ts';
import { failureText } from '../../../shared/apiClient.ts';
import SettingsField from '../SettingsField.vue';

const props = defineProps<{ active: boolean }>();
const settings = useSettingsStore();
const plugins = usePluginsStore();
const installer = usePluginInstallStore();
const catalog = usePluginCatalogStore();
const filters = settings.sessionService('plugin-filters', () => reactive({
  query: '',
  state: 'all',
  configurable: false,
  custom: false,
}));
const list = computed(() => (plugins.list as PluginListItem[])
  .map((entry) => localizePluginMetadata(entry, uiLocale.value)));
const visible = computed(() => list.value.filter((entry) => {
  const needle = filters.query.trim().toLocaleLowerCase('ru');
  const text = [entry.id, entry.name, entry.description, entry.nav?.label,
    entry.system ? t('settings.system') : t('settings.custom')].join(' ').toLocaleLowerCase('ru');

  return (!needle || text.includes(needle))
    && (filters.state === 'all' || (filters.state === 'enabled') === draftEnabled(entry.id))
    && (!filters.custom || !entry.system)
    && (!filters.configurable || entry.settings.length > 0 || Boolean(entry.placements?.length));
}));
const groups = computed(() => PLUGIN_CATEGORIES.map((category) => ({
  ...localizePluginCategory(category, uiLocale.value),
  plugins: visible.value.filter((entry) => pluginCategoryOf(entry) === category.id),
})).filter((group) => group.plugins.length));
const recoveryBlocked = computed(() => Boolean(installer.recoveryError)
  || installer.job?.status === 'recovery_required');
const installOpen = ref(false);
const installMode = ref<'install' | 'update'>('install');
const providers = useProvidersStore();
const registry = computed(() => providers.providers as ProviderEntry[]);
const plugin = computed(() => list.value
  .find((entry) => entry.id === settings.entityId));
const resourceId = computed(() => `pluginSettings:${settings.entityId}`);
const enabledId = computed(() => `pluginEnabled:${settings.entityId}`);
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
  (plugins.restartPending as Record<string, boolean>)[settings.entityId ?? '']);
const ready = ref(false);
const error = ref('');
const unavailable = computed(() => settings.snapshot.resources.find((item) => item.id === resourceId.value)
  ?.fields.filter((field) => field.dirty && field.unavailable
    && !plugin.value?.settings.some((item) => pluginValueKey('values', item.key) === field.key)
    && !plugin.value?.placements?.some((item) =>
      pluginValueKey('placements', item.slot) === field.key)) ?? []);
let editor: ReturnType<typeof createPluginEditor> | null = null;

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
  filters.custom = false;
}

function openInstall(mode: 'install' | 'update'): void {
  if (!recoveryBlocked.value) {
    installMode.value = mode;
    installOpen.value = true;
  }
}

/**
 * Адреса настроек и размещений не пересекаются при одинаковых непрозрачных ключах.
 * Значения формы читаются из сессии, без второго локального draft record.
 */
function address(section: string, key?: string): FieldAddress {
  return {
    pageId: 'plugins.installed',
    entityId: settings.entityId,
    fieldPath: key === undefined ? [section] : [section, key],
  };
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

function modelId(provider: string, model: string): string {
  return JSON.stringify({ provider, model });
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
  return registry.value.filter((entry) =>
    !field.requiresCapability || entry.capabilities?.[field.requiresCapability])
    .map((entry) => ({ ...entry, models: (providers.visibleModels as (
      entry: ProviderEntry, selected: string | null,
    ) => NonNullable<ProviderEntry['models']>)(entry, modelValue(field.key)?.model ?? null) }))
    .filter((entry) => entry.models.length);
}

/**
 * Пропавшая или несовместимая модель остаётся явным option сохранённого выбора.
 * Временная недоступность исполнителя сама по себе не запрещает выбор модели.
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
 * Ресурсы всех объявленных плагинов регистрируются без чтений отдельных API.
 * Посещение выбранного плагина загружает baseline один раз для текущего открытия.
 */
async function load(): Promise<void> {
  if (!props.active || !settings.isOpen || settings.pageId !== 'plugins.installed') {
    return;
  }

  ready.value = false;

  try {
    if (!plugins.loaded) {
      await plugins.load();
    }

    for (const entry of plugins.list as PluginListItem[]) {
      settings.sessionService(`plugin-editor:${entry.id}`, () =>
        createPluginEditor(entry.id, settings, plugins as unknown as PluginStorePort));
    }

    if (!settings.entityId && plugins.list[0] && !settings.navigationError) {
      settings.selectPage('plugins.installed', (plugins.list[0] as PluginListItem).id);

      return;
    }
    if (plugin.value) {
      const id = plugin.value.id;
      const opening = settings.snapshot.sessionId;

      editor = settings.sessionService(`plugin-editor:${plugin.value.id}`, () =>
        createPluginEditor(plugin.value!.id, settings, plugins as unknown as PluginStorePort));
      await editor.load();

      if (!providers.loaded && plugin.value.settings.some((field) =>
        ['model', 'providers'].includes(field.type ?? ''))) {
        await providers.load();
      }

      if (settings.isOpen && settings.entityId === id && settings.snapshot.sessionId === opening) {
        ready.value = true;
      }
    }
  } catch (cause) {
    error.value = failureText(cause);
  }
}

onMounted(() => {
  void installer.loadJob();
});

watch([() => props.active, () => settings.pageId, () => settings.entityId, () => settings.snapshot.sessionId],
  load, { immediate: true });
</script>

<style scoped>
.settings-plugin {
  display: grid;
  gap: 12px;
  min-width: 0;
  align-content: start;
  container: installed-plugins / inline-size;
}
.settings-plugin-filters {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 180px;
  align-items: center;
  gap: 8px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.settings-plugin-filter-options {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  min-width: 0;
}
.settings-plugin-workspace {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 16px;
  min-width: 0;
}
.settings-plugin-sidebar {
  display: grid;
  align-content: start;
  gap: 12px;
  min-width: 0;
  padding-right: 16px;
  border-right: 1px solid var(--line);
}
.settings-plugin-catalog {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.settings-plugin-list {
  display: grid;
  gap: 8px;
  width: 100%;
  min-width: 0;
}
.settings-plugin-entry {
  display: grid;
  min-width: 0;
}
.settings-plugin-actions {
  display: grid;
  gap: 8px;
}
.settings-plugin-picker {
  display: none;
}
.settings-plugin-editor {
  display: grid;
  align-content: start;
  gap: 0;
  min-width: 0;
}
.settings-plugin-editor > h4 {
  padding: 16px 0 8px;
  border-bottom: 1px solid var(--line-2);
  font-size: 13px;
  font-weight: 600;
}
.settings-plugin p, .settings-plugin h4 {
  margin: 0;
}
.settings-plugin-editor > p {
  padding: 10px 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}
.settings-plugin-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.settings-plugin-title h4 {
  font-size: 14px;
  font-weight: 600;
}
.settings-plugin-title > span {
  color: var(--ink-low);
  font-size: 12px;
}
.settings-plugin-title p {
  flex-basis: 100%;
  max-width: 70ch;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}
.settings-plugin-empty {
  display: grid;
  align-content: start;
  gap: 10px;
  padding-block: 16px;
}
.settings-plugin-empty h4 {
  font-size: 14px;
  font-weight: 500;
}
.settings-plugin-empty p {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}
@container installed-plugins (max-width: 680px) {
  .settings-plugin-workspace {
    grid-template-columns: minmax(0, 1fr);
  }
  .settings-plugin-sidebar {
    padding: 0 0 16px;
    border-right: 0;
    border-bottom: 1px solid var(--line);
    gap: 10px;
  }
  .settings-plugin-catalog {
    display: none;
  }
  .settings-plugin-picker {
    display: block;
  }
  .settings-plugin-actions {
    display: flex;
    flex-wrap: wrap;
  }
}
.settings-plugin-group {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.settings-plugin-group > h4 {
  color: var(--ink-mid);
  font-size: 12px;
  font-weight: 600;
}
@container installed-plugins (max-width: 400px) {
  .settings-plugin-filters {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
